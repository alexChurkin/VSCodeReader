import * as vscode from 'vscode';
import assert from 'node:assert/strict';
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
  console.log('VS Code host checks passed: terminal output, navigation, hide, resize, bookmarks, worker, reopen.');
}
