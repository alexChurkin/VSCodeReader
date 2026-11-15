import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { LIMITS } from './archive';
import { type Book, type ReadingState, restoreState, safeText } from './book';
import { ReaderTerminal } from './terminal';

interface Session { terminal: vscode.Terminal; reader: ReaderTerminal }
const sessions = new Map<string, Session>();
let stop: (() => Promise<void>) | undefined;

function parseBook(bytes: Uint8Array, workerPath: string, token: vscode.CancellationToken): Promise<Book> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let complete = false;
    const finish = (error?: unknown, book?: Book) => {
      if (complete) return;
      complete = true;
      cancellation.dispose();
      void worker.terminate();
      if (error) reject(error); else resolve(book!);
    };
    const cancellation = token.onCancellationRequested(() => finish(new vscode.CancellationError()));
    worker.once('message', (message: { error?: string; book?: Book }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.book?.chapters?.length) finish(undefined, message.book);
      else finish(new Error('Parser returned an invalid book.'));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!complete) finish(new Error(`Book parser stopped (${code}). Try a smaller book.`)); });
    if (token.isCancellationRequested) finish(new vscode.CancellationError());
  });
}

export function activate(context: vscode.ExtensionContext): void {
  let latest: Session | undefined;
  const opening = new Set<string>();
  const loading = new Set<vscode.CancellationTokenSource>();
  let stopping = false;
  // Serialize storage writes so an older position cannot finish after a newer one.
  let writes = Promise.resolve();
  const update = (key: string, state: unknown) => {
    writes = writes.then(() => context.globalState.update(key, state)).catch(error => {
      void vscode.window.showErrorMessage(`Reader could not save position: ${safeText(String(error))}`);
    });
  };
  const open = async (resource?: vscode.Uri) => {
    if (!(resource instanceof vscode.Uri)) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { EPUB: ['epub'] }, title: 'Open book in terminal' });
      resource = picked?.[0];
    }
    if (!resource || stopping) return;
    const uri = resource;
    const id = uri.toString();
    const existing = sessions.get(id);
    if (existing) { latest = existing; existing.reader.resume(); existing.terminal.show(); return; }
    if (opening.has(id)) return;
    opening.add(id);
    try {
      if (!uri.path.toLowerCase().endsWith('.epub')) throw new Error('This prototype supports EPUB only. FB2 is the next milestone.');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening document', cancellable: true }, async (_, token) => {
        const cancellation = new vscode.CancellationTokenSource();
        loading.add(cancellation);
        const linked = token.onCancellationRequested(() => cancellation.cancel());
        if (token.isCancellationRequested || stopping) cancellation.cancel();
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > LIMITS.archive) throw new Error('Book exceeds the 100 MiB archive limit.');
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
          const fingerprint = createHash('sha256').update(bytes).digest('hex');
          const key = 'book.v1.' + createHash('sha256').update(id).update('\0').update(fingerprint).digest('hex');
          const book = await parseBook(bytes, vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.cjs').fsPath, cancellation.token);
          if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
          const rawState = context.globalState.get<ReadingState>(key);
          const state = restoreState(rawState, book);
          if (!rawState) state.chapter = Math.max(0, book.chapters.findIndex(c => c.text.replace(/\[image: [^\]]*\]|\[empty chapter\]|\s/g, '').length > 0));
          const config = vscode.workspace.getConfiguration('vscodeReader');
          const reader = new ReaderTerminal(book, config.get<string>('linePrefix', ''), state, value => update(key, value));
          const name = safeText(config.get<string>('terminalName', 'output')).replace(/\n/g, '').slice(0, 80) || 'output';
          const terminal = vscode.window.createTerminal({ name, pty: reader, location: vscode.TerminalLocation.Panel, iconPath: new vscode.ThemeIcon('terminal') });
          const session = { terminal, reader };
          sessions.set(id, session);
          latest = session;
          update('lastBook', id);
          terminal.show();
        } finally { linked.dispose(); cancellation.dispose(); loading.delete(cancellation); }
      });
    } catch (error) {
      if (!stopping && !(error instanceof vscode.CancellationError)) await vscode.window.showErrorMessage(`Reader: ${safeText(error instanceof Error ? error.message : String(error))}`);
    } finally { opening.delete(id); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeReader.openBook', (uri?: vscode.Uri) => {
      return open(uri);
    }),
    vscode.commands.registerCommand('vscodeReader.resume', async () => {
      const active = [...sessions.values()].find(s => s.terminal === vscode.window.activeTerminal) ?? latest;
      if (active) { active.reader.resume(); active.terminal.show(); }
      else { const uri = context.globalState.get<string>('lastBook'); await open(uri ? vscode.Uri.parse(uri) : undefined); }
    }),
    vscode.commands.registerCommand('vscodeReader.hide', () => {
      const active = [...sessions.values()].find(s => s.terminal === vscode.window.activeTerminal) ?? latest;
      active?.reader.hide();
    }),
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
