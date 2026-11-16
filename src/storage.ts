import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, rename, unlink, writeFile } from 'node:fs/promises';

// Files are authoritative; existing Memento data is a migration source.
// Node file I/O lets shutdown flush saves without depending on workbench IPC.
export class ReaderStorage {
  private readonly directory: vscode.Uri;
  private readonly values = new Map<string, unknown>();
  constructor(root: vscode.Uri, private readonly memory: { get<T>(key: string): T | undefined }) {
    // VS Code exposes local user data with a virtual scheme. Its overwrite
    // rename can delete the destination first, so use native atomic file I/O.
    const localRoot = root.scheme === 'vscode-userdata' && !root.authority ? vscode.Uri.file(root.fsPath) : root;
    this.directory = vscode.Uri.joinPath(localRoot, 'reading-state-v1');
  }
  private file(key: string): vscode.Uri {
    if (!/^(book\.v1\.[a-f0-9]{64}|recentBooks|lastBook)$/.test(key)) throw new Error('Invalid reading state key.');
    return vscode.Uri.joinPath(this.directory, key + '.json');
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (this.values.has(key)) return this.values.get(key) as T;
    try {
      const uri = this.file(key);
      const bytes = uri.scheme === 'file' ? await readFile(uri.fsPath) : await vscode.workspace.fs.readFile(uri);
      if (bytes.length <= 512 * 1024) {
        const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
        this.values.set(key, value); return value;
      }
    } catch { /* Missing or damaged files can fall back to legacy state. */ }
    this.file(key);
    // A forcibly stopped extension host can leave a completed staged save.
    // Prefer the committed file above; recover a valid temporary only when
    // that file is missing or unreadable, without overwriting another window.
    if (this.directory.scheme === 'file') {
      try {
        const candidates = await Promise.all((await readdir(this.directory.fsPath))
          .filter(name => name.startsWith(key + '.') && name.endsWith('.tmp'))
          .map(async name => {
            const uri = vscode.Uri.joinPath(this.directory, name);
            return { uri, info: await stat(uri.fsPath) };
          }));
        candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
        for (const candidate of candidates.slice(0, 16)) {
          if (!candidate.info.isFile() || candidate.info.size > 512 * 1024) continue;
          try {
            const value = JSON.parse(await readFile(candidate.uri.fsPath, 'utf8')) as T;
            this.values.set(key, value); return value;
          } catch { /* An interrupted partial write is not a recovery source. */ }
        }
      } catch { /* No readable staged saves; try the legacy state below. */ }
    }
    return this.memory.get<T>(key);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    const target = this.file(key);
    const temp = vscode.Uri.joinPath(this.directory, key + '.' + randomUUID() + '.tmp');
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      if (target.scheme === 'file') {
        await mkdir(this.directory.fsPath, { recursive: true });
        await writeFile(temp.fsPath, bytes);
        await rename(temp.fsPath, target.fsPath);
      } else {
        await vscode.workspace.fs.createDirectory(this.directory);
        await vscode.workspace.fs.writeFile(temp, bytes);
        await vscode.workspace.fs.rename(temp, target, { overwrite: true });
      }
    } catch (error) {
      try { if (temp.scheme === 'file') await unlink(temp.fsPath); else await vscode.workspace.fs.delete(temp); } catch { /* Ignore missing temporary files. */ }
      throw error;
    }
  }
}
