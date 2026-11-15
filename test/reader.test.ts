import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import stringWidth from 'string-width';
import { Archive, LIMITS, archivePath, resolveHref } from '../src/archive';
import { readEpub } from '../src/epub';
import { safeText, restoreState, type Book } from '../src/book';
import { Screen, wrap, findMatches } from '../src/screen';
import { xml, chapterText } from '../src/xml';
import { epub, zip } from './fixtures';

const book: Book = { title: 'Test', author: '', chapters: [{ id: 'one', title: 'One', text: 'alpha beta gamma delta\n\n中文 e\u0301 👩‍💻\nAlice ALICE', anchors: {} }, { id: 'two', title: 'Two', text: 'alice in chapter two', anchors: {} }], toc: [] };

test('EPUB reading order follows spine, not ZIP/manifest order, with nav anchors', async () => {
  const b = await readEpub(epub());
  assert.equal(b.title, 'Test book'); assert.equal(b.author, 'Author');
  assert.equal(b.chapters.length, 2); assert.match(b.chapters[0].text, /Alice/);
  assert.match(b.chapters[0].text, /Intro & text/);
  assert.match(b.chapters[0].text, /\[image: rabbit\]/);
  assert.doesNotMatch(b.chapters[0].text, /bad\(\)/);
  assert.equal(b.toc[0].title, 'First entry');
  assert.equal(b.chapters[0].text.slice(b.toc[0].offset, b.toc[0].offset + 13), 'First chapter');
});
test('EPUB 2 NCX fallback and non-Latin text', async () => {
  const b = await readEpub(epub('2.0', { nav: false }));
  assert.equal(b.toc[0].title, 'NCX First'); assert.match(b.chapters[1].text, /中文/);
});
test('real Gutenberg EPUB opens, contains Alice and chapter navigation', async () => {
  const b = await readEpub(await readFile('samples/alice-in-wonderland.epub'));
  assert.match(b.title, /Alice/); assert.ok(b.chapters.length >= 12);
  assert.ok(b.toc.length >= 12);
  assert.ok(b.chapters.some(c => /White Rabbit/i.test(c.text)));
  console.log(`Sample: ${b.chapters.length} spine items, ${b.toc.length} TOC entries`);
});
test('rejects invalid archives, fixed layout, malformed XML, DTD and entities', async () => {
  await assert.rejects(readEpub(Buffer.from('not a zip')));
  await assert.rejects(readEpub(epub('3.0', { fixed: true })), /Fixed-layout/);
  assert.throws(() => xml('<broken>'), /Invalid XML/);
  assert.doesNotThrow(() => xml('<!DOCTYPE ncx PUBLIC \"-//NISO//DTD ncx 2005-1//EN\" \"http://www.daisy.org/z3986/2005/ncx-2005-1.dtd\"><ncx/>'));
  assert.throws(() => xml('<!DOCTYPE html [<!ENTITY x \"evil\">]><html>&x;</html>'), /DTD/);
  assert.throws(() => xml('<!DOCTYPE book SYSTEM "file:///etc/passwd"><book/>'), /DTD/);
  assert.throws(() => xml('<!DOCTYPE book [<!ENTITY x "evil">]><book>&x;</book>'), /DTD/);
});
test('rejects traversal, duplicate paths, oversize entries and false ZIP sizes', async () => {
  for (const path of ['../evil', '/evil', 'C:/evil', 'a\\evil', 'a/../evil']) assert.throws(() => archivePath(path));
  assert.throws(() => resolveHref('OPS/book.opf', '../../evil'));
  assert.throws(() => resolveHref('OPS/book.opf', '%2e%2e/%2e%2e/evil'));
  assert.throws(() => resolveHref('OPS/book.opf', 'https://example.com/x'));
  assert.equal(resolveHref('OPS/chapter/a.xhtml', '../b.xhtml#id').path, 'OPS/b.xhtml');
  await assert.rejects(Archive.open(zip([['../evil', 'x']])));
  await assert.rejects(Archive.open(zip([['same', 'a'], ['same', 'b']])));
  const oversized = await Archive.open(zip([['big', 'a']], LIMITS.entry + 1));
  try { await assert.rejects(oversized.read('big'), /10 MiB/); } finally { oversized.close(); }
  const lying = await Archive.open(zip([['big', 'A'.repeat(100_000)]], 1));
  try { await assert.rejects(lying.read('big')); } finally { lying.close(); }
});
test('opening can be cancelled', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readEpub(epub(), abort.signal));
});
test('book control sequences cannot reach terminal as instructions', () => {
  const attack = '\x1b]52;c;ZXZpbA==\x07\x1b[2J\x9b31m\u202eevil\x00';
  assert.doesNotMatch(safeText(attack), /[\x00-\x1f\x7f-\x9f\u202e]/);
  const chapter = chapterText(`<html><body><p>${attack}</p><iframe>no</iframe><style>hidden</style><p>yes</p></body></html>`);
  assert.doesNotMatch(chapter.text, /no|hidden|\x1b|\x07/);
});
test('wrapping respects grapheme clusters, wide cells, narrow terminals and offsets', () => {
  for (const width of [1, 2, 5, 10, 80]) {
    const text = 'one two three\n中文 e\u0301 👩‍💻';
    const lines = wrap(text, width);
    assert.ok(lines.every(l => stringWidth(l.text) <= width));
    assert.ok(lines.every((l, i) => i === 0 || l.offset > lines[i - 1].offset));
    assert.ok(lines.some(l => l.text.includes('e\u0301')));
  }
  assert.deepEqual(wrap('one two', 4).map(l => l.text), ['one', 'two']);
  assert.deepEqual(wrap('long text', 4).map(l => l.text), ['long', 'text']);
  assert.equal(wrap('a'.repeat(100_000), 80).length, 1250);
});
test('position remains tied to text after resize and chapters remain bounded', () => {
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  screen.resize(12, 3); screen.move(2);
  const previous = screen.locator.offset;
  screen.resize(8, 2);
  assert.ok(screen.locator.offset <= previous);
  assert.ok(previous - screen.locator.offset < 10);
  screen.nextChapter(20); assert.equal(screen.chapter, 1);
  screen.nextChapter(-20); assert.equal(screen.chapter, 0);
  screen.move(-1000); assert.equal(screen.row, 0);
  screen.resize(1, 1); assert.ok(screen.render());
});
test('search is literal, Unicode aware and offsets reference original text', () => {
  assert.equal(findMatches(book, 'alice').length, 3);
  assert.equal(findMatches(book, '.*').length, 0);
  const unicode: Book = { ...book, chapters: [{ id: 'x', title: 'X', text: 'İ extra Alice', anchors: {} }] };
  const match = findMatches(unicode, 'alice')[0];
  assert.equal(unicode.chapters[0].text.slice(match.offset), 'Alice');
  assert.equal(findMatches(book, ' ', 1).length, 0);
  assert.equal(findMatches(book, 'alice', 1).length, 1);
});
test('state validation rejects version mismatches and clamps damaged locations', () => {
  assert.deepEqual(restoreState({}, book), { version: 1, chapter: 0, offset: 0, bookmarks: [] });
  const state = restoreState({ version: 1, chapter: 900, offset: 900, bookmarks: [null, { chapter: -1, offset: -1, label: '\x1bno' }] }, book);
  assert.equal(state.chapter, 1); assert.equal(state.offset, book.chapters[1].text.length);
  assert.equal(state.bookmarks.length, 1); assert.equal(state.bookmarks[0].chapter, 0);
});
