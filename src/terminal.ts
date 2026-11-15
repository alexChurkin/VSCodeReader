import * as vscode from 'vscode';
import { type Book, type ReadingState, type BookImage, type Bookmark, type Locator, safeText } from './book';
import { parseLocation, readingProgress, progressLabel } from './progress';
import { Screen, findMatches } from './screen';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
export class ReaderTerminal implements vscode.Pseudoterminal {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly writes = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writes.event;
  readonly screen: Screen;
  private hidden = false;
  private closed = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = '';
  private escapeWasHidden = true;
  constructor(book: Book, prefix: string, private state: ReadingState, private persist: (state: ReadingState) => void, private imagePreview?: (image: BookImage) => Promise<void>) {
    this.screen = new Screen(book, prefix, state);
  }
  open(dimensions?: vscode.TerminalDimensions): void {
    if (dimensions) this.screen.resize(dimensions.columns, dimensions.rows);
    // Alternate buffer avoids retaining previous book screens in scrollback.
    this.writes.fire('\x1b[?1049h\x1b[?25l' + CLEAR);
    this.draw();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.save();
    this.writes.dispose();
    this.changes.dispose();
  }
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.closed) return;
    this.screen.resize(dimensions.columns, dimensions.rows);
    this.draw();
    this.save();
  }
  hide(): void {
    if (this.closed) return;
    this.hidden = true;
    this.pending = '';
    this.save();
    this.writes.fire(CLEAR + 'ready');
  }
  resume(): void { if (this.closed) return; this.pending = ''; this.hidden = false; this.draw(); this.changes.fire(); }
  private draw(): void {
    if (this.closed) return;
    this.writes.fire(this.hidden ? CLEAR + 'ready' : this.screen.render());
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
      if (this.hidden || this.busy) return;
      const movement = keys.get(sequence)!;
      if (sequence.endsWith('~')) this.screen.page(Math.sign(movement)); else this.screen.move(movement);
      this.changed(); return;
    }
    // A preceding Escape hides immediately, but should not swallow the next command.
    if (this.hidden || this.busy) return;
    if (data === 'j' || data === '\r') this.screen.move(1);
    else if (data === 'k') this.screen.move(-1);
    else if (data === ' ' || data === '\x06') this.screen.page(1);
    else if (data === '\x02') this.screen.page(-1);
    else if (data === 'n') this.screen.nextChapter(1);
    else if (data === 'p') this.screen.nextChapter(-1);
    else if (data === 'g') { void this.prompt('toc'); return; }
    else if (data === '/') { void this.prompt('search'); return; }
    else if (data === 'i') { void this.showImages(); return; }
    else if (data === 'B') { void this.prompt('bookmarks'); return; }
    else if (data === 'b') { this.addBookmark(); return; }
    else if (data === 's') { this.showProgress(); return; }
    else if (data === 'l') { void this.promptLocation(); return; }
    else if (data === '?') { void this.prompt('help'); return; }
    else return;
    this.changed();
  }
  get snapshot() {
    return { book: this.screen.book, position: this.screen.locator, bookmarks: structuredClone(this.state.bookmarks), hidden: this.hidden,
      progress: readingProgress(this.screen.book, this.screen.locator, this.screen.row, this.screen.rows, this.screen.lines.length) };
  }
  showProgress() {
    const snapshot = this.snapshot;
    vscode.window.setStatusBarMessage(progressLabel(snapshot.progress), 7000);
    return { position: snapshot.position, progress: snapshot.progress, bookmarks: snapshot.bookmarks };
  }
  goTo(locator: Locator): void {
    if (this.closed || !Number.isSafeInteger(locator.chapter) || !Number.isSafeInteger(locator.offset)) return;
    this.hidden = false; this.pending = '';
    this.screen.go(locator); this.changed(); this.save();
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
      if (this.state.bookmarks.length >= 500) { vscode.window.setStatusBarMessage('Bookmark limit reached (500). Delete a bookmark first.', 4000); return; }
      bookmark = { ...position, label: this.defaultBookmarkLabel() };
      this.state.bookmarks.push(bookmark);
    }
    if (label !== undefined) bookmark.label = safeText(label).replace(/\s+/g, ' ').trim().slice(0, 120) || this.defaultBookmarkLabel();
    this.save();
    vscode.window.setStatusBarMessage('Bookmark saved', 2500);
    return { ...bookmark };
  }
  renameBookmark(position: Locator, label: string): void {
    const bookmark = this.state.bookmarks.find(b => b.chapter === position.chapter && b.offset === position.offset);
    if (!bookmark || this.closed) return;
    bookmark.label = safeText(label).replace(/\s+/g, ' ').trim().slice(0, 120) || bookmark.label;
    this.save();
  }
  deleteBookmark(position: Locator): void {
    if (this.closed) return;
    this.state.bookmarks = this.state.bookmarks.filter(b => b.chapter !== position.chapter || b.offset !== position.offset);
    this.save();
  }
  async promptAddBookmark(): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const label = await vscode.window.showInputBox({ title: 'Add bookmark', value: this.defaultBookmarkLabel(), validateInput: value => value.trim() ? undefined : 'Enter a bookmark name.' });
      if (label !== undefined && !this.closed) this.addBookmark(label);
    } finally { this.busy = false; }
  }
  async editBookmark(action: 'rename' | 'delete', position?: Locator, label?: string): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const selected = position ? this.state.bookmarks.find(b => b.chapter === position.chapter && b.offset === position.offset) : await vscode.window.showQuickPick(this.state.bookmarks.map(b => ({ ...b, description: `Chapter ${b.chapter + 1}` })), { title: action === 'rename' ? 'Rename bookmark' : 'Delete bookmark' });
      if (!selected || this.closed) return;
      if (action === 'delete') this.deleteBookmark(selected);
      else {
        const name = label ?? await vscode.window.showInputBox({ title: 'Rename bookmark', value: selected.label, validateInput: value => value.trim() ? undefined : 'Enter a bookmark name.' });
        if (name !== undefined && !this.closed) this.renameBookmark(selected, name);
      }
    } finally { this.busy = false; }
  }
  async showBookmarks(): Promise<void> { if (!this.closed && !this.busy) { this.resume(); await this.prompt('bookmarks'); } }
  async promptLocation(): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const input = await vscode.window.showInputBox({ title: 'Go to location', prompt: 'A text location number or percentage, for example 12 or 40%', value: String(this.snapshot.progress.location), validateInput: value => { try { parseLocation(this.screen.book, value); return undefined; } catch (error) { return (error as Error).message; } } });
      if (input !== undefined && !this.closed) this.goToLocation(input);
    } finally { this.busy = false; }
  }
  async showImages(id?: string, all = false): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const images = this.screen.book.images ?? [];
      if (!images.length || !this.imagePreview) { vscode.window.setStatusBarMessage('No supported embedded images in this book', 2500); return; }
      const ordered = [...images].sort((a, b) => Number(b.chapters.includes(this.screen.chapter)) - Number(a.chapters.includes(this.screen.chapter)));
      let image: BookImage | undefined;
      if (id !== undefined) {
        image = images.find(item => item.id === id);
        if (!image) throw new Error('Image is not part of this book.');
      } else if (images.length === 1) image = images[0];
      else if (!all && images.filter(item => item.chapters.includes(this.screen.chapter)).length === 1) image = images.find(item => item.chapters.includes(this.screen.chapter));
      else image = (await vscode.window.showQuickPick(ordered.map(item => ({ label: item.label, description: item.chapters.includes(this.screen.chapter) ? 'Current chapter' : 'Book image', image: item })), { title: 'Open illustration', matchOnDescription: true }))?.image;
      if (image && !this.closed) await this.imagePreview(image);
    } catch (error) {
      if (!this.closed) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { this.busy = false; }
  }
  private async prompt(kind: 'toc' | 'search' | 'bookmarks' | 'help'): Promise<void> {
    this.busy = true;
    try {
      if (kind === 'help') {
        await vscode.window.showQuickPick([
          'j/k or arrows: move one line', 'Space / PageDown / PageUp: move one screen',
          'n/p: next / previous chapter', 'g: table of contents', '/: search book (first 200 matches)',
          'b: save bookmark; B: list bookmarks', 's: show progress; l: go to location or percentage', 'i: open an illustration in an editor tab', 'Escape: hide text; Resume Reading command: continue'
        ], { title: 'Reader keys' });
        return;
      }
      let items: Array<vscode.QuickPickItem & { chapter: number; offset: number }>;
      if (kind === 'toc') items = this.screen.book.toc.map(item => ({ ...item, label: '  '.repeat(Math.min(item.depth, 8)) + safeText(item.title) }));
      else if (kind === 'bookmarks') items = this.state.bookmarks.map(item => ({ ...item, label: item.label, description: this.screen.book.chapters[item.chapter].title }));
      else {
        const query = await vscode.window.showInputBox({ title: 'Search book', prompt: 'Literal text, case insensitive; up to 200 results', ignoreFocusOut: false });
        if (query === undefined || !query.trim() || this.hidden || this.closed) return;
        items = findMatches(this.screen.book, query).map(item => ({ ...item, description: this.screen.book.chapters[item.chapter].title }));
      }
      if (!items.length) { vscode.window.setStatusBarMessage(kind === 'bookmarks' ? 'No bookmarks yet' : 'No results', 2000); return; }
      const selected = await vscode.window.showQuickPick(items, { title: kind === 'toc' ? 'Contents' : kind === 'search' ? 'Search results' : 'Bookmarks', matchOnDescription: true });
      if (selected && !this.closed && !this.hidden) { this.screen.go(selected); this.changed(); }
    } catch (error) {
      if (!this.closed) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { this.busy = false; }
  }
}
