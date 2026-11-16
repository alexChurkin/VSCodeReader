import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zip, fb2, png } from './fixtures';
import { ReaderLibrary, type LibraryBook } from '../src/library';
import type { ReadingProgress } from '../src/progress';
import { ReaderTerminal } from '../src/terminal';
import { ReaderImageLinks } from '../src/terminal-links';
import { readFb2 } from '../src/fb2';
import { previewImage } from '../src/image-preview';
import { validateImage } from '../src/images';
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
  await vscode.commands.executeCommand('workbench.view.extension.vscodeReader');
  assert.ok(extension.packageJSON.contributes.viewsContainers.activitybar.some((item: { icon: string }) => item.icon === 'media/book.svg'));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, 'media', 'book.svg'));
  const persistenceDirectory = vscode.Uri.joinPath(extension.extensionUri, '.vscode-test', 'reader-fixtures');
  const persistenceUri = vscode.Uri.joinPath(persistenceDirectory, 'persistence.txt');
  const expectedUri = vscode.Uri.joinPath(persistenceDirectory, 'expected-position.json');
  type Status = { position: { chapter: number; offset: number }; bookmarks: Array<{ chapter: number; offset: number; label: string }>; progress: ReadingProgress };
  if (process.env.READER_TEST_PASS === 'restore') {
    const expected = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(expectedUri)).toString()) as Status;
    await Promise.race([vscode.commands.executeCommand('vscodeReader.resume'), pause(10_000).then(() => { throw new Error('Resume did not restore the saved book.'); })]);
    const actual = await vscode.commands.executeCommand<Status>('vscodeReader.showProgress');
    console.log('Restored position:', JSON.stringify(actual.position), 'expected:', JSON.stringify(expected.position));
    assert.deepEqual(actual.position, expected.position, 'Exact position should survive a full VS Code restart');
    assert.deepEqual(actual.bookmarks, expected.bookmarks, 'Named bookmarks should survive a full VS Code restart');
    assert.equal(actual.progress.location, expected.progress.location);
    console.log('Persistence passed after a full VS Code restart: position and named bookmarks restored.');
    return;
  }
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
    reader.setDimensions({ columns: 80, rows: 6 });
    assert.equal(reader.screen.rows, 5, 'One row should be reserved for hints');
    assert.match(output, /\x1b\[6;1H\x1b\[2K\x1b\[2m/);
    assert.match(output, /\? help/);
    assert.match(output, /Page 1\/1 \| 0%/);
    let exits = 0;
    const exitSubscription = reader.onDidClose(code => { exits++; assert.equal(code, 0); });
    reader.handleInput('n'); assert.match(output, /next chapter/);
    reader.handleInput('p'); reader.handleInput('j');
    assert.equal(reader.screen.locator.offset, 7);
    reader.handleInput('b'); assert.equal(saved?.bookmarks.length, 1);
    assert.match(output, /Page 1\/1 \|/);
    assert.match(output, /Bookmark saved/);
    const bookmark = reader.snapshot.bookmarks[0];
    reader.renameBookmark(bookmark, 'Named checkpoint');
    assert.equal(reader.snapshot.bookmarks[0].label, 'Named checkpoint');
    const sidebarBook = (): LibraryBook => ({ id: 'test', title: book.title, hidden: reader.snapshot.hidden, progress: reader.snapshot.progress, bookmarks: reader.snapshot.bookmarks, toc: book.toc });
    const sidebar = new ReaderLibrary(() => ({ active: sidebarBook(), open: [sidebarBook()], recent: [] }));
    const tree = sidebar.getChildren();
    assert.equal(tree[0].command?.command, 'vscodeReader.openBook');
    const current = tree.find(item => item.label === book.title)!;
    assert.ok(current); assert.match(String(current.children![0].label), /Page/);
    const bookmarks = current.children!.find(item => String(item.label).startsWith('Bookmarks'))!;
    assert.equal(bookmarks.children![0].contextValue, 'readerBookmark');
    assert.equal(bookmarks.children![0].label, 'Named checkpoint');
    reader.deleteBookmark(bookmark); assert.equal(reader.snapshot.bookmarks.length, 0);
    reader.addBookmark('Saved checkpoint');
    sidebar.dispose();
    // A split arrow hides provisionally then resumes only if reading was active.
    reader.handleInput('\x1b'); assert.match(output, /ready/);
    reader.handleInput('[B'); assert.doesNotMatch(output, /ready/);
    reader.handleInput('\x1b'); assert.match(output, /ready/);
    reader.handleInput('\x1b[B'); assert.match(output, /ready/);
    reader.handleInput('j'); assert.match(output, /ready/);
    reader.setDimensions({ columns: 20, rows: 4 }); assert.match(output, /ready/);
    assert.match(output, /r resume/);
    reader.handleInput('r'); assert.doesNotMatch(output, /ready/);
    reader.hide(); assert.match(output, /\x1b\[3J/);
    assert.ok(saved && saved.offset > 0);
    reader.close(); reader.close();
    assert.equal(exits, 1, 'Close should acknowledge process exit exactly once');
    exitSubscription.dispose();
    await until(() => !vscode.window.terminals.includes(terminal));
    const resumed = new ReaderTerminal(book, '', restoreState(saved, book), () => {});
    assert.equal(resumed.screen.locator.offset, saved.offset);
    let earlyExits = 0; resumed.onDidClose(() => { earlyExits++; });
    resumed.close(); resumed.open(); resumed.open();
    assert.equal(earlyExits, 1, 'Closing before open must acknowledge exit when the process starts');
  } finally { terminal.dispose(); reader.close(); subscription.dispose(); }
  // Exercise the same link provider registered by the extension, including the
  // native image editor and ownership when two sessions have identical markers.
  const imageBook = readFb2(Buffer.from(fb2));
  let firstOpens = 0, secondOpens = 0;
  const first = new ReaderTerminal(imageBook, '[log] ', restoreState(undefined, imageBook), () => {}, async image => {
    assert.equal(image.id, 'picture'); firstOpens++;
    await previewImage(persistenceDirectory, validateImage(png));
  });
  const second = new ReaderTerminal(imageBook, '[log] ', restoreState(undefined, imageBook), () => {}, async () => { secondOpens++; });
  const firstTerminal = vscode.window.createTerminal({ name: 'image-links-first', pty: first });
  const secondTerminal = vscode.window.createTerminal({ name: 'image-links-second', pty: second });
  const linkCancellation = new vscode.CancellationTokenSource();
  try {
    await pause(200);
    first.setDimensions({ columns: 120, rows: 40 }); second.setDimensions({ columns: 120, rows: 40 });
    const provider = new ReaderImageLinks(candidate => candidate === firstTerminal ? first : candidate === secondTerminal ? second : undefined);
    const line = '[log] ' + first.screen.lines.find(item => item.text.includes('[image #'))!.text;
    const query = { terminal: firstTerminal, line };
    const links = provider.provideTerminalLinks(query, linkCancellation.token);
    assert.equal(links.length, 1);
    assert.match(links[0].tooltip!, /illustration/);
    await provider.handleTerminalLink(links[0]);
    assert.equal(firstOpens, 1); assert.equal(secondOpens, 0);
    let imageTab: vscode.Tab | undefined;
    await until(() => {
      imageTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.path.endsWith('.png'));
      return !!imageTab;
    });
    assert.ok(imageTab && imageTab.input instanceof vscode.TabInputCustom);
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(imageTab.input.uri)), png);
    await vscode.window.tabGroups.close(imageTab);
    await provider.handleTerminalLink(provider.provideTerminalLinks({ terminal: secondTerminal, line }, linkCancellation.token)[0]);
    assert.equal(secondOpens, 1);
    const stale = provider.provideTerminalLinks(query, linkCancellation.token)[0];
    first.goTo({ chapter: 1, offset: 0 });
    await provider.handleTerminalLink(stale); assert.equal(firstOpens, 1, 'Navigation invalidates links from previous frames');
    first.goTo({ chapter: 0, offset: 0 });
    const hidden = provider.provideTerminalLinks(query, linkCancellation.token)[0];
    first.hide();
    assert.deepEqual(provider.provideTerminalLinks(query, linkCancellation.token), []);
    await provider.handleTerminalLink(hidden); assert.equal(firstOpens, 1);
    first.resume();
    const closed = provider.provideTerminalLinks(query, linkCancellation.token)[0];
    first.close(); await provider.handleTerminalLink(closed); assert.equal(firstOpens, 1);
    assert.deepEqual(provider.provideTerminalLinks({ terminal, line }, linkCancellation.token), []);
    const cancellation = new vscode.CancellationTokenSource(); cancellation.cancel();
    assert.deepEqual(provider.provideTerminalLinks({ terminal: secondTerminal, line }, cancellation.token), []);
    cancellation.dispose();
  } finally { linkCancellation.dispose(); first.close(); second.close(); firstTerminal.dispose(); secondTerminal.dispose(); }
  // Exercise real extension activation, worker, terminal creation, and resume command.
  const sample = vscode.Uri.joinPath(extension.extensionUri, 'samples', 'alice-in-wonderland.epub');
  const previous = new Set(vscode.window.terminals);
  await vscode.commands.executeCommand('vscodeReader.openBook', sample);
  const created = vscode.window.terminals.find(t => !previous.has(t));
  assert.ok(created, 'Open Book should create a real terminal');
  assert.match(created.name, /Alice/);
  assert.equal((created.creationOptions as vscode.ExtensionTerminalOptions).isTransient, true);
  await vscode.commands.executeCommand('vscodeReader.hide');
  await vscode.commands.executeCommand('vscodeReader.resume');
  assert.ok(vscode.window.terminals.includes(created));
  await vscode.commands.executeCommand('vscodeReader.openBook', sample);
  assert.equal(vscode.window.terminals.filter(t => !previous.has(t)).length, 1, 'Opening twice reuses the terminal');
  created.show();
  await until(() => vscode.window.activeTerminal === created);
  await vscode.commands.executeCommand('workbench.action.terminal.kill');
  await until(() => !vscode.window.terminals.includes(created));
  assert.ok(created.exitStatus, 'Trash action should finish the terminal lifecycle');
  await vscode.commands.executeCommand('vscodeReader.resume');
  const reopened = vscode.window.terminals.find(t => !previous.has(t));
  assert.ok(reopened, 'Resume reopens the last closed book');
  reopened.sendText('q', false);
  await until(() => !vscode.window.terminals.includes(reopened));
  assert.equal(reopened.exitStatus?.code, 0, 'q should close the terminal cleanly');
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
  await vscode.workspace.fs.writeFile(persistenceUri, Buffer.from(Array.from({ length: 800 }, (_, i) => `Paragraph ${i}: persistent reading position and bookmarks.`).join('\n')));
  await vscode.commands.executeCommand('vscodeReader.openBook', persistenceUri);
  const middle = await vscode.commands.executeCommand<Status>('vscodeReader.goToLocation', '50%');
  const savedBookmark = await vscode.commands.executeCommand('vscodeReader.addBookmark', 'Middle checkpoint');
  assert.ok(savedBookmark);
  await vscode.commands.executeCommand('vscodeReader.renameBookmark', { position: middle.position }, 'Renamed checkpoint');
  await vscode.commands.executeCommand('vscodeReader.goToLocation', '75%');
  const discarded = await vscode.commands.executeCommand<Status>('vscodeReader.showProgress');
  await vscode.commands.executeCommand('vscodeReader.addBookmark', 'Temporary checkpoint');
  await vscode.commands.executeCommand('vscodeReader.deleteBookmark', { position: discarded.position });
  await vscode.commands.executeCommand('vscodeReader.goToBookmark', { position: middle.position });
  const expected = await vscode.commands.executeCommand<Status>('vscodeReader.showProgress');
  assert.deepEqual(expected.position, middle.position);
  assert.equal(expected.bookmarks.length, 1); assert.equal(expected.bookmarks[0].label, 'Renamed checkpoint');
  await vscode.workspace.fs.writeFile(expectedUri, Buffer.from(JSON.stringify(expected)));
  // The test runner terminates the host instead of doing a normal shutdown.
  // Observe completed autosave files before allowing it to exit; the next
  // process verifies that real startup restores those exact persisted values.
  const source = await vscode.workspace.fs.readFile(persistenceUri);
  const hash = createHash('sha256').update(source).digest('hex');
  const key = 'book.v1.' + createHash('sha256').update(persistenceUri.toString()).update('\0').update(hash).update('utf-8').digest('hex');
  let durable = false;
  for (let i = 0; i < 100; i++) {
    try {
      const saved = JSON.parse(await readFile(join(process.env.READER_TEST_STORAGE!, key + '.json'), 'utf8'));
      const last = JSON.parse(await readFile(join(process.env.READER_TEST_STORAGE!, 'lastBook.json'), 'utf8'));
      durable = saved.chapter === expected.position.chapter && saved.offset === expected.position.offset && JSON.stringify(saved.bookmarks) === JSON.stringify(expected.bookmarks) && last.uri === persistenceUri.toString();
      if (durable) break;
    } catch { /* Autosave may still be committing. */ }
    await pause(50);
  }
  assert.ok(durable, 'Navigation and bookmark edits should autosave to durable files');
  console.log('VS Code host checks passed: formats, image tabs, library view, paging, progress and bookmark CRUD.');
}
