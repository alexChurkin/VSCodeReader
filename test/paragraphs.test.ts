import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { readMarkup } from '../src/markup';
import { Screen } from '../src/screen';
import { BookSearch } from '../src/search';
import { cleanPassage } from '../src/copy';

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

void test('headings stay flush left while only the first visual line of prose is indented', () => {
  const { book } = readMarkup(Buffer.from('<h2>Heading</h2><p>First paragraph with enough words to wrap across several lines in a narrow reading column.</p><p>Second paragraph.</p><h3>Subheading</h3>'), 'a.html');
  const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(35, 30);
  assert.equal(screen.lines.find(line => line.text.includes('Heading'))!.text, 'Heading');
  const paragraph = book.chapters[0].paragraphs![0];
  const lines = screen.lines.filter(line => line.offset >= paragraph.offset && line.offset < paragraph.offset + paragraph.length);
  assert.match(lines[0].text, /^ {4}First paragraph/);
  assert.ok(lines.length > 1);
  for (const line of lines.slice(1)) assert.doesNotMatch(line.text, /^ {4}/);
  assert.match(strip(screen.render()), /\r\n\r\n {4}Second paragraph/);
  assert.doesNotMatch(strip(screen.render()), /\r\n\r\n\r\n {4}Second/);
  const heading = book.chapters.findIndex(chapter => chapter.title === 'Subheading');
  screen.go({ chapter: heading, offset: 0 }); assert.equal(screen.lines[0].text, 'Subheading');
});

void test('lists, tables, quotes, code, verse, contents and image-only paragraphs are excluded', () => {
  const source = '<h1>Title</h1><p>Ordinary body.</p><ul><li><p>List body.</p></li></ul><ol><li><p>Numbered body.</p></li></ol><p>1. Manual item.</p><p>• Manual bullet.</p><p style="text-indent:-18px">Publisher hanging list.</p><div style="display:list-item"><p>CSS list item.</p></div><table><tr><td><p>Cell body.</p></td></tr></table><blockquote><p>Quote body.</p></blockquote><pre><p>  code</p></pre><p style="white-space:pre-wrap">  preserved code</p><div class="poetry"><p>Verse body.</p></div><nav><p>Contents body.</p></nav><div role="listitem"><p>ARIA item.</p></div><p><img src="a.png"></p>';
  const { book } = readMarkup(Buffer.from(source), 'a.html');
  const paragraphs = book.chapters.flatMap(chapter => (chapter.paragraphs ?? []).map(paragraph => chapter.text.slice(paragraph.offset, paragraph.offset + paragraph.length)));
  assert.deepEqual(paragraphs, ['Ordinary body.']);
  const screen = new Screen(book, '', { chapter: 0, offset: 0 }); screen.resize(100, 200);
  const plain = strip(screen.render());
  assert.match(plain, /- List body/); assert.match(plain, /1\. Numbered body/);
  assert.match(plain, /> Quote body/); assert.match(plain, /\| Cell body/);
});

void test('display indentation preserves source text, styled search spans, links and reading anchors', () => {
  const { book } = readMarkup(Buffer.from('<p>Before <strong>bold</strong> <a href="#note">[n]</a> <img src="a.png" alt="Image"> after.</p><h2 id="note">Footnote</h2><p>Note body.</p>'), 'a.html');
  const chapter = book.chapters[0];
  assert.match(chapter.text, /^Before/); assert.doesNotMatch(cleanPassage(chapter), /^ {4}/);
  const search = new BookSearch(book, 'bold'); const match = search.next({ chapter: 0, offset: 0 }, 1)!;
  const screen = new Screen(book, '[log] ', match); screen.resize(120, 24);
  assert.deepEqual(screen.locator, { chapter: match.chapter, offset: match.offset });
  const frame = screen.render(search.highlights(0)); assert.match(frame, /\x1b\[1;7mbold/);
  const line = strip(frame).split('\r\n').find(line => line.includes('[n]'))!;
  const footnote = screen.footnoteLinks(line)[0]; assert.equal(line.slice(footnote.startIndex, footnote.startIndex + footnote.length), '[n]');
  assert.ok(screen.imageLinks(line).length);
  for (const width of [100, 30, 8, 3]) {
    screen.resize(width, 24); assert.deepEqual(screen.locator, { chapter: match.chapter, offset: match.offset });
    for (const visible of screen.lines) assert.ok(stringWidth(visible.text) < width);
  }
});

void test('artificial chapter splits do not repeat an indent in the middle of a long paragraph', () => {
  const { book } = readMarkup(Buffer.from('<p>' + 'word '.repeat(30_000) + '</p>'), 'large.html');
  assert.ok(book.chapters.length > 1);
  assert.equal(book.chapters[0].paragraphs?.length, 1);
  assert.equal(book.chapters[1].paragraphs?.length, 0);
  const first = new Screen(book, '', { chapter: 0, offset: 0 }); assert.match(first.lines[0].text, /^ {4}word/);
  const continuation = new Screen(book, '', { chapter: 1, offset: 0 }); assert.doesNotMatch(continuation.lines[0].text, /^ {4}/);
});

void test('an explicit leading line break does not consume the paragraph indent or erase blank lines', () => {
  const { book } = readMarkup(Buffer.from('<h1>Heading</h1><p><br>Body text.</p>'), 'a.html');
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  assert.match(strip(screen.render()), /Heading\r\n\r\n\r\n {4}Body text/);
});
