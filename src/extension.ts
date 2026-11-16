import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { LIMITS } from './archive';
import { terminalName } from './footer';
import { ReaderStorage } from './storage';
import { ReaderLibrary, LibraryItem, type RecentBook, type LibraryTarget, type LibraryBook } from './library';
import { pageProgress, type ReadingProgress } from './progress';
import { type ReadingState, restoreState, safeText } from './book';
import { supportedBook, type WorkerRequest, type BookResult, type ReadOptions } from './formats';
import type { ImageData } from './images';
import { isMarkup } from './markup';
import type { TextEncoding } from './encoding';
import { previewImage } from './image-preview';
import type { ReadingLayout } from './screen';
import { ReaderTerminal } from './terminal';
import { CopyViews } from './copy-view';
import { buildInfo } from './build-info';
import { openLatestRelease, showInstalledBuild } from './updates';
import { ReaderLinks } from './terminal-links';

interface Session { id: string; source: RecentBook; terminal: vscode.Terminal; reader: ReaderTerminal }
type LastBook = RecentBook;
const sessions = new Map<string, Session>();
let stop: (() => Promise<void>) | undefined;

function runWorker<T>(request: WorkerRequest, workerPath: string, token: vscode.CancellationToken): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let complete = false;
    const finish = (error?: unknown, result?: T) => {
      if (complete) return;
      complete = true;
      cancellation.dispose();
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancellation = token.onCancellationRequested(() => finish(new vscode.CancellationError()));
    worker.once('message', (message: { error?: string; result?: T }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.result !== undefined) finish(undefined, message.result);
      else finish(new Error('Parser returned an invalid response.'));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!complete) finish(new Error(`Book parser stopped (${code}). Try a smaller book.`)); });
    if (token.isCancellationRequested) finish(new vscode.CancellationError());
  });
}
const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sessionId = (uri: vscode.Uri, entry?: string) => uri.toString() + (entry ? '\0' + entry : '');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const copyViews = new CopyViews();
  context.subscriptions.push(copyViews);
  const storage = new ReaderStorage(context.globalStorageUri, context.globalState);
  let latest: Session | undefined;
  const opening = new Set<string>();
  const loading = new Set<vscode.CancellationTokenSource>();
  let stopping = false;
  let writes = Promise.resolve();
  const update = (key: string, state: unknown) => {
    writes = writes.then(() => storage.update(key, state)).catch(error => {
      void vscode.window.showErrorMessage(`Reader could not save position: ${safeText(String(error))}`);
    });
  };
  const workerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.cjs').fsPath;
  const task = <T>(title: string, callback: (token: vscode.CancellationToken) => Promise<T>, closeEvent?: vscode.Event<void | number>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
    const source = new vscode.CancellationTokenSource();
    loading.add(source);
    const linked = token.onCancellationRequested(() => source.cancel());
    const closing = closeEvent?.(() => source.cancel());
    if (token.isCancellationRequested || stopping) source.cancel();
    try { return await callback(source.token); }
    finally { closing?.dispose(); linked.dispose(); source.dispose(); loading.delete(source); }
  });
  const readBytes = async (uri: vscode.Uri) => {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > LIMITS.archive) throw new Error('Book exceeds the 100 MiB file limit.');
    return vscode.workspace.fs.readFile(uri);
  };
  const readLayout = (): ReadingLayout => {
    const config = vscode.workspace.getConfiguration('vscodeReader');
    return { maxTextWidth: config.get<number>('maxTextWidth', 0), horizontalPadding: config.get<number>('horizontalPadding', 0), centerText: config.get<boolean>('centerText', false) };
  };
  const activeSession = () => [...sessions.values()].find(s => !s.reader.isClosed && s.terminal === vscode.window.activeTerminal) ?? (latest && !latest.reader.isClosed ? latest : [...sessions.values()].filter(s => !s.reader.isClosed).at(-1));
  const recentValue = await storage.get<RecentBook[]>('recentBooks');
  let recent: RecentBook[] = Array.isArray(recentValue) ? recentValue.filter(item => item && typeof item.uri === 'string').slice(0, 10) : [];
  const asLibraryBook = (session: Session): LibraryBook => {
    const snapshot = session.reader.snapshot;
    return { id: session.id, title: snapshot.book.title, hidden: snapshot.hidden, progress: snapshot.progress, bookmarks: snapshot.bookmarks, toc: snapshot.book.toc, imagePages: snapshot.book.imagePages, canGoBack: snapshot.canGoBack, canGoForward: snapshot.canGoForward };
  };
  const library = new ReaderLibrary(() => {
    const active = activeSession();
    return { active: active ? asLibraryBook(active) : undefined, open: [...sessions.values()].map(asLibraryBook), recent };
  });
  const refresh = () => {
    if (stopping) return;
    library.refresh();
    void vscode.commands.executeCommand('setContext', 'vscodeReader.hasBook', sessions.size > 0);
  };
  const remember = (source: RecentBook, progress: ReadingProgress, last = false) => {
    const page = pageProgress(source, progress);
    const book = { ...source, progress: `Page ${page.page}/${page.pages} · ${page.percent}%` };
    recent = [book, ...recent.filter(item => item.uri !== book.uri || item.entry !== book.entry)].slice(0, 10);
    update('recentBooks', recent);
    if (last) update('lastBook', book);
    refresh();
  };
  const targetFrom = (value: unknown): LibraryTarget | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const target = (value as LibraryItem).target ?? value as LibraryTarget;
    return target;
  };
  const selectedSession = (value?: unknown) => {
    const target = targetFrom(value);
    return target?.sessionId ? sessions.get(target.sessionId) : activeSession();
  };
  const focusSession = (session?: Session) => {
    if (!session) return;
    latest = session; session.reader.resume(); session.terminal.show();
    remember(session.source, session.reader.snapshot.progress, true);
  };
  const removeSession = (session: Session) => {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    if (latest === session) latest = [...sessions.values()].at(-1);
    refresh();
  };
  context.subscriptions.push(vscode.window.registerTerminalLinkProvider(new ReaderLinks(terminal => [...sessions.values()].find(session => session.terminal === terminal)?.reader)));
  context.subscriptions.push(library, vscode.window.createTreeView('vscodeReader.library', { treeDataProvider: library, showCollapseAll: true }));
  refresh();
  const open = async (resource?: vscode.Uri, saved?: LastBook) => {
    if (!(resource instanceof vscode.Uri)) resource = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Books: ['epub', 'fb2', 'zip', 'fbz', 'txt', 'cbz', 'html', 'htm', 'md', 'markdown'] }, title: 'Open book in terminal' }))?.[0];
    if (!resource || stopping) return;
    const uri = resource, id = uri.toString();
    const isZip = /\.(?:fb2\.zip|fbz)$/i.test(uri.path);
    const cached = sessions.get(sessionId(uri, saved?.entry));
    const existing = cached && !cached.reader.isClosed ? cached : undefined;
    if (cached?.reader.isClosed) removeSession(cached);
    if (existing && (!isZip || saved?.entry)) { focusSession(existing); return; }
    if (opening.has(id)) return;
    opening.add(id);
    try {
      if (!supportedBook(uri.path)) throw new Error('Choose EPUB, FB2, FB2.ZIP, FBZ, TXT, CBZ, HTML or Markdown. Ordinary ZIP archives are not opened as books.');
      await task('Opening document', async token => {
        const bytes = await readBytes(uri);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const hash = fingerprint(bytes);
        const config = vscode.workspace.getConfiguration('vscodeReader');
        const options: ReadOptions = { filename: uri.path, documentPath: uri.scheme === 'file' ? uri.fsPath : undefined, entry: saved?.entry, encoding: saved?.encoding ?? config.get<TextEncoding>('textEncoding', 'utf-8') };
        let result = await runWorker<BookResult>({ bytes, ...options }, workerPath, token);
        if (result.kind === 'selection') {
          const selected = await vscode.window.showQuickPick(result.entries.map(entry => ({ label: safeText(entry), entry })), { title: 'Choose a book from the archive' });
          if (!selected || token.isCancellationRequested) return;
          options.entry = selected.entry;
          result = await runWorker<BookResult>({ bytes, ...options }, workerPath, token);
        }
        if (result.kind !== 'book') throw new Error('Choose a book from the archive.');
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        options.entry = result.entry;
        const keyId = sessionId(uri, options.entry);
        const reused = sessions.get(keyId);
        if (reused) { focusSession(reused); return; }
        const key = 'book.v1.' + createHash('sha256').update(keyId).update('\0').update(hash).update(/\.txt$/i.test(uri.path) || isMarkup(uri.path) ? options.encoding ?? 'utf-8' : '').digest('hex');
        const book = result.book;
        await writes;
        const rawState = await storage.get<ReadingState>(key);
        const state = restoreState(rawState, book);
        if (!rawState) state.chapter = Math.max(0, book.chapters.findIndex(c => c.text.replace(/\[image(?: #\d+)?: [^\]]*\]|\[empty chapter\]|\s/g, '').length > 0));
        const source: RecentBook = { uri: id, entry: options.entry, encoding: options.encoding, title: book.title.slice(0, 200), imagePages: book.imagePages };
        const reader = new ReaderTerminal(book, config.get<string>('linePrefix', ''), state, value => {
          update(key, structuredClone(value));
          remember(source, reader.snapshot.progress, activeSession()?.reader === reader);
        }, async image => {
          try {
            await task('Opening illustration', async imageToken => {
              const current = await readBytes(uri);
              if (imageToken.isCancellationRequested) throw new vscode.CancellationError();
              if (fingerprint(current) !== hash) throw new Error('Book changed on disk. Close this reading session and reopen the book.');
              const data = await runWorker<ImageData>({ ...options, bytes: current, action: 'image', imageId: image.id }, workerPath, imageToken);
              if (!imageToken.isCancellationRequested && !stopping && !reader.isClosed) await previewImage(context.globalStorageUri, data, () => !reader.isClosed && !imageToken.isCancellationRequested && !stopping);
            }, reader.onDidClose);
          } catch (error) { if (!(error instanceof vscode.CancellationError)) throw error; }
        }, copyViews.open);
        reader.configureLayout(readLayout());
        reader.configureMouse(config.get<number>('wheelScrollLines', 3));
        const name = terminalName(config.get<string>('terminalName', '{title}'), book.title, uri.path.split('/').at(-1) || 'Reader');
        const terminal = vscode.window.createTerminal({ name, pty: reader, location: vscode.TerminalLocation.Panel, iconPath: new vscode.ThemeIcon('book'), isTransient: true });
        const session: Session = { id: keyId, source, terminal, reader };
        context.subscriptions.push(reader.onDidChange(refresh), reader.onDidClose(() => removeSession(session)));
        sessions.set(keyId, session); latest = session;
        remember(source, reader.snapshot.progress, true);
        terminal.show();
      });
    } catch (error) {
      if (!stopping && !(error instanceof vscode.CancellationError)) void vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { opening.delete(id); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeReader.openBook', (uri?: vscode.Uri) => open(uri)),
    vscode.commands.registerCommand('vscodeReader.resume', async () => {
      const active = activeSession();
      if (active) focusSession(active);
      else {
        await writes;
        const raw = await storage.get<string | LastBook>('lastBook');
        const saved = typeof raw === 'string' ? { uri: raw } : raw && typeof raw === 'object' && typeof raw.uri === 'string' ? raw : undefined;
        await open(saved ? vscode.Uri.parse(saved.uri) : undefined, saved);
      }
    }),
    vscode.commands.registerCommand('vscodeReader.goBack', target => { const session = selectedSession(target); focusSession(session); session?.reader.travel(-1); }),
    vscode.commands.registerCommand('vscodeReader.goForward', target => { const session = selectedSession(target); focusSession(session); session?.reader.travel(1); }),
    vscode.commands.registerCommand('vscodeReader.find', async (query?: unknown, target?: unknown) => {
      const session = selectedSession(target); if (!session) return;
      focusSession(session);
      if (typeof query === 'string') session.reader.startSearch(query); else await session.reader.promptSearch();
      return session.reader.snapshot.search;
    }),
    vscode.commands.registerCommand('vscodeReader.nextMatch', () => { const session = activeSession(); focusSession(session); session?.reader.nextMatch(1); }),
    vscode.commands.registerCommand('vscodeReader.previousMatch', () => { const session = activeSession(); focusSession(session); session?.reader.nextMatch(-1); }),
    vscode.commands.registerCommand('vscodeReader.clearSearch', () => activeSession()?.reader.clearSearch()),
    vscode.commands.registerCommand('vscodeReader.showFootnotes', target => { const session = selectedSession(target); focusSession(session); return session?.reader.showFootnotes(); }),
    vscode.commands.registerCommand('vscodeReader.readingLayout', async () => {
      const selected = await vscode.window.showQuickPick([
        { label: 'Full terminal width', layout: { maxTextWidth: 0, horizontalPadding: 0, centerText: false } },
        { label: 'Comfortable: 80 columns, centered', layout: { maxTextWidth: 80, horizontalPadding: 2, centerText: true } },
        { label: 'Wide: 100 columns, centered', layout: { maxTextWidth: 100, horizontalPadding: 2, centerText: true } },
        { label: 'Custom settings…', layout: undefined },
      ], { title: 'Reading layout' });
      if (!selected) return;
      if (!selected.layout) { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:alexChurkin.vscode-reader'); return; }
      const config = vscode.workspace.getConfiguration('vscodeReader');
      for (const [key, value] of Object.entries(selected.layout)) await config.update(key, value, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscodeReader')) for (const session of sessions.values()) {
        session.reader.configureLayout(readLayout());
        session.reader.configureMouse(vscode.workspace.getConfiguration('vscodeReader').get<number>('wheelScrollLines', 3));
      }
    }),
    vscode.commands.registerCommand('vscodeReader.installedBuild', showInstalledBuild),
    vscode.commands.registerCommand('vscodeReader.openLatestRelease', openLatestRelease),
    vscode.commands.registerCommand('vscodeReader.buildInfo', () => ({ ...buildInfo })),
    vscode.commands.registerCommand('vscodeReader.copyText', target => selectedSession(target)?.reader.copyVisibleText()),
    vscode.commands.registerCommand('vscodeReader.copyView', target => selectedSession(target)?.reader.openCopyView()),
    vscode.commands.registerCommand('vscodeReader.selectText', target => selectedSession(target)?.reader.toggleSelection()),
    vscode.commands.registerCommand('vscodeReader.hide', () => activeSession()?.reader.hide()),
    vscode.commands.registerCommand('vscodeReader.openImage', (id?: string) => activeSession()?.reader.showImages(typeof id === 'string' ? id : undefined, true)),
    vscode.commands.registerCommand('vscodeReader.focusSession', target => focusSession(selectedSession(target))),
    vscode.commands.registerCommand('vscodeReader.openRecent', async (source?: RecentBook) => {
      const selected = source && typeof source.uri === 'string' ? source : (await vscode.window.showQuickPick(recent.map(book => ({ label: book.title || book.uri.split('/').at(-1) || 'Book', description: book.progress, book })), { title: 'Recent books' }))?.book;
      if (selected) await open(vscode.Uri.parse(selected.uri), selected);
    }),
    vscode.commands.registerCommand('vscodeReader.showProgress', () => activeSession()?.reader.showProgress()),
    vscode.commands.registerCommand('vscodeReader.goToLocation', async (input?: unknown, target?: unknown) => {
      const session = selectedSession(target); if (!session) return;
      focusSession(session);
      if (typeof input === 'string') session.reader.goToLocation(input); else await session.reader.promptLocation();
      return session.reader.showProgress();
    }),
    vscode.commands.registerCommand('vscodeReader.nextPage', target => { const session = selectedSession(target); focusSession(session); session?.reader.page(1); }),
    vscode.commands.registerCommand('vscodeReader.previousPage', target => { const session = selectedSession(target); focusSession(session); session?.reader.page(-1); }),
    vscode.commands.registerCommand('vscodeReader.addBookmark', (label?: unknown, target?: unknown) => {
      const session = selectedSession(target); if (!session) return;
      return typeof label === 'string' ? session.reader.addBookmark(label) : session.reader.promptAddBookmark();
    }),
    vscode.commands.registerCommand('vscodeReader.showBookmarks', () => activeSession()?.reader.showBookmarks()),
    vscode.commands.registerCommand('vscodeReader.goToBookmark', value => {
      const target = targetFrom(value), session = selectedSession(value);
      if (!session || !target?.position) return;
      focusSession(session); session.reader.goTo(target.position);
    }),
    vscode.commands.registerCommand('vscodeReader.renameBookmark', (value, label?: string) => selectedSession(value)?.reader.editBookmark('rename', targetFrom(value)?.position, typeof label === 'string' ? label : undefined)),
    vscode.commands.registerCommand('vscodeReader.deleteBookmark', value => selectedSession(value)?.reader.editBookmark('delete', targetFrom(value)?.position)),
    vscode.window.onDidChangeActiveTerminal(terminal => {
      if (stopping) return;
      const session = [...sessions.values()].find(item => item.terminal === terminal);
      if (session) { latest = session; remember(session.source, session.reader.snapshot.progress, true); }
    }),
    vscode.window.onDidCloseTerminal(terminal => {
      for (const session of sessions.values()) if (session.terminal === terminal) {
        session.reader.close(); removeSession(session);
      }
    })
  );
  stop = async () => {
    stopping = true;
    for (const source of loading) source.cancel();
    for (const session of sessions.values()) { session.reader.close(); session.terminal.dispose(); }
    sessions.clear();
    await writes;
  };
}
export async function deactivate(): Promise<void> { await stop?.(); }
