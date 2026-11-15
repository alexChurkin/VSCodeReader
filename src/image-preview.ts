import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ImageData } from './images';

let writes = Promise.resolve();
export async function previewImage(storage: vscode.Uri, image: ImageData, canOpen: () => boolean = () => true): Promise<void> {
  if (!/^(png|jpg|gif|webp|bmp)$/.test(image.extension)) throw new Error('Unsupported image type.');
  const directory = vscode.Uri.joinPath(storage, 'image-cache');
  const name = createHash('sha256').update(image.bytes).digest('hex') + '.' + image.extension;
  const target = vscode.Uri.joinPath(directory, name);
  const write = writes.catch(() => {}).then(async () => {
    await vscode.workspace.fs.createDirectory(directory);
    const entries = await vscode.workspace.fs.readDirectory(directory);
    const cached = await Promise.all(entries.filter(([file, type]) => type === vscode.FileType.File && /^[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)$/.test(file) && file !== name).map(async ([file]) => {
      const uri = vscode.Uri.joinPath(directory, file);
      return { uri, ...await vscode.workspace.fs.stat(uri) };
    }));
    cached.sort((a, b) => a.mtime - b.mtime);
    let total = cached.reduce((sum, item) => sum + item.size, 0) + image.bytes.length;
    while (cached.length >= 128 || total > 100 * 1024 * 1024) {
      const oldest = cached.shift();
      if (!oldest) break;
      await vscode.workspace.fs.delete(oldest.uri);
      total -= oldest.size;
    }
    await vscode.workspace.fs.writeFile(target, image.bytes);
  });
  writes = write;
  await write;
  if (!canOpen()) return;
  await vscode.commands.executeCommand('vscode.open', target, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true });
}
