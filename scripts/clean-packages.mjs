import { readFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
if (manifest.version !== '0.1.0' || lock.version !== '0.1.0' || lock.packages[''].version !== '0.1.0') {
  throw new Error('Project version must stay at 0.1.0. Update the current build instead of creating another version.');
}
for (const file of await readdir(root)) {
  if (/^vscode-reader-\d+\.\d+\.\d+(?:-[\w.-]+)?\.vsix$/.test(file) && file !== 'vscode-reader-0.1.0.vsix') {
    await unlink(new URL(file, root));
    console.log(`Removed obsolete package: ${file}`);
  }
}
console.log(`Packaging ${fileURLToPath(new URL('vscode-reader-0.1.0.vsix', root))}`);
