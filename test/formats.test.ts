import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readBook, extractImage, readTxt, supportedBook } from '../src/formats';
import { readFb2 } from '../src/fb2';
import { decodeXml } from '../src/encoding';
import { validateImage } from '../src/images';
import { zip } from './fixtures';

import { png, fb2 } from './fixtures';

test('FB2 metadata, nested TOC, notes, poetry and image references', async () => {
  const result = await readBook(Buffer.from(fb2), { filename: 'test.fb2' });
  assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
  const book = result.book;
  assert.equal(book.title, 'Тестовая книга'); assert.equal(book.author, 'Иван Автор');
  assert.equal(book.chapters.length, 3);
  assert.equal(book.toc[1].depth, 1);
  assert.ok(book.toc[1].offset > 0);
  assert.match(book.chapters[0].text, /После вложенной главы/);
  assert.match(book.chapters[0].text, /Строка первая\n/);
  assert.match(book.chapters[2].text, /Текст примечания/);
  assert.doesNotMatch(book.chapters[0].text, /iVBOR/);
  assert.deepEqual(book.images?.[0].chapters, [0]);
  const image = await extractImage(Buffer.from(fb2), { filename: 'test.fb2' }, 'picture');
  assert.equal(image.width, 1); assert.equal(image.height, 1); assert.deepEqual(Buffer.from(image.bytes), png);
});
test('FB2 Windows-1251 declaration, UTF-16 BOM, malformed XML and missing body', () => {
  const template = '<?xml version="1.0" encoding="windows-1251"?><FictionBook><body><section><p>';
  const bytes = Buffer.concat([Buffer.from(template), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('</p></section></body></FictionBook>')]);
  assert.match(readFb2(bytes).chapters[0].text, /Привет/);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fb2.replace('UTF-8', 'UTF-16'), 'utf16le')]);
  assert.equal(readFb2(utf16).title, 'Тестовая книга');
  assert.equal(decodeXml(Buffer.from('<root/>')), '<root/>');
  assert.throws(() => readFb2(Buffer.from('<FictionBook/>')), /readable body/);
  assert.throws(() => readFb2(Buffer.from('<FictionBook>')), /Invalid XML/);
  assert.throws(() => readFb2(Buffer.from('<html/>')), /FictionBook/);
  assert.throws(() => readFb2(Buffer.from('<!DOCTYPE FictionBook [<!ENTITY x "evil">]><FictionBook/>')), /DTD/);
});
test('FB2.ZIP selection, independent entries, single FBZ and image extraction', async () => {
  const bytes = zip([['folder/a.fb2', fb2], ['b.fb2', fb2.replace('Тестовая книга', 'Другая книга')], ['readme.txt', 'ignored']]);
  const choose = await readBook(bytes, { filename: 'two.fb2.zip' });
  assert.equal(choose.kind, 'selection'); if (choose.kind !== 'selection') return;
  assert.deepEqual(choose.entries, ['folder/a.fb2', 'b.fb2']);
  const b = await readBook(bytes, { filename: 'two.fb2.zip', entry: 'b.fb2' });
  assert.equal(b.kind, 'book'); if (b.kind === 'book') { assert.equal(b.entry, 'b.fb2'); assert.equal(b.book.title, 'Другая книга'); }
  const single = await readBook(zip([['a.fb2', fb2]]), { filename: 'single.fbz' });
  assert.equal(single.kind, 'book');
  const image = await extractImage(bytes, { filename: 'two.fb2.zip', entry: 'folder/a.fb2' }, 'picture');
  assert.equal(image.extension, 'png');
  await assert.rejects(readBook(bytes, { filename: 'two.fb2.zip', entry: '../a.fb2' }), /Unsafe/);
  await assert.rejects(readBook(bytes, { filename: 'two.fb2.zip', entry: 'missing.fb2' }), /not present/);
  await assert.rejects(readBook(zip([['readme.txt', 'text']]), { filename: 'none.fb2.zip' }), /no FB2/);
  await assert.rejects(readBook(bytes, { filename: 'ordinary.zip' }), /Unsupported/);
});
test('TXT UTF-8, Windows-1251 and UTF-16 BOM, chunking, controls and empty text', () => {
  const text = readTxt(Buffer.from('Hello\r\n\r\nПривет\x1b[2J'), 'book.txt');
  assert.match(text.chapters[0].text, /Hello\n\nПривет/); assert.doesNotMatch(text.chapters[0].text, /\x1b/);
  assert.equal(readTxt(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'ru.txt', 'windows-1251').chapters[0].text, 'Привет');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Текст', 'utf16le')]);
  assert.equal(readTxt(utf16, 'utf16.txt').chapters[0].text, 'Текст');
  const long = ('A long paragraph 👩‍💻\n\n').repeat(8000);
  const book = readTxt(Buffer.from(long), 'long.txt');
  assert.ok(book.chapters.length > 1); assert.equal(book.chapters.map(c => c.text).join(''), long);
  assert.equal(book.toc.length, book.chapters.length);
  assert.throws(() => readTxt(Buffer.from([0xff, 0x80]), 'bad.txt'), /Cannot decode/);
  assert.throws(() => readTxt(Buffer.from('  \n'), 'empty.txt'), /empty/);
});
test('CBZ pages sort numerically and select raster images only', async () => {
  const bytes = zip([['page10.png', png], ['page2.png', png], ['script.svg', '<svg/>'], ['page1.png', png]]);
  const result = await readBook(bytes, { filename: 'comic.cbz' });
  assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
  assert.deepEqual(result.book.chapters.map(c => c.id), ['page1.png', 'page2.png', 'page10.png']);
  assert.deepEqual(result.book.images?.[1].chapters, [1]);
  assert.deepEqual(Buffer.from((await extractImage(bytes, { filename: 'comic.cbz' }, 'page2.png')).bytes), png);
});
test('EPUB sample images can be extracted on demand', async () => {
  const bytes = await readFile('samples/alice-in-wonderland.epub');
  const result = await readBook(bytes, { filename: 'alice.epub' });
  assert.equal(result.kind, 'book'); if (result.kind !== 'book') return;
  assert.ok(result.book.images && result.book.images.length > 0);
  const image = await extractImage(bytes, { filename: 'alice.epub' }, result.book.images![0].id);
  assert.ok(image.width > 0); assert.equal(image.extension, 'jpg');
});
test('image validation rejects SVG, spoofed formats, huge dimensions and malformed base64', async () => {
  assert.throws(() => validateImage(Buffer.from('<svg onload="evil()"/>')), /Unsupported/);
  const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16);
  assert.throws(() => validateImage(huge), /oversized/);
  await assert.rejects(extractImage(Buffer.from(fb2.replace(png.toString('base64'), '%%%')), { filename: 'bad.fb2' }, 'picture'), /base64/);
  await assert.rejects(extractImage(Buffer.from(fb2), { filename: 'bad.fb2' }, 'missing'), /missing/);
  assert.equal(supportedBook('a.FB2.ZIP'), true); assert.equal(supportedBook('a.fbz'), true); assert.equal(supportedBook('a.zip'), false);
});
