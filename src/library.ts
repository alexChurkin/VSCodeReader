import { buildInfo, buildLabel } from './build-info';
import * as vscode from 'vscode';
import type { Locator, Bookmark, TocItem } from './book';
import { safeText } from './book';
import { pageProgress } from './progress';
import type { ReadingProgress } from './progress';

export interface RecentBook { uri: string; entry?: string; encoding?: 'utf-8' | 'windows-1251'; title?: string; progress?: string; imagePages?: boolean }
export interface LibraryTarget { sessionId?: string; position?: Locator }
export interface LibraryBook { id: string; title: string; hidden: boolean; progress: ReadingProgress; bookmarks: Bookmark[]; toc: TocItem[]; imagePages?: boolean; canGoBack?: boolean; canGoForward?: boolean }
export interface LibraryModel { active?: LibraryBook; open: LibraryBook[]; recent: RecentBook[] }
export class LibraryItem extends vscode.TreeItem {
  children?: LibraryItem[];
  target?: LibraryTarget;
}
export class ReaderLibrary implements vscode.TreeDataProvider<LibraryItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  constructor(private readonly model: () => LibraryModel) {}
  refresh(): void { this.changes.fire(); }
  dispose(): void { this.changes.dispose(); }
  getTreeItem(item: LibraryItem): vscode.TreeItem { return item; }
  getChildren(item?: LibraryItem): LibraryItem[] {
    if (item) return item.children ?? [];
    const model = this.model();
    const node = (id: string, label: string, icon: string, command?: string, args?: unknown[]): LibraryItem => {
      const item = new LibraryItem(safeText(label).slice(0, 200));
      item.id = id; item.iconPath = new vscode.ThemeIcon(icon);
      if (command) item.command = { command, title: label, arguments: args };
      return item;
    };
    const group = (id: string, label: string, icon: string, children: LibraryItem[], expanded = true) => {
      const item = node(id, label, icon); item.children = children;
      item.collapsibleState = expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      return item;
    };
    const roots = [node('open', 'Open book…', 'folder-opened', 'vscodeReader.openBook'), node('resume', 'Continue reading', 'play', 'vscodeReader.resume')];
    const active = model.active;
    if (active) {
      const prefix = 'book:' + encodeURIComponent(active.id);
      const target = { sessionId: active.id };
      const p = active.progress;
      const page = pageProgress(active, p);
      const progress = node(prefix + ':progress', `Page ${page.page}/${page.pages} · ${page.percent}%`, 'location', 'vscodeReader.goToLocation', [undefined, target]);
      progress.description = `Chapter ${p.chapter}/${p.chapters} · Screen ${p.screen}/${p.screens}`;
      progress.tooltip = 'Go to a page or percentage. Screens depend on terminal size; text pages stay fixed.';
      const bookmarks = active.bookmarks.map(b => {
        const item = node(`${prefix}:bookmark:${b.chapter}:${b.offset}`, b.label, 'bookmark', 'vscodeReader.goToBookmark', [{ ...target, position: b }]);
        item.description = `Chapter ${b.chapter + 1}`;
        item.contextValue = 'readerBookmark'; item.target = { ...target, position: { chapter: b.chapter, offset: b.offset } };
        return item;
      });
      if (!bookmarks.length) bookmarks.push(node(prefix + ':no-bookmarks', 'Add your first bookmark…', 'bookmark', 'vscodeReader.addBookmark', [undefined, target]));
      const contents = active.toc.map((toc, index) => node(`${prefix}:toc:${index}`, '  '.repeat(Math.min(8, toc.depth)) + toc.title, 'list-tree', 'vscodeReader.goToBookmark', [{ ...target, position: { chapter: toc.chapter, offset: toc.offset } }]));
      const book = group(prefix, active.title, 'book', [
        progress,
        ...(active.canGoBack ? [node(prefix + ':back', 'Back to previous passage', 'arrow-left', 'vscodeReader.goBack', [target])] : []),
        ...(active.canGoForward ? [node(prefix + ':forward', 'Forward to next passage', 'arrow-right', 'vscodeReader.goForward', [target])] : []),
        node(prefix + ':find', 'Find in book…', 'search', 'vscodeReader.find', [undefined, target]),
        node(prefix + ':footnotes', 'Footnotes in chapter…', 'references', 'vscodeReader.showFootnotes', [target]),
        node(prefix + ':copy', 'Copy visible book text', 'copy', 'vscodeReader.copyText', [target]),
        node(prefix + ':copy-view', 'Select / copy clean text…', 'selection', 'vscodeReader.copyView', [target]),
        node(prefix + ':layout', 'Reading layout…', 'layout', 'vscodeReader.readingLayout'),
        node(prefix + ':next', 'Next screen', 'arrow-down', 'vscodeReader.nextPage', [target]),
        node(prefix + ':previous', 'Previous screen', 'arrow-up', 'vscodeReader.previousPage', [target]),
        node(prefix + ':add', 'Add bookmark…', 'bookmark', 'vscodeReader.addBookmark', [undefined, target]),
        group(prefix + ':bookmarks', `Bookmarks (${active.bookmarks.length})`, 'bookmark', bookmarks),
        group(prefix + ':contents', 'Contents', 'list-tree', contents, false)
      ]);
      book.description = active.hidden ? 'Text hidden' : 'Reading';
      book.command = { command: 'vscodeReader.focusSession', title: 'Continue reading', arguments: [target] };
      roots.push(book);
    }
    if (model.open.length > 1) roots.push(group('sessions', 'Open books', 'library', model.open.map(b => node('session:' + encodeURIComponent(b.id), b.title, 'book', 'vscodeReader.focusSession', [{ sessionId: b.id }])), false));
    if (model.recent.length) roots.push(group('recent', 'Recent books', 'history', model.recent.map((book, i) => {
      const item = node(`recent:${i}`, book.title || book.uri.split('/').at(-1) || 'Book', 'book', 'vscodeReader.openRecent', [book]);
      item.description = book.progress; item.tooltip = book.uri + (book.entry ? '\n' + book.entry : '');
      return item;
    })));
    const installed = node('build', `Installed: ${buildLabel()}`, 'info', 'vscodeReader.installedBuild');
    installed.tooltip = `Installed code: ${buildInfo.revision}${buildInfo.builtAt ? '\nBuilt: ' + buildInfo.builtAt : ''}`;
    roots.push(installed);
    roots.push(node('update', 'Open latest GitHub Release', 'cloud-download', 'vscodeReader.openLatestRelease'));
    return roots;
  }
}
