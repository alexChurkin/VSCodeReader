import * as vscode from 'vscode';
import { type Book, type ReadingState, type BookImage, type Bookmark, type Locator, safeText } from './book';
import { parseLocation, readingProgress, progressLabel, pageProgress } from './progress';
import { footerText, type HintMode } from './footer';
import { Screen, type ReadingLayout } from './screen';
import { NavigationHistory } from './navigation';
import type { CopyViewOpener } from './copy-view';
import { cleanPassage } from './copy';
import { mouseInput, MOUSE_ON, MOUSE_OFF } from './mouse';
import { BookSearch } from './search';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
export class ReaderTerminal implements vscode.Pseudoterminal {
  private readonly exits = new vscode.EventEmitter<void | number>();
  readonly onDidClose = this.exits.event;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly writes = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writes.event;
  readonly screen: Screen;
  readonly search: BookSearch;
  private readonly history = new NavigationHistory();
  private linkRevision = 0;
  private selecting = false;
  private mouseEnabled = false;
  private wheelLines = 3;
  private hidden = false;
  private closed = false;
  private opened = false;
  private exitSent = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = '';
  private escapeWasHidden = true;
  private viewport = { columns: 80, rows: 24 };
  private mode: HintMode = 'reading';
  private feedback: string | undefined;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(book: Book, prefix: string, private state: ReadingState, private persist: (state: ReadingState) => void, private imagePreview?: (image: BookImage) => Promise<void>, private copyView?: CopyViewOpener) {
    this.screen = new Screen(book, prefix, state);
    this.search = new BookSearch(book, state.searchQuery);
    this.search.align(state);
  }
  open(dimensions?: vscode.TerminalDimensions): void {
    this.opened = true;
    if (this.closed) { this.finishExit(); return; }
    this.resizeScreen(dimensions ?? this.viewport);
    // Alternate buffer avoids retaining previous book screens in scrollback.
    this.writes.fire('\x1b[?1049h\x1b[?25l' + CLEAR);
    this.draw();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.save();
    if (this.opened) {
      this.writes.fire(MOUSE_OFF + '\x1b[0m\x1b[?25h' + CLEAR + '\x1b[?1049l');
      this.finishExit();
    }
    this.writes.dispose();
    this.changes.dispose();
  }
  private finishExit(): void {
    if (this.exitSent) return;
    this.exitSent = true;
    this.exits.fire(0);
    this.exits.dispose();
  }
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.closed) return;
    this.selecting = false;
    this.resizeScreen(dimensions);
    this.draw();
    this.save();
  }
  hide(): void {
    if (this.closed) return;
    this.selecting = false;
    this.hidden = true;
    this.pending = '';
    this.save();
    this.draw();
  }
  resume(): void { if (this.closed) return; this.selecting = false; this.pending = ''; this.hidden = false; this.draw(); this.changes.fire(); }
  private syncMouse(): void {
    const enabled = this.opened && !this.hidden && !this.busy && !this.selecting && !this.closed;
    if (enabled !== this.mouseEnabled) { this.mouseEnabled = enabled; this.writes.fire(enabled ? MOUSE_ON : MOUSE_OFF); }
  }
  private draw(force = false): void {
    if (this.closed) return;
    this.syncMouse();
    if (this.selecting && !force) return;
    this.linkRevision++;
    let frame = this.hidden ? CLEAR + 'ready' : this.screen.render(this.search.highlights(this.screen.chapter));
    if (this.hasFooter) {
      const end = this.screen.chapter === this.screen.book.chapters.length - 1 && this.screen.row + this.screen.rows >= this.screen.lines.length;
      const hint = footerText({ mode: this.hidden ? 'hidden' : this.selecting ? 'selection' : this.mode, columns: this.viewport.columns, images: !!this.screen.book.images?.length, bookmarks: !!this.state.bookmarks.length, end, search: this.search.status, history: this.history.canGoBack || this.history.canGoForward, footnotes: !!this.screen.book.chapters[this.screen.chapter].footnotes?.length, message: this.feedback, progress: pageProgress(this.screen.book, readingProgress(this.screen.book, this.screen.locator, this.screen.row, this.screen.rows, this.screen.lines.length)) });
      frame += `\x1b[${this.viewport.rows};1H\x1b[2K\x1b[2m${hint}\x1b[0m`;
    }
    this.writes.fire(frame);
  }
  imageLinks(line: string) {
    if (this.closed || this.hidden || this.busy || this.selecting || !this.imagePreview) return [];
    return this.screen.imageLinks(line).map(link => ({ ...link, revision: this.linkRevision }));
  }
  async openImageLink(imageId: string, revision: number): Promise<void> {
    if (this.closed || this.hidden || this.busy || this.selecting || revision !== this.linkRevision) return;
    await this.showImages(imageId);
  }
  footnoteLinks(line: string) {
    if (this.closed || this.hidden || this.busy || this.selecting) return [];
    return this.screen.footnoteLinks(line).map(link => ({ ...link, revision: this.linkRevision }));
  }
  openFootnoteLink(id: string, revision: number): void {
    if (this.closed || this.hidden || this.busy || this.selecting || revision !== this.linkRevision) return;
    this.followFootnote(id);
  }
  followFootnote(id: string): void {
    if (this.closed || this.hidden || this.busy || this.selecting) return;
    const note = this.screen.book.chapters[this.screen.chapter].footnotes?.find(note => note.id === id);
    if (note) { this.goTo(note.target); this.notice('Footnote | u back to reading | U forward'); }
  }
  async showFootnotes(): Promise<void> {
    if (this.closed || this.hidden || this.busy || this.selecting) return;
    const notes = this.screen.book.chapters[this.screen.chapter].footnotes ?? [];
    const first = this.screen.lines[this.screen.row]?.offset ?? 0;
    const last = this.screen.lines[this.screen.row + this.screen.rows]?.offset ?? Infinity;
    const visible = notes.filter(note => note.offset >= first && note.offset < last);
    const choices = visible.length ? visible : notes;
    if (!choices.length) { this.notice('No internal references in this chapter'); return; }
    if (choices.length === 1) { this.followFootnote(choices[0].id); return; }
    this.beginInteraction('picker');
    try {
      const chosen = await vscode.window.showQuickPick(choices.map(note => ({ label: note.label, description: this.screen.book.chapters[note.target.chapter].title, target: note.target })), { title: 'Footnotes / internal references' });
      if (chosen && !this.closed && !this.hidden) { this.goTo(chosen.target); this.notice('Footnote | u back to reading | U forward'); }
    } finally { this.endInteraction(); }
  }
  configureLayout(layout: Partial<ReadingLayout>): void {
    if (this.closed) return;
    this.screen.setLayout(layout); this.draw(); this.changes.fire();
  }
  travel(direction: number): void {
    if (this.closed || this.busy) return;
    const target = this.history.travel(this.screen.locator, direction);
    if (!target) { this.notice(direction < 0 ? 'No earlier jump' : 'No later jump'); return; }
    this.hidden = false; this.pending = ''; this.screen.go(target); this.search.align(this.screen.locator); this.changed(); this.save();
  }
  startSearch(query: string): void {
    if (this.closed) return;
    this.search.setQuery(query);
    this.state.searchQuery = this.search.query; this.save();
    if (!this.search.query) { this.draw(); return; }
    this.nextMatch(1);
  }
  nextMatch(direction: number): void {
    if (this.closed || this.hidden) return;
    const match = this.search.next(this.screen.locator, direction);
    if (match) this.goTo(match);
    else this.notice(this.search.query ? 'No matches | / change query | c clear' : 'Press / to search');
  }
  clearSearch(): void { if (!this.closed) { this.search.setQuery(''); this.state.searchQuery = ''; this.save(); this.draw(); } }
  async promptSearch(): Promise<void> { if (!this.closed && !this.busy) { this.resume(); await this.prompt('search'); } }
  configureMouse(lines: number): void { this.wheelLines = Number.isFinite(lines) ? Math.max(1, Math.min(20, Math.floor(lines))) : 3; }
  toggleSelection(): void {
    if (this.closed || this.hidden || this.busy) return;
    this.selecting = !this.selecting; this.pending = ''; this.draw(true);
  }
  async copyVisibleText(): Promise<void> {
    if (this.closed || this.hidden || this.busy) return;
    const chapter = this.screen.book.chapters[this.screen.chapter];
    const start = this.screen.lines[this.screen.row]?.offset ?? 0;
    const end = this.screen.lines[this.screen.row + this.screen.rows]?.offset ?? chapter.text.length;
    const text = this.screen.book.imagePages ? '' : cleanPassage(chapter, start, end);
    if (!text.trim() || text === '[empty chapter]') { this.notice('No book text on this screen'); return; }
    await vscode.env.clipboard.writeText(text);
    if (!this.closed) { this.notice('Text copied | Y clean copy view'); vscode.window.setStatusBarMessage('Book text copied', 2500); }
  }
  async openCopyView(): Promise<void> {
    if (this.closed || this.hidden || this.busy) return;
    const chapter = this.screen.book.chapters[this.screen.chapter];
    const content = this.screen.book.imagePages ? '' : cleanPassage(chapter);
    if (!content.trim() || content === '[empty chapter]') { this.notice('No text in this chapter'); return; }
    if (!this.copyView) { this.notice('Copy view is unavailable'); return; }
    try {
      await this.copyView(content, `${this.screen.book.title} — ${chapter.title}`, cleanPassage(chapter, 0, this.screen.locator.offset).length, () => !this.closed && !this.hidden);
    } catch (error) {
      if (!this.closed) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    }
  }
  get isClosed(): boolean { return this.closed; }
  private get hasFooter(): boolean { return this.viewport.rows >= 2 && this.viewport.columns >= 2; }
  private resizeScreen(dimensions: vscode.TerminalDimensions): void {
    this.viewport = { columns: Math.max(1, dimensions.columns), rows: Math.max(1, dimensions.rows) };
    this.screen.resize(this.viewport.columns, Math.max(1, this.viewport.rows - (this.hasFooter ? 1 : 0)));
  }
  private beginInteraction(mode: HintMode): void { this.busy = true; this.mode = mode; this.draw(); }
  private endInteraction(): void { this.busy = false; this.mode = 'reading'; this.draw(); }
  private notice(message: string): void {
    this.feedback = message;
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => { this.feedback = undefined; this.feedbackTimer = undefined; this.draw(); }, 2500);
    this.draw();
  }
  private save(): void {
    this.state = { ...this.state, ...this.screen.locator };
    this.persist(structuredClone(this.state));
    this.changes.fire();
  }
  private changed(): void {
    this.draw();
    this.changes.fire();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, 200);
  }
  handleInput(data: string): void {
    if (this.closed) return;
    // Input can arrive split across calls. Never echo arbitrary input or paste.
    const hadPending = !!this.pending;
    const sequence = this.pending + data;
    this.pending = '';
    const mouse = mouseInput(sequence);
    if (mouse) {
      const restore = hadPending && !this.escapeWasHidden && this.hidden;
      if (restore) this.hidden = false;
      this.pending = mouse.pending;
      if (!this.hidden && !this.busy && !this.selecting && mouse.wheel) { this.screen.scroll(Math.max(-200, Math.min(200, mouse.wheel * this.wheelLines))); this.changed(); }
      else if (restore) this.draw();
      if (mouse.remainder) this.handleInput(mouse.remainder);
      return;
    }
    if (sequence === '\x1b') {
      this.escapeWasHidden = this.hidden;
      this.hide();
      this.pending = '\x1b';
      return;
    }
    if (/^\x1b(?:\[|O)[0-9;]*$/.test(sequence)) {
      if (!hadPending) this.escapeWasHidden = this.hidden;
      this.pending = sequence; return;
    }
    const keys = new Map([['\x1b[A', -1], ['\x1b[B', 1], ['\x1bOA', -1], ['\x1bOB', 1], ['\x1b[5~', -this.screen.rows], ['\x1b[6~', this.screen.rows]]);
    if (keys.has(sequence)) {
      if (hadPending && !this.escapeWasHidden) this.hidden = false;
      if (this.hidden || this.busy || this.selecting) return;
      const movement = keys.get(sequence)!;
      if (sequence.endsWith('~')) this.screen.page(Math.sign(movement)); else this.screen.move(movement);
      this.changed(); return;
    }
    // A preceding Escape hides immediately, but should not swallow the next command.
    if (this.hidden) {
      if (data === 'r') this.resume();
      else if (data === 'q') this.close();
      else if (data === '?' && !this.busy) void this.prompt('help');
      return;
    }
    if (data === 'q') { this.close(); return; }
    if (data === 'v') { this.toggleSelection(); return; }
    if (data === 'y') { void this.copyVisibleText(); return; }
    if (data === 'Y') { void this.openCopyView(); return; }
    if (this.selecting) return;
    if (this.busy) return;
    if (data === 'j' || data === '\r') this.screen.move(1);
    else if (data === 'k') this.screen.move(-1);
    else if (data === ' ' || data === '\x06') this.screen.page(1);
    else if (data === '\x02') this.screen.page(-1);
    else if (data === 'n') { if (this.screen.chapter + 1 < this.screen.book.chapters.length) this.goTo({ chapter: this.screen.chapter + 1, offset: 0 }); return; }
    else if (data === 'p') { if (this.screen.chapter > 0) this.goTo({ chapter: this.screen.chapter - 1, offset: 0 }); return; }
    else if (data === 'u' || data === 'U') { this.travel(data === 'u' ? -1 : 1); return; }
    else if (data === '[' || data === ']') { this.nextMatch(data === ']' ? 1 : -1); return; }
    else if (data === 'c') { this.clearSearch(); return; }
    else if (data === 'f') { void this.showFootnotes(); return; }
    else if (data === 'g') { void this.prompt('toc'); return; }
    else if (data === '/') { void this.prompt('search'); return; }
    else if (data === 'i') { void this.showImages(); return; }
    else if (data === 'B') { void this.prompt('bookmarks'); return; }
    else if (data === 'b') { this.addBookmark(); return; }
    else if (data === 's') { this.showProgress(); return; }
    else if (data === 'l') { void this.promptLocation(); return; }
    else if (data === '?') { void this.prompt('help'); return; }
    else { this.notice('Unknown key: press ? for help'); return; }
    this.changed();
  }
  get snapshot() {
    return { book: this.screen.book, position: this.screen.locator, bookmarks: structuredClone(this.state.bookmarks), hidden: this.hidden, canGoBack: this.history.canGoBack, canGoForward: this.history.canGoForward, search: this.search.status,
      progress: readingProgress(this.screen.book, this.screen.locator, this.screen.row, this.screen.rows, this.screen.lines.length) };
  }
  showProgress() {
    const snapshot = this.snapshot;
    vscode.window.setStatusBarMessage(progressLabel(snapshot.progress, snapshot.book), 7000);
    return { position: snapshot.position, progress: snapshot.progress, bookmarks: snapshot.bookmarks, canGoBack: snapshot.canGoBack, canGoForward: snapshot.canGoForward, search: snapshot.search };
  }
  goTo(locator: Locator): void {
    if (this.closed || !Number.isSafeInteger(locator.chapter) || !Number.isSafeInteger(locator.offset)) return;
    this.hidden = false; this.pending = '';
    const from = this.screen.locator;
    this.screen.go(locator); this.history.record(from, this.screen.locator); this.search.align(this.screen.locator); this.changed(); this.save();
  }
  goToLocation(input: string): void { this.goTo(parseLocation(this.screen.book, input)); }
  page(direction: number): void { if (!this.closed) { this.resume(); this.screen.page(direction); this.changed(); } }
  private defaultBookmarkLabel(): string {
    const { chapter, offset } = this.screen.locator;
    return this.screen.book.chapters[chapter].text.slice(offset, offset + 100).replace(/\s+/g, ' ').trim() || this.screen.book.chapters[chapter].title;
  }
  addBookmark(label?: string): Bookmark | undefined {
    if (this.closed) return;
    const position = this.screen.locator;
    let bookmark = this.state.bookmarks.find(b => b.chapter === position.chapter && b.offset === position.offset);
    if (!bookmark) {
      if (this.state.bookmarks.length >= 500) { this.notice('Bookmark limit reached: delete a bookmark first'); return; }
      bookmark = { ...position, label: this.defaultBookmarkLabel() };
      this.state.bookmarks.push(bookmark);
    }
    if (label !== undefined) bookmark.label = safeText(label).replace(/\s+/g, ' ').trim().slice(0, 120) || this.defaultBookmarkLabel();
    this.save();
    this.notice('Bookmark saved');
    vscode.window.setStatusBarMessage('Bookmark saved', 2500);
    return { ...bookmark };
  }
  renameBookmark(position: Locator, label: string): void {
    const bookmark = this.state.bookmarks.find(b => b.chapter === position.chapter && b.offset === position.offset);
    if (!bookmark || this.closed) return;
    bookmark.label = safeText(label).replace(/\s+/g, ' ').trim().slice(0, 120) || bookmark.label;
    this.save(); this.notice('Bookmark renamed');
  }
  deleteBookmark(position: Locator): void {
    if (this.closed) return;
    this.state.bookmarks = this.state.bookmarks.filter(b => b.chapter !== position.chapter || b.offset !== position.offset);
    this.save(); this.notice('Bookmark deleted');
  }
  async promptAddBookmark(): Promise<void> {
    if (this.closed || this.busy) return;
    this.beginInteraction('name');
    try {
      const label = await vscode.window.showInputBox({ title: 'Add bookmark', value: this.defaultBookmarkLabel(), validateInput: value => value.trim() ? undefined : 'Enter a bookmark name.' });
      if (label !== undefined && !this.closed) this.addBookmark(label);
    } finally { this.endInteraction(); }
  }
  async editBookmark(action: 'rename' | 'delete', position?: Locator, label?: string): Promise<void> {
    if (this.closed || this.busy) return;
    this.beginInteraction('picker');
    try {
      const selected = position ? this.state.bookmarks.find(b => b.chapter === position.chapter && b.offset === position.offset) : await vscode.window.showQuickPick(this.state.bookmarks.map(b => ({ ...b, description: `Chapter ${b.chapter + 1}` })), { title: action === 'rename' ? 'Rename bookmark' : 'Delete bookmark' });
      if (!selected || this.closed) return;
      if (action === 'delete') this.deleteBookmark(selected);
      else {
        this.mode = 'name'; this.draw();
        const name = label ?? await vscode.window.showInputBox({ title: 'Rename bookmark', value: selected.label, validateInput: value => value.trim() ? undefined : 'Enter a bookmark name.' });
        if (name !== undefined && !this.closed) this.renameBookmark(selected, name);
      }
    } finally { this.endInteraction(); }
  }
  async showBookmarks(): Promise<void> { if (!this.closed && !this.busy) { this.resume(); await this.prompt('bookmarks'); } }
  async promptLocation(): Promise<void> {
    if (this.closed || this.busy) return;
    this.beginInteraction('location');
    try {
      const input = await vscode.window.showInputBox({ title: 'Go to page', prompt: 'A page number or percentage, for example 12 or 40%', value: String(pageProgress(this.screen.book, this.snapshot.progress).page), validateInput: value => { try { parseLocation(this.screen.book, value); return undefined; } catch (error) { return (error as Error).message; } } });
      if (input !== undefined && !this.closed) this.goToLocation(input);
    } finally { this.endInteraction(); }
  }
  async showImages(id?: string, all = false): Promise<void> {
    if (this.closed || this.busy) return;
    this.beginInteraction('picker');
    try {
      const images = this.screen.book.images ?? [];
      if (!images.length || !this.imagePreview) { this.notice('No supported images in this book'); return; }
      const ordered = [...images].sort((a, b) => Number(b.chapters.includes(this.screen.chapter)) - Number(a.chapters.includes(this.screen.chapter)));
      let image: BookImage | undefined;
      if (id !== undefined) {
        image = images.find(item => item.id === id);
        if (!image) throw new Error('Image is not part of this book.');
      } else if (images.length === 1) image = images[0];
      else if (!all && images.filter(item => item.chapters.includes(this.screen.chapter)).length === 1) image = images.find(item => item.chapters.includes(this.screen.chapter));
      else image = (await vscode.window.showQuickPick(ordered.map(item => ({ label: item.label, description: item.chapters.includes(this.screen.chapter) ? 'Current chapter' : 'Book image', image: item })), { title: 'Open illustration', matchOnDescription: true }))?.image;
      if (image && !this.closed) { this.mode = 'image-loading'; this.draw(); await this.imagePreview(image); }
    } catch (error) {
      if (!this.closed) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { this.endInteraction(); }
  }
  private async prompt(kind: 'toc' | 'search' | 'bookmarks' | 'help'): Promise<void> {
    this.beginInteraction(kind === 'search' ? 'search' : 'picker');
    try {
      if (kind === 'help') {
        await vscode.window.showQuickPick([
          'Wheel / touchpad: scroll book; Shift+drag: terminal selection', 'v: freeze selection mode; v again: resume reading', 'y: copy visible book text; Y: open clean text for selection/copying',
          'j/k or arrows: move one line', 'Space / PageDown / PageUp: move one screen',
          'n/p: next / previous chapter', 'g: table of contents', 'u / U: jump back / forward',
          '/: search book (up to 1000 matches); [ / ]: previous / next; c: clear highlights', 'f: footnotes; Ctrl+click an internal reference; u: return to reading',
          'b: save bookmark; B: list bookmarks', 's: show progress; l: go to page or percentage', 'Ctrl+click an image marker: open that illustration in an editor tab', 'i: choose an illustration with the keyboard', 'Escape: hide text; r: resume hidden text; q: close reader'
        ], { title: 'Reader keys' });
        return;
      }
      let items: Array<vscode.QuickPickItem & { chapter: number; offset: number }>;
      if (kind === 'toc') items = this.screen.book.toc.map(item => ({ ...item, label: '  '.repeat(Math.min(item.depth, 8)) + safeText(item.title) }));
      else if (kind === 'bookmarks') items = this.state.bookmarks.map(item => ({ ...item, label: item.label, description: this.screen.book.chapters[item.chapter].title }));
      else {
        const query = await vscode.window.showInputBox({ title: 'Search book', value: this.search.query, prompt: 'Literal text, case insensitive; up to 1000 results. [ previous, ] next, c clear.', ignoreFocusOut: false, validateInput: value => value.length > 256 ? 'Use at most 256 characters.' : undefined });
        if (query !== undefined && !this.hidden && !this.closed) this.startSearch(query);
        return;
      }
      if (!items.length) { this.notice(kind === 'bookmarks' ? 'No bookmarks yet: b saves one' : 'No results'); return; }
      this.mode = 'picker'; this.draw();
      const selected = await vscode.window.showQuickPick(items, { title: kind === 'toc' ? 'Contents' : 'Bookmarks', matchOnDescription: true });
      if (selected && !this.closed && !this.hidden) { this.goTo(selected); }
    } catch (error) {
      if (!this.closed) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { this.endInteraction(); }
  }
}
