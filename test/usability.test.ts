import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mouseInput } from '../src/mouse';
import { cleanPassage } from '../src/copy';
import { Screen, wrap } from '../src/screen';
import { readMarkup } from '../src/markup';
import { buildLabel } from '../src/build-info';

void test('mouse wheel packets handle batches, releases, modifiers and split reports without swallowing keys', () => {
  assert.deepEqual(mouseInput('\x1b[<65;30;5M\x1b[<65;30;5M'), { wheel: 2, pending: '', remainder: '' });
  assert.equal(mouseInput('\x1b[<64;30;5M')?.wheel, -1);
  assert.equal(mouseInput('\x1b[<81;30;5M')?.wheel, 1);
  for (const code of [0, 1, 2, 3, 32, 66, 67]) assert.equal(mouseInput(`\x1b[<${code};30;5M`)?.wheel, 0);
  assert.equal(mouseInput('\x1b[<65;30;5m')?.wheel, 0);
  assert.equal(mouseInput('\x1b[<65;0;5M')?.wheel, 0);
  const pending = mouseInput('\x1b[<65;30;')!;
  assert.equal(pending.pending, '\x1b[<65;30;');
  assert.equal(mouseInput(pending.pending + '5M')?.wheel, 1);
  assert.equal(mouseInput('\x1b[<65;30;5Mq')?.remainder, 'q');
  assert.equal(mouseInput('\x1b[<' + '9'.repeat(100))?.pending, '');
  assert.equal(mouseInput('q'), undefined);
});

void test('copy removes only actual image spans and preserves source paragraphs, indentation and literal markers', () => {
  const { book } = readMarkup(Buffer.from('<p>Start <img src="a.png" alt="Picture"> end.</p><pre>  keep indentation\n    code</pre><p>[image #1: literal]</p><img src="https://example.com/image.png" alt="Remote"><img alt="Missing">'), 'a.html');
  const chapter = book.chapters[0];
  const clean = cleanPassage(chapter);
  assert.match(clean, /Start  end\./); assert.doesNotMatch(clean, /Picture|Remote|Missing/);
  assert.match(clean, /  keep indentation\n    code/);
  assert.match(clean, /\[image #1: literal\]/);
  const ref = chapter.imageLinks![0];
  assert.equal(cleanPassage(chapter, ref.offset + 1, ref.offset + ref.length - 1), '');
  assert.equal(cleanPassage(chapter, chapter.text.indexOf('keep'), chapter.text.indexOf('keep') + 4), 'keep');
});

void test('wrapped text is materialized lazily and repeated jumps reuse a bounded layout cache', () => {
  const text = 'A long paragraph with ordinary words and spaces. '.repeat(6000);
  const book = { title: 'Big', author: '', chapters: [{ id: 'a', title: 'A', text, anchors: {} }], toc: [] };
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  const lines = screen.lines;
  assert.equal(typeof Object.getOwnPropertyDescriptor(lines[0], 'text')?.get, 'function');
  for (let index = 0; index < 100; index++) {
    const offset = index * 1000;
    screen.go({ chapter: 0, offset });
    assert.strictEqual(screen.lines, lines);
    assert.deepEqual(screen.locator, { chapter: 0, offset });
    assert.ok(screen.lines[screen.row].offset <= offset);
    if (screen.row + 1 < screen.lines.length) assert.ok(screen.lines[screen.row + 1].offset > offset);
  }
  for (const columns of [70, 60, 50, 40, 30]) screen.resize(columns, 24);
  screen.resize(80, 24); assert.notStrictEqual(screen.lines, lines);
  assert.deepEqual(wrap('e\u0301 👩‍💻 中文', 4).map(line => line.text), ['e\u0301', '👩‍💻', '中文']);
});

void test('wheel line movement crosses chapter boundaries and clamps at book edges', () => {
  const book = { title: 'Scroll', author: '', chapters: [{ id: 'a', title: 'A', text: 'a\nb\nc', anchors: {} }, { id: 'b', title: 'B', text: 'd\ne', anchors: {} }], toc: [] };
  const screen = new Screen(book, '', { chapter: 0, offset: 0 });
  screen.scroll(3); assert.deepEqual(screen.locator, { chapter: 1, offset: 0 });
  screen.scroll(-1); assert.deepEqual(screen.locator, { chapter: 0, offset: 4 });
  screen.scroll(1000); assert.deepEqual(screen.locator, { chapter: 1, offset: 2 });
  screen.scroll(-1000); assert.deepEqual(screen.locator, { chapter: 0, offset: 0 });
});

void test('installed build labels distinguish a real commit from uncommitted local changes', () => {
  const info = { version: '0.1.0', revision: 'a'.repeat(40), builtAt: '2026-11-16T00:00:00Z', dirty: false };
  assert.equal(buildLabel(info), '0.1.0 · code aaaaaaaaaaaa');
  assert.match(buildLabel({ ...info, dirty: true }), /local changes/);
});

void test('chunked Unicode wrapping retains clusters across buffer boundaries and very long combining sequences', () => {
  const text = 'a'.repeat(8190) + 'e\u0301👩‍💻🇷🇺' + ' слово 中文 👩‍💻 e\u0301 '.repeat(1500);
  const lines = wrap(text, 80);
  const boundaries = new Set([0, text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index)]);
  assert.equal(lines.map(line => line.text).join('').replace(/ /g, ''), text.replace(/ /g, ''));
  for (const line of lines) {
    assert.equal(line.text, text.slice(line.offset, line.offset + line.text.length));
    assert.ok(boundaries.has(line.offset)); assert.ok(boundaries.has(line.offset + line.text.length));
    assert.doesNotMatch(line.text, /^[\p{Mark}\u200d\udc00-\udfff]/u);
    assert.doesNotMatch(line.text, /[\ud800-\udbff]$/u);
  }
  const cluster = 'e' + '\u0301'.repeat(20_000);
  assert.deepEqual(wrap(cluster, 80).map(line => line.text), [cluster]);
});
