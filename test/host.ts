import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zip, fb2, png } from './fixtures';
import { ReaderLibrary, type LibraryBook } from '../src/library';
import type { ReadingProgress } from '../src/progress';
import { ReaderStorage } from '../src/storage';
import { ReaderTerminal } from '../src/terminal';
import { ReaderLinks } from '../src/terminal-links';
import { readMarkup } from '../src/markup';
import { readFb2 } from '../src/fb2';
import { previewImage } from '../src/image-preview';
import { CopyViews } from '../src/copy-view';
import { MOUSE_ON, MOUSE_OFF } from '../src/mouse';
import { validateImage } from '../src/images';
import { restoreState, type Book, type ReadingState } from '../src/book';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(50); }
  throw new Error('Timed out waiting for terminal.');
}
async function runChecks(): Promise<void> {
  const extension = vscode.extensions.getExtension('alexChurkin.vscode-reader');
  assert.ok(extension);
  await extension.activate();
  await vscode.commands.executeCommand('workbench.view.extension.vscodeReader');
  const installedBuild = await vscode.commands.executeCommand<{ version: string; revision: string; dirty: boolean }>('vscodeReader.buildInfo');
  const packagedBuild = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'dist', 'build-info.json'))).toString());
  assert.equal(installedBuild.version, '0.1.0'); assert.equal(installedBuild.revision, packagedBuild.revision);
  assert.match(installedBuild.revision, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_SHA) { assert.equal(installedBuild.revision, process.env.GITHUB_SHA); assert.equal(installedBuild.dirty, false); }
  assert.ok(extension.packageJSON.contributes.viewsContainers.activitybar.some((item: { icon: string }) => item.icon === 'media/book.svg'));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, 'media', 'book.svg'));
  const persistenceDirectory = vscode.Uri.joinPath(extension.extensionUri, '.vscode-test', 'reader-fixtures');
  const persistenceUri = vscode.Uri.joinPath(persistenceDirectory, 'persistence.txt');
  const expectedUri = vscode.Uri.joinPath(persistenceDirectory, 'expected-position.json');
  type Status = { position: { chapter: number; offset: number }; bookmarks: Array<{ chapter: number; offset: number; label: string }>; progress: ReadingProgress; search: { query: string; count: number; index: number }; canGoBack: boolean; canGoForward: boolean };
  if (process.env.READER_TEST_PASS === 'restore') {
    const expected = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(expectedUri)).toString()) as Status;
    await Promise.race([vscode.commands.executeCommand('vscodeReader.resume'), pause(10_000).then(() => { throw new Error('Resume did not restore the saved book.'); })]);
    const actual = await vscode.commands.executeCommand<Status>('vscodeReader.showProgress');
    console.log('Restored position:', JSON.stringify(actual.position), 'expected:', JSON.stringify(expected.position));
    assert.deepEqual(actual.position, expected.position, 'Exact position should survive a full VS Code restart');
    assert.deepEqual(actual.bookmarks, expected.bookmarks, 'Named bookmarks should survive a full VS Code restart');
    assert.equal(actual.progress.location, expected.progress.location);
    assert.equal(actual.search.query, expected.search.query);
    assert.equal(actual.search.count, expected.search.count);
    console.log('Persistence passed after a full VS Code restart: position and named bookmarks restored.');
    return;
  }
  const recoveryRoot = vscode.Uri.joinPath(extension.extensionUri, '.vscode-test', 'recovery-fixtures');
  const recoveryDirectory = vscode.Uri.joinPath(recoveryRoot, 'reading-state-v1');
  try { await vscode.workspace.fs.delete(recoveryRoot, { recursive: true }); } catch { /* First run. */ }
  await vscode.workspace.fs.createDirectory(recoveryDirectory);
  const legacy = { get: <T>(): T | undefined => undefined };
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(recoveryDirectory, 'lastBook.complete.tmp'), Buffer.from('{"uri":"file:///saved-book.epub"}'));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(recoveryDirectory, 'lastBook.partial.tmp'), Buffer.from('{"uri":'));
  assert.deepEqual(await new ReaderStorage(recoveryRoot.with({ scheme: 'vscode-userdata' }), legacy).get('lastBook'), { uri: 'file:///saved-book.epub' });
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(recoveryDirectory, 'lastBook.json'), Buffer.from('{"uri":"file:///committed-book.epub"}'));
  assert.deepEqual(await new ReaderStorage(recoveryRoot, legacy).get('lastBook'), { uri: 'file:///committed-book.epub' });
  await new ReaderStorage(recoveryRoot.with({ scheme: 'vscode-userdata' }), legacy).update('lastBook', { uri: 'file:///atomic-save.epub' });
  assert.deepEqual(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(recoveryDirectory, 'lastBook.json'))).toString()), { uri: 'file:///atomic-save.epub' });
  const book: Book = { title: 'Private title', author: '', chapters: [{ id: 'one', title: 'One', text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), anchors: {} }, { id: 'two', title: 'Two', text: 'next chapter', anchors: {} }], toc: [] };
  let saved: ReadingState | undefined;
  const copyViews = new CopyViews('vscode-reader-copy-test');
  const reader = new ReaderTerminal(book, '', restoreState(undefined, book), state => { saved = structuredClone(state); }, undefined, copyViews.open);
  let output = '', transcript = '';
  const subscription = reader.onDidWrite(data => { output = data; transcript += data; });
  const terminal = vscode.window.createTerminal({ name: 'reader-test', pty: reader });
  try {
    terminal.show();
    await until(() => output.includes('line 0'));
    assert.doesNotMatch(output, /Private title/);
    await pause(250); // Let the real terminal finish its initial viewport resize.
    reader.setDimensions({ columns: 80, rows: 6 });
    assert.equal(reader.screen.rows, 5, 'One row should be reserved for hints');
    assert.match(output, /\x1b\[6;1H\x1b\[2K\x1b\[2m/);
    assert.match(output, /\? help/);
    assert.match(output, /Page 1\/1 \| 0%/);
    assert.ok(transcript.includes(MOUSE_ON));
    reader.configureMouse(1);
    reader.handleInput('\x1b[<65;4;2M'); assert.ok(reader.snapshot.position.offset > 0);
    reader.handleInput('\x1b[<64;4;2M'); assert.equal(reader.snapshot.position.offset, 0);
    reader.handleInput('\x1b[<65;4;'); reader.handleInput('2M'); assert.ok(reader.snapshot.position.offset > 0);
    reader.handleInput('\x1b[<64;4;2M');
    // Even reports split after the first Escape must restore the provisional hide.
    reader.handleInput('\x1b'); reader.handleInput('[<0;4;2M'); assert.doesNotMatch(output, /ready/);
    const oldClipboard = await vscode.env.clipboard.readText();
    reader.setDimensions({ columns: 80, rows: 6 });
    const beforeSelection = reader.snapshot.position;
    reader.toggleSelection(); assert.ok(transcript.includes(MOUSE_OFF)); assert.match(output, /v resume/);
    const frozen = output;
    reader.setDimensions({ columns: 80, rows: 6 });
    assert.equal(output, frozen, 'Duplicate resize events must preserve selection');
    const frozenViewport = { columns: reader.screen.columns, rows: reader.screen.rows };
    reader.handleInput('\x1b[<65;4;2M'); reader.handleInput('j');
    assert.deepEqual(reader.snapshot.position, beforeSelection); assert.equal(output, frozen);
    try {
      const expectedVisible = Array.from({ length: reader.screen.rows }, (_, index) => `line ${index}`).join('\n') + '\n';
      await reader.copyVisibleText();
      assert.equal(await vscode.env.clipboard.readText(), expectedVisible);
      if (reader.screen.columns === frozenViewport.columns && reader.screen.rows === frozenViewport.rows) assert.equal(output, frozen, 'Copy confirmations must not destroy an active selection');
      reader.resume();
      await reader.openCopyView();
      await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'vscode-reader-copy-test');
      const copyEditor = vscode.window.activeTextEditor;
      assert.ok(copyEditor && copyEditor.document.uri.scheme === 'vscode-reader-copy-test');
      assert.equal(copyEditor.document.isDirty, false);
      assert.equal(copyEditor.document.getText(), book.chapters[0].text);
      assert.doesNotMatch(copyEditor.document.getText(), /Page 1\/1|v resume/);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally { await vscode.env.clipboard.writeText(oldClipboard); }
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
    assert.ok(transcript.includes(MOUSE_OFF));
    assert.equal(exits, 1, 'Close should acknowledge process exit exactly once');
    exitSubscription.dispose();
    await until(() => !vscode.window.terminals.includes(terminal));
    const resumed = new ReaderTerminal(book, '', restoreState(saved, book), () => {});
    assert.equal(resumed.screen.locator.offset, saved.offset);
    let earlyExits = 0; resumed.onDidClose(() => { earlyExits++; });
    resumed.close(); resumed.open(); resumed.open();
    assert.equal(earlyExits, 1, 'Closing before open must acknowledge exit when the process starts');
  } finally { terminal.dispose(); reader.close(); subscription.dispose(); copyViews.dispose(); }
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
    const provider = new ReaderLinks(candidate => candidate === firstTerminal ? first : candidate === secondTerminal ? second : undefined);
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
  const toolsBook = readMarkup(Buffer.from('<h1>Read</h1><p>Alpha text, alpha again. <a href="#note">[1]</a></p><h2 id="note">Footnote</h2><p>Alpha note.</p>'), 'tools.html').book;
  const tools = new ReaderTerminal(toolsBook, '> ', restoreState(undefined, toolsBook), () => {});
  let toolsOutput = '';
  const toolsOutputSubscription = tools.onDidWrite(frame => { toolsOutput = frame; });
  const toolsTerminal = vscode.window.createTerminal({ name: 'reading-tools', pty: tools });
  const toolsCancellation = new vscode.CancellationTokenSource();
  try {
    toolsTerminal.show(); await until(() => toolsOutput.includes('Alpha text'));
    tools.setDimensions({ columns: 120, rows: 16 });
    const original = tools.snapshot.position;
    tools.startSearch('alpha');
    assert.equal(tools.snapshot.search.count, 3); assert.match(toolsOutput, /\x1b\[7mAlpha/);
    const firstMatch = tools.snapshot.position;
    tools.handleInput(']'); const nextMatch = tools.snapshot.position;
    assert.ok(nextMatch.offset > firstMatch.offset);
    tools.handleInput('['); assert.deepEqual(tools.snapshot.position, firstMatch);
    tools.configureLayout({ maxTextWidth: 40, horizontalPadding: 2, centerText: true });
    assert.deepEqual(tools.snapshot.position, firstMatch);
    const provider = new ReaderLinks(candidate => candidate === toolsTerminal ? tools : undefined);
    const line = toolsOutput.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r\n').find(line => line.includes('[1]'))!;
    const note = provider.provideTerminalLinks({ terminal: toolsTerminal, line }, toolsCancellation.token).find(link => link.kind === 'footnote');
    assert.ok(note);
    await provider.handleTerminalLink(note); assert.equal(tools.snapshot.position.chapter, 1);
    tools.handleInput('u'); assert.deepEqual(tools.snapshot.position, firstMatch);
    tools.handleInput('U'); assert.equal(tools.snapshot.position.chapter, 1);
    tools.handleInput('u');
    tools.handleInput('c'); assert.equal(tools.snapshot.search.query, ''); assert.doesNotMatch(toolsOutput, /\x1b\[7m/);
    tools.handleInput('f'); await until(() => tools.snapshot.position.chapter === 1);
    tools.handleInput('u'); assert.deepEqual(tools.snapshot.position, firstMatch);
    tools.goTo(original); assert.deepEqual(tools.snapshot.position, original);
  } finally { tools.close(); toolsTerminal.dispose(); toolsOutputSubscription.dispose(); toolsCancellation.dispose(); }
  const richBook = readMarkup(Buffer.from('<style>p.Heading-2 {font-variation-settings:"wght" 700;font-size:1.333em} .weight {font-weight:bold}</style><p class="Heading-2">Publisher heading</p><p>Plain <span class="weight">emphasized text</span>.</p><table><tr><th>Name</th><th>Value</th><th>Reference</th></tr><tr><td>First row</td><td><em>Italic value</em></td><td><a href="#note">[n]</a> <img src="pic.png" alt="Picture"></td></tr></table><h2 id="note">Footnote</h2><p>Note details.</p>'), 'rich.html').book;
  const rich = new ReaderTerminal(richBook, '', restoreState(undefined, richBook), () => {}, async () => {});
  let richOutput = '';
  const richOutputSubscription = rich.onDidWrite(frame => { richOutput = frame; });
  const richTerminal = vscode.window.createTerminal({ name: 'formatted-reader', pty: rich });
  const richCancellation = new vscode.CancellationTokenSource();
  try {
    richTerminal.show(); await until(() => richOutput.includes('Publisher heading'));
    rich.setDimensions({ columns: 100, rows: 60 });
    assert.match(richOutput, /\x1b\[1;4mPublisher heading/);
    assert.match(richOutput, /\x1b\[1memphasized text/);
    const richPlain = richOutput.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.match(richPlain, /^Publisher heading/);
    assert.match(richPlain, /\r\n {4}Plain emphasized text/);
    assert.match(richOutput, /\x1b\[3mItalic value/);
    assert.match(richOutput, /\+---/);
    rich.startSearch('emphasized'); assert.match(richOutput, /\x1b\[1;7memphasized/);
    rich.clearSearch(); rich.goTo({ chapter: 0, offset: 0 });
    const provider = new ReaderLinks(candidate => candidate === richTerminal ? rich : undefined);
    const links = richOutput.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r\n').flatMap(line => provider.provideTerminalLinks({ terminal: richTerminal, line }, richCancellation.token));
    assert.ok(links.some(link => link.kind === 'image'));
    const reference = links.find(link => link.kind === 'footnote'); assert.ok(reference);
    await provider.handleTerminalLink(reference); assert.equal(rich.snapshot.position.chapter, 1);
    rich.travel(-1); assert.equal(rich.snapshot.position.chapter, 0);
    rich.setDimensions({ columns: 30, rows: 100 }); assert.match(richOutput, /Row 2/);
    const source = rich.snapshot.position;
    rich.setDimensions({ columns: 100, rows: 60 }); assert.deepEqual(rich.snapshot.position, source);
  } finally { rich.close(); richTerminal.dispose(); richOutputSubscription.dispose(); richCancellation.dispose(); }
  for (const format of ['fb2', 'md']) {
    const bytes: Buffer = await readFile(join(extension.extensionPath, 'samples', `formatting.${format}`));
    const book: Book = format === 'fb2' ? readFb2(bytes) : readMarkup(bytes, 'formatting.md').book;
    const reader: ReaderTerminal = new ReaderTerminal(book, '', restoreState(undefined, book), () => {}, async () => {});
    let frame = '';
    const subscription = reader.onDidWrite(value => { frame = value; });
    const terminal = vscode.window.createTerminal({ name: `formatting-${format}`, pty: reader });
    const cancellation = new vscode.CancellationTokenSource();
    try {
      terminal.show(); await until(() => frame.includes('Formatting playground'));
      reader.setDimensions({ columns: 120, rows: 150 });
      assert.match(frame, /\x1b\[1;4mFormatting playground/);
      assert.match(frame, /\x1b\[1;3mmixed emphasis/);
      assert.match(frame, /\x1b\[9mdeleted words/);
      assert.match(frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), /\r\n {4}Ordinary paragraph/);
      if (format === 'fb2') assert.match(frame, /named style retains/);
      const tableChapter = book.chapters.findIndex(item => item.tables?.length);
      reader.goTo({ chapter: tableChapter, offset: book.chapters[tableChapter].tables![0].offset });
      assert.match(frame, /\+---/);
      assert.match(frame, /\x1b\[1mBold cell/);
      assert.match(frame, /\x1b\[3mItalic cell/);
      const provider = new ReaderLinks(candidate => candidate === terminal ? reader : undefined);
      const links = frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\r\n').flatMap(line => provider.provideTerminalLinks({ terminal, line }, cancellation.token));
      assert.ok(links.some(link => link.kind === 'image'));
      const reference = links.find(link => link.kind === 'footnote'); assert.ok(reference);
      const position = reader.snapshot.position;
      await provider.handleTerminalLink(reference); assert.notDeepEqual(reader.snapshot.position, position);
      reader.travel(-1); assert.deepEqual(reader.snapshot.position, position);
      reader.setDimensions({ columns: 30, rows: 150 }); assert.match(frame, /Row/);
      assert.deepEqual(reader.snapshot.position, position);
    } finally { reader.close(); terminal.dispose(); subscription.dispose(); cancellation.dispose(); }
  }
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
  await vscode.commands.executeCommand('vscodeReader.find', 'Paragraph');
  const middle = await vscode.commands.executeCommand<Status>('vscodeReader.goToLocation', '50%');
  const layoutConfig = vscode.workspace.getConfiguration('vscodeReader');
  await layoutConfig.update('maxTextWidth', 20, vscode.ConfigurationTarget.Global);
  let narrowed: Status | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    narrowed = await vscode.commands.executeCommand<Status>('vscodeReader.showProgress');
    if (narrowed.progress.screens > middle.progress.screens) break;
    await pause(50);
  }
  assert.ok(narrowed && narrowed.progress.screens > middle.progress.screens);
  assert.deepEqual(narrowed.position, middle.position);
  assert.equal(narrowed.progress.location, middle.progress.location);
  await layoutConfig.update('maxTextWidth', undefined, vscode.ConfigurationTarget.Global);
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

export async function run(): Promise<void> {
  try { await runChecks(); }
  catch (error) {
    if (process.env.READER_TEST_FAILURE) await writeFile(process.env.READER_TEST_FAILURE, error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  }
}
