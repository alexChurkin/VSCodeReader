import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { LIMITS } from './archive';
import { type ReadingState, restoreState, safeText } from './book';
import { supportedBook, type WorkerRequest, type BookResult, type ReadOptions } from './formats';
import type { ImageData } from './images';
import type { TextEncoding } from './encoding';
import { previewImage } from './image-preview';
import { ReaderTerminal } from './terminal';

interface Session { terminal: vscode.Terminal; reader: ReaderTerminal }
interface LastBook { uri: string; entry?: string; encoding?: TextEncoding }
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

export function activate(context: vscode.ExtensionContext): void {
  let latest: Session | undefined;
  const opening = new Set<string>();
  const loading = new Set<vscode.CancellationTokenSource>();
  let stopping = false;
  let writes = Promise.resolve();
  const update = (key: string, state: unknown) => {
    writes = writes.then(() => context.globalState.update(key, state)).catch(error => {
      void vscode.window.showErrorMessage(`Reader could not save position: ${safeText(String(error))}`);
    });
  };
  const workerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.cjs').fsPath;
  const task = <T>(title: string, callback: (token: vscode.CancellationToken) => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
    const source = new vscode.CancellationTokenSource();
    loading.add(source);
    const linked = token.onCancellationRequested(() => source.cancel());
    if (token.isCancellationRequested || stopping) source.cancel();
    try { return await callback(source.token); }
    finally { linked.dispose(); source.dispose(); loading.delete(source); }
  });
  const readBytes = async (uri: vscode.Uri) => {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > LIMITS.archive) throw new Error('Book exceeds the 100 MiB file limit.');
    return vscode.workspace.fs.readFile(uri);
  };
  const activeSession = () => [...sessions.values()].find(s => s.terminal === vscode.window.activeTerminal) ?? latest;
  const open = async (resource?: vscode.Uri, saved?: LastBook) => {
    if (!(resource instanceof vscode.Uri)) resource = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Books: ['epub', 'fb2', 'zip', 'fbz', 'txt', 'cbz'] }, title: 'Open book in terminal' }))?.[0];
    if (!resource || stopping) return;
    const uri = resource, id = uri.toString();
    const isZip = /\.(?:fb2\.zip|fbz)$/i.test(uri.path);
    const existing = sessions.get(sessionId(uri, saved?.entry));
    if (existing && (!isZip || saved?.entry)) { latest = existing; existing.reader.resume(); existing.terminal.show(); return; }
    if (opening.has(id)) return;
    opening.add(id);
    try {
      if (!supportedBook(uri.path)) throw new Error('Choose EPUB, FB2, FB2.ZIP, FBZ, TXT or CBZ. Ordinary ZIP archives are not opened as books.');
      await task('Opening document', async token => {
        const bytes = await readBytes(uri);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const hash = fingerprint(bytes);
        const config = vscode.workspace.getConfiguration('vscodeReader');
        const options: ReadOptions = { filename: uri.path, entry: saved?.entry, encoding: saved?.encoding ?? config.get<TextEncoding>('textEncoding', 'utf-8') };
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
        if (reused) { latest = reused; reused.reader.resume(); reused.terminal.show(); return; }
        const key = 'book.v1.' + createHash('sha256').update(keyId).update('\0').update(hash).update(/\.txt$/i.test(uri.path) ? options.encoding ?? 'utf-8' : '').digest('hex');
        const book = result.book;
        const rawState = context.globalState.get<ReadingState>(key);
        const state = restoreState(rawState, book);
        if (!rawState) state.chapter = Math.max(0, book.chapters.findIndex(c => c.text.replace(/\[image: [^\]]*\]|\[empty chapter\]|\s/g, '').length > 0));
        const reader = new ReaderTerminal(book, config.get<string>('linePrefix', ''), state, value => update(key, structuredClone(value)), async image => {
          try {
            await task('Opening illustration', async imageToken => {
              const current = await readBytes(uri);
              if (imageToken.isCancellationRequested) throw new vscode.CancellationError();
              if (fingerprint(current) !== hash) throw new Error('Book changed on disk. Close this reading session and reopen the book.');
              const data = await runWorker<ImageData>({ ...options, bytes: current, action: 'image', imageId: image.id }, workerPath, imageToken);
              if (!imageToken.isCancellationRequested && !stopping) await previewImage(context.globalStorageUri, data);
            });
          } catch (error) { if (!(error instanceof vscode.CancellationError)) throw error; }
        });
        const name = safeText(config.get<string>('terminalName', 'output')).replace(/\n/g, '').slice(0, 80) || 'output';
        const terminal = vscode.window.createTerminal({ name, pty: reader, location: vscode.TerminalLocation.Panel, iconPath: new vscode.ThemeIcon('terminal') });
        const session = { terminal, reader };
        sessions.set(keyId, session); latest = session;
        update('lastBook', { uri: id, entry: options.entry, encoding: options.encoding } satisfies LastBook);
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
      if (active) { active.reader.resume(); active.terminal.show(); }
      else {
        const raw = context.globalState.get<string | LastBook>('lastBook');
        const saved = typeof raw === 'string' ? { uri: raw } : raw;
        await open(saved ? vscode.Uri.parse(saved.uri) : undefined, saved);
      }
    }),
    vscode.commands.registerCommand('vscodeReader.hide', () => activeSession()?.reader.hide()),
    vscode.commands.registerCommand('vscodeReader.openImage', (id?: string) => activeSession()?.reader.showImages(typeof id === 'string' ? id : undefined, true)),
    vscode.window.onDidCloseTerminal(terminal => {
      for (const [id, session] of sessions) if (session.terminal === terminal) {
        session.reader.close(); sessions.delete(id);
        if (latest === session) latest = [...sessions.values()].at(-1);
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
