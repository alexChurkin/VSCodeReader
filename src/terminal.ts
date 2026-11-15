import * as vscode from 'vscode';
import { type Book, type ReadingState, safeText } from './book';
import { Screen, findMatches } from './screen';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
export class ReaderTerminal implements vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writes.event;
  readonly screen: Screen;
  private hidden = false;
  private closed = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = '';
  private escapeWasHidden = true;
  constructor(book: Book, prefix: string, private state: ReadingState, private persist: (state: ReadingState) => void) {
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
  }
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.screen.resize(dimensions.columns, dimensions.rows);
    this.draw();
  }
  hide(): void {
    this.hidden = true;
    this.pending = '';
    this.save();
    this.writes.fire(CLEAR + 'ready');
  }
  resume(): void { this.pending = ''; this.hidden = false; this.draw(); }
  private draw(): void {
    if (this.closed) return;
    this.writes.fire(this.hidden ? CLEAR + 'ready' : this.screen.render());
  }
  private save(): void {
    this.state = { ...this.state, ...this.screen.locator };
    this.persist(this.state);
  }
  private changed(): void {
    this.draw();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 200);
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
      this.screen.move(keys.get(sequence)!); this.changed(); return;
    }
    // A preceding Escape hides immediately, but should not swallow the next command.
    if (this.hidden || this.busy) return;
    if (data === 'j' || data === '\r') this.screen.move(1);
    else if (data === 'k') this.screen.move(-1);
    else if (data === ' ' || data === '\x06') this.screen.move(this.screen.rows);
    else if (data === '\x02') this.screen.move(-this.screen.rows);
    else if (data === 'n') this.screen.nextChapter(1);
    else if (data === 'p') this.screen.nextChapter(-1);
    else if (data === 'g') { void this.prompt('toc'); return; }
    else if (data === '/') { void this.prompt('search'); return; }
    else if (data === 'B') { void this.prompt('bookmarks'); return; }
    else if (data === 'b') {
      const locator = this.screen.locator;
      if (!this.state.bookmarks.some(b => b.chapter === locator.chapter && b.offset === locator.offset)) {
        this.state.bookmarks.push({ ...locator, label: this.screen.lines[this.screen.row].text.slice(0, 100) || this.screen.book.chapters[locator.chapter].title });
        this.state.bookmarks = this.state.bookmarks.slice(-500);
      }
      this.save();
    } else if (data === '?') { void this.prompt('help'); return; }
    else return;
    this.changed();
  }
  private async prompt(kind: 'toc' | 'search' | 'bookmarks' | 'help'): Promise<void> {
    this.busy = true;
    try {
      if (kind === 'help') {
        await vscode.window.showQuickPick([
          'j/k or arrows: move one line', 'Space / PageDown / PageUp: move one screen',
          'n/p: next / previous chapter', 'g: table of contents', '/: search book (first 200 matches)',
          'b: bookmark current position; B: list bookmarks', 'Escape: hide text; Resume Reading command: continue'
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
