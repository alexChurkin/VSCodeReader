import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { safeText } from './book';

export type CopyViewOpener = (content: string, title: string, offset: number, canOpen: () => boolean) => Promise<void>;
export class CopyViews implements vscode.Disposable {
  private readonly snapshots = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly scheme = 'vscode-reader-copy') {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: uri => {
          const text = this.snapshots.get(uri.toString());
          if (text === undefined) throw new Error('This copy view has been closed. Open it again from the reader.');
          return text;
        },
      }),
      vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === scheme) this.snapshots.delete(document.uri.toString()); }),
    ];
  }
  readonly open: CopyViewOpener = async (content, title, offset, canOpen) => {
    if (!canOpen()) return;
    const name = safeText(title).replace(/[\\/]/g, '-').slice(0, 100);
    const hash = createHash('sha256').update(content).digest('hex');
    const uri = vscode.Uri.from({ scheme: this.scheme, path: `/${hash}/${name || 'Book text'}.txt` });
    const key = uri.toString();
    if (!this.snapshots.has(key) && this.snapshots.size >= 8) throw new Error('Close a copy view before opening another (maximum 8).');
    this.snapshots.set(key, content);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (!canOpen()) { this.snapshots.delete(key); return; }
      const position = document.positionAt(offset);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: new vscode.Range(position, position) });
    } catch (error) { this.snapshots.delete(key); throw error; }
  };
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); this.snapshots.clear(); }
}
