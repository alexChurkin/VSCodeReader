import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { NavigationHistory } from '../src/navigation';
import { BookSearch } from '../src/search';
import { Screen } from '../src/screen';
import { restoreState, type Book } from '../src/book';
import { readMarkup } from '../src/markup';
import { readFb2 } from '../src/fb2';
import { readEpub } from '../src/epub';
import { zip } from './fixtures';

const book: Book = { title: 'Test', author: '', chapters: [
  { id: 'one', title: 'One', text: '中文 👩‍💻 Alice, alice.\nA very long line with ALICE near the end.', anchors: {} },
  { id: 'two', title: 'Two', text: 'Second Alice.', anchors: {} },
], toc: [] };
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

void test('jump history restores exact anchors, handles reading after a jump and clears branches', () => {
  const history = new NavigationHistory();
  const from = { chapter: 0, offset: 7 }, to = { chapter: 1, offset: 10 }, afterReading = { chapter: 1, offset: 30 };
  history.record(from, to);
  assert.deepEqual(history.travel(afterReading, -1), from);
  assert.deepEqual(history.travel(from, 1), afterReading);
  assert.equal(history.canGoBack, true);
  history.travel(afterReading, -1);
  history.record(from, { chapter: 2, offset: 2 });
  assert.equal(history.canGoForward, false);
  assert.deepEqual(history.travel(to, -1), from);
  history.record(from, from); assert.equal(history.canGoBack, false);
  for (let offset = 0; offset < 150; offset++) history.record({ chapter: 0, offset }, { chapter: 0, offset: offset + 1 });
  let count = 0; while (history.travel(to, -1)) count++;
  assert.equal(count, 100);
});

void test('search keeps literal Unicode offsets, cycles both ways and persists a bounded query', () => {
  const search = new BookSearch(book, 'alice');
  assert.equal(search.status.count, 4);
  const first = search.next({ chapter: 0, offset: 0 }, 1)!;
  assert.equal(book.chapters[0].text.slice(first.offset, first.offset + 5), 'Alice');
  const second = search.next(first, 1)!;
  assert.ok(second.offset > first.offset);
  assert.deepEqual(search.next(second, -1), first);
  assert.equal(search.next(first, -1)!.chapter, 1);
  assert.deepEqual(search.next(search.matches[3], 1), first);
  search.setQuery('.*'); assert.equal(search.matches.length, 0);
  search.setQuery(''); assert.deepEqual(search.highlights(0), []);
  const state = restoreState({ version: 1, bookmarks: [], searchQuery: 'alice\x1b' }, book);
  assert.equal(state.searchQuery, 'alice');
  const restored = new BookSearch(book, state.searchQuery);
  assert.equal(restored.status.count, 4); restored.align(first);
  assert.deepEqual(restored.next(first, 1), second);
  assert.equal(new BookSearch(book, 'a'.repeat(999)).query.length, 256);
  const many = new BookSearch({ ...book, chapters: [{ ...book.chapters[0], text: 'a '.repeat(1002) }] }, 'a');
  assert.equal(many.matches.length, 1000); assert.equal(many.truncated, true);
});

void test('column layout and highlighted graphemes preserve positions, link ranges and visible cell widths', () => {
  const { book } = readMarkup(Buffer.from('中文 👩‍💻 ![Picture](a.png) word '.repeat(4)), 'a.md');
  const screen = new Screen(book, '[log] ', { chapter: 0, offset: 8 });
  const original = screen.locator;
  const search = new BookSearch(book, 'word'); search.next({ chapter: 0, offset: 0 }, 1);
  for (const columns of [2, 5, 20, 80, 160]) {
    screen.resize(columns, 12);
    screen.setLayout({ maxTextWidth: 30, horizontalPadding: 2, centerText: true });
    assert.deepEqual(screen.locator, original);
    const plain = strip(screen.render());
    assert.equal(strip(screen.render(search.highlights(0))), plain);
    for (const line of plain.split('\r\n')) assert.ok(stringWidth(line) <= columns - 1, `${columns}: ${line}`);
    assert.equal(plain.includes('\x1b'), false);
  }
  screen.go({ chapter: 0, offset: 0 }); screen.resize(160, 20);
  const rendered = strip(screen.render());
  assert.match(rendered, /^ +\[log\]/);
  assert.ok(rendered.split('\r\n').some(line => screen.imageLinks(line).length > 0));
  const active = new Screen(book, '', { chapter: 0, offset: 0 }); active.resize(200, 24);
  assert.match(active.render(search.highlights(0)), /\x1b\[7mword/);
  assert.match(active.render(search.highlights(0)), /\x1b\[4mword/);
});

void test('FB2, HTML and Markdown references resolve to real anchors, including indented Markdown notes', () => {
  const fb2 = readFb2(Buffer.from('<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><body><section><p>Reading<a type="note" l:href="#note">[1]</a></p></section></body><body name="notes"><section id="note"><p>The note.</p></section></body></FictionBook>'));
  assert.equal(fb2.chapters[0].footnotes?.[0].target.chapter, 1);
  const html = readMarkup(Buffer.from('<h1>Read</h1><p>Text<a href="#note">[1]</a><a href="#missing">missing</a><a href="https://example.com/#note">external</a></p><h2 id="note">Note</h2><p>Details</p>'), 'a.html').book;
  assert.equal(html.chapters[0].footnotes?.length, 1);
  assert.equal(html.chapters[0].footnotes?.[0].target.chapter, 1);
  const md = readMarkup(Buffer.from('# Reading\n\nText[^One].\n\n## Notes\n\n[^one]: First line.\n    Second line with **bold**.\n\n`[^code]`\n\n```md\n[^fenced]: untouched\n```'), 'a.md').book;
  assert.equal(md.chapters[0].footnotes?.length, 1);
  const target = md.chapters[0].footnotes![0].target;
  assert.match(md.chapters[target.chapter].text.slice(target.offset), /\[one\][\s\S]*First line\. Second line with bold\./);
  assert.ok(md.chapters.map(chapter => chapter.text).join('').includes('[^fenced]: untouched'));
  const screen = new Screen(html, '> ', { chapter: 0, offset: 0 }); screen.resize(80, 12);
  const line = strip(screen.render()).split('\r\n').find(line => line.includes('[1]'))!;
  const links = screen.footnoteLinks(line);
  assert.equal(line.slice(links[0].startIndex, links[0].startIndex + links[0].length), '[1]');
});

void test('EPUB noterefs load note documents outside the spine and reject external or missing anchors', async () => {
  const source = zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'],
    ['book.opf', '<package version="3.0"><metadata><title>Book</title></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>'],
    ['text.xhtml', '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><p id="return">Text <a epub:type="noteref" href="notes.xhtml#note">[1]</a><a epub:type="noteref" href="https://example.com/notes#x">external</a><a href="#missing">missing</a></p></body></html>'],
    ['notes.xhtml', '<html><body><p id="note">The note. <a href="text.xhtml#return">back</a></p></body></html>'],
  ]);
  const book = await readEpub(source);
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].footnotes?.length, 1);
  assert.deepEqual(book.chapters[0].footnotes?.[0].target, { chapter: 1, offset: 0 });
  assert.deepEqual(book.chapters[1].footnotes?.[0].target, { chapter: 0, offset: 0 });
});
