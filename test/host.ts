import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { zip, fb2, png } from './fixtures';
import { ReaderTerminal } from '../src/terminal';
import { restoreState, type Book, type ReadingState } from '../src/book';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(50); }
  throw new Error('Timed out waiting for terminal.');
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('alexChurkin.vscode-reader');
  assert.ok(extension);
  await extension.activate();
  const book: Book = { title: 'Private title', author: '', chapters: [{ id: 'one', title: 'One', text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), anchors: {} }, { id: 'two', title: 'Two', text: 'next chapter', anchors: {} }], toc: [] };
  let saved: ReadingState | undefined;
  const reader = new ReaderTerminal(book, '', restoreState(undefined, book), state => { saved = structuredClone(state); });
  let output = '';
  const subscription = reader.onDidWrite(data => { output = data; });
  const terminal = vscode.window.createTerminal({ name: 'reader-test', pty: reader });
  try {
    terminal.show();
    await until(() => output.includes('line 0'));
    assert.doesNotMatch(output, /Private title/);
    reader.handleInput('n'); assert.match(output, /next chapter/);
    reader.handleInput('p'); reader.handleInput('j');
    assert.equal(reader.screen.locator.offset, 7);
    reader.handleInput('b'); assert.equal(saved?.bookmarks.length, 1);
    // A split arrow hides provisionally then resumes only if reading was active.
    reader.handleInput('\x1b'); assert.match(output, /ready$/);
    reader.handleInput('[B'); assert.doesNotMatch(output, /ready$/);
    reader.handleInput('\x1b'); assert.match(output, /ready$/);
    reader.handleInput('\x1b[B'); assert.match(output, /ready$/);
    reader.handleInput('j'); assert.match(output, /ready$/);
    reader.setDimensions({ columns: 20, rows: 4 }); assert.match(output, /ready$/);
    reader.resume(); assert.doesNotMatch(output, /ready$/);
    reader.hide(); assert.match(output, /\x1b\[3J/);
    assert.ok(saved && saved.offset > 0);
    reader.close();
    const resumed = new ReaderTerminal(book, '', restoreState(saved, book), () => {});
    assert.equal(resumed.screen.locator.offset, saved.offset); resumed.close();
  } finally { terminal.dispose(); reader.close(); subscription.dispose(); }
  // Exercise real extension activation, worker, terminal creation, and resume command.
  const sample = vscode.Uri.joinPath(extension.extensionUri, 'samples', 'alice-in-wonderland.epub');
  const previous = new Set(vscode.window.terminals);
  await vscode.commands.executeCommand('vscodeReader.openBook', sample);
  const created = vscode.window.terminals.find(t => !previous.has(t));
  assert.ok(created, 'Open Book should create a real terminal');
  assert.equal(created.name, 'output');
  await vscode.commands.executeCommand('vscodeReader.hide');
  await vscode.commands.executeCommand('vscodeReader.resume');
  assert.ok(vscode.window.terminals.includes(created));
  await vscode.commands.executeCommand('vscodeReader.openBook', sample);
  assert.equal(vscode.window.terminals.filter(t => !previous.has(t)).length, 1, 'Opening twice reuses the terminal');
  created.dispose();
  await until(() => !vscode.window.terminals.includes(created));
  await vscode.commands.executeCommand('vscodeReader.resume');
  const reopened = vscode.window.terminals.find(t => !previous.has(t));
  assert.ok(reopened, 'Resume reopens the last closed book');
  reopened.dispose();
  await until(() => !vscode.window.terminals.includes(reopened));
  const directory = vscode.Uri.joinPath(extension.extensionUri, '.vscode-test', 'reader-fixtures');
  await vscode.workspace.fs.createDirectory(directory);
  const assets = vscode.Uri.joinPath(directory, 'assets');
  await vscode.workspace.fs.createDirectory(assets);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(assets, 'local.png'), png);
  const fixtures: Array<[string, Uint8Array, boolean]> = [
    ['sample.fb2', Buffer.from(fb2), true],
    ['sample.fb2.zip', zip([['nested/book.fb2', fb2]]), true],
    ['sample.fbz', zip([['book.fb2', fb2]]), false],
    ['sample.txt', Buffer.from('Text file\n\nПривет'), false],
    ['sample.html', Buffer.from('<title>HTML</title><h1>Start</h1><p>HTML text</p><h2>Picture</h2><img src="assets/local.png">'), true],
    ['sample.htm', Buffer.from('<h1>HTM</h1><pre>  indented\ncode</pre>'), false],
    ['sample.md', Buffer.from('# Markdown\n\n**Text**\n\n## Picture\n\n![Local](assets/local.png)'), true],
    ['sample.markdown', Buffer.from('# Full extension\n\nMarkdown text'), false],
    ['comic.cbz', zip([['page10.png', png], ['page2.png', png]]), true]
  ];
  for (const [name, bytes, hasImage] of fixtures) {
    const uri = vscode.Uri.joinPath(directory, name);
    await vscode.workspace.fs.writeFile(uri, bytes);
    const before = new Set(vscode.window.terminals);
    await vscode.commands.executeCommand('vscodeReader.openBook', uri);
    const session = vscode.window.terminals.find(t => !before.has(t));
    assert.ok(session, `${name} should open a terminal`);
    if (hasImage) {
      // A single embedded image or explicit comic page bypasses the picker.
      await vscode.commands.executeCommand('vscodeReader.openImage', name.endsWith('.cbz') ? 'page2.png' : undefined);
      let imageTab: vscode.Tab | undefined;
      await until(() => {
        imageTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.path.endsWith('.png'));
        return !!imageTab;
      });
      assert.ok(imageTab && imageTab.input instanceof vscode.TabInputCustom);
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(imageTab.input.uri)), png);
      await vscode.window.tabGroups.close(imageTab);
    }
    session.dispose();
    await until(() => !vscode.window.terminals.includes(session));
  }
  console.log('VS Code host checks passed: EPUB, FB2, FB2.ZIP, FBZ, TXT, CBZ, HTML, HTM, Markdown, native image tabs, navigation, hide, resize, bookmarks and reopen.');
}
