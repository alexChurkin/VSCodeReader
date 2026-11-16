import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Screen } from '../src/screen';
import { readMarkup } from '../src/markup';
import { readFb2 } from '../src/fb2';
import { readBook } from '../src/formats';
import { fb2, png, zip } from './fixtures';
import type { Book } from '../src/book';

function assertReferences(book: Book): void {
  const references = book.chapters.flatMap(chapter => (chapter.imageLinks ?? []).map(ref => {
    assert.ok(book.images?.some(image => image.id === ref.imageId));
    assert.match(chapter.text.slice(ref.offset, ref.offset + ref.length), /^\[image #\d+: .+\]$/);
    return ref;
  }));
  assert.ok(references.length, 'Parser should preserve clickable image references');
}

void test('EPUB, FB2, HTML, Markdown and CBZ map markers to real image IDs', async () => {
  const epub = await readBook(await readFile('samples/alice-in-wonderland.epub'), { filename: 'sample.epub' });
  assert.equal(epub.kind, 'book'); if (epub.kind !== 'book') return;
  const comic = await readBook(zip([['page.png', png]]), { filename: 'comic.cbz' });
  assert.equal(comic.kind, 'book'); if (comic.kind !== 'book') return;
  for (const book of [epub.book, comic.book, readFb2(Buffer.from(fb2)), readMarkup(Buffer.from('<img src="a.png" alt="Picture">'), 'a.html').book, readMarkup(Buffer.from('![Picture](a.png)'), 'a.md').book]) assertReferences(book);
});

void test('identical image labels resolve independently, including Unicode and terminal prefixes', () => {
  const { book } = readMarkup(Buffer.from('<p>中文 👩‍💻 <img src="first.png" alt="Same"> <img src="second.png" alt="Same"></p>'), 'a.html');
  const screen = new Screen(book, '[log] ', { chapter: 0, offset: 0 });
  screen.resize(120, 20);
  const line = '[log] ' + screen.lines[0].text;
  const links = screen.imageLinks(line + '   ');
  assert.deepEqual(links.map(link => link.imageId), ['image-0', 'image-1']);
  assert.deepEqual(links.map(link => line.slice(link.startIndex, link.startIndex + link.length)), ['[image #1: Same]', '[image #2: Same]']);
  assert.equal(screen.imageLinks('unrelated shell output').length, 0);
});

void test('wrapped image labels remain clickable without changing text anchors or footer rows', () => {
  const { book } = readMarkup(Buffer.from('Before ![A very long description with 中文 and emoji 👩‍💻](local.png) after'), 'a.md');
  const screen = new Screen(book, '> ', { chapter: 0, offset: 0 });
  screen.resize(22, 20);
  const original = screen.locator;
  let fragments = 0;
  for (const line of screen.lines) {
    const text = '> ' + line.text;
    for (const link of screen.imageLinks(text)) {
      fragments++;
      assert.equal(link.imageId, 'image-0');
      assert.ok(link.startIndex >= 2 && link.length > 0 && link.startIndex + link.length <= text.length);
    }
  }
  assert.ok(fragments > 1);
  assert.deepEqual(screen.locator, original);
  screen.resize(22, 1);
  screen.go({ chapter: 0, offset: book.chapters[0].text.length });
  assert.deepEqual(screen.imageLinks('> Before'), []);
});

void test('remote, SVG and plain marker text do not become links', () => {
  const { book } = readMarkup(Buffer.from('[image #1: fake]\n\n![Remote](https://example.com/a.png)\n\n![SVG](a.svg)'), 'a.md');
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  assert.deepEqual(book.images, []);
  for (const line of screen.lines) assert.deepEqual(screen.imageLinks(line.text), []);
});

void test('long image markers retain their links across artificial Markdown sections', () => {
  const { book } = readMarkup(Buffer.from(`![${'description '.repeat(6000)}](local.png)`), 'a.md');
  assert.ok(book.chapters.length > 1);
  const references = book.chapters.flatMap(chapter => chapter.imageLinks ?? []);
  assert.equal(references.length, book.chapters.length);
  assert.ok(references.every(ref => ref.imageId === 'image-0'));
  assert.equal(references.reduce((sum, ref) => sum + ref.length, 0), book.chapters.map(chapter => chapter.text).join('').trimEnd().length);
});
