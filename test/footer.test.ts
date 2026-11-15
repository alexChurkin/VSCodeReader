import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { footerText, fitCells, terminalName, type HintMode } from '../src/footer';

test('footer adapts to reading, hidden, modal and loading states', () => {
  const reading = footerText({ mode: 'reading', columns: 220, images: true, bookmarks: true });
  for (const hint of ['Space', 'g contents', '/ search', 'b bookmark', 'B bookmarks', 'i images', 'Esc hide', 'q close']) assert.ok(reading.includes(hint), hint);
  const plain = footerText({ mode: 'reading', columns: 220 });
  assert.doesNotMatch(plain, /i images|B bookmarks/);
  assert.match(footerText({ mode: 'hidden', columns: 80 }), /r resume/);
  assert.match(footerText({ mode: 'search', columns: 80 }), /Search text.*Enter confirm.*Esc cancel/);
  assert.match(footerText({ mode: 'location', columns: 80 }), /40%/);
  assert.match(footerText({ mode: 'name', columns: 80 }), /Bookmark name/);
  assert.match(footerText({ mode: 'image-loading', columns: 80 }), /Opening image/);
  assert.match(footerText({ mode: 'reading', columns: 220, end: true }), /End of book/);
  assert.match(footerText({ mode: 'reading', columns: 80, message: 'Bookmark saved' }), /^Bookmark saved/);
});
test('hint lines never use the last terminal cell or split graphemes', () => {
  const modes: HintMode[] = ['reading', 'hidden', 'picker', 'search', 'location', 'name', 'image-loading'];
  for (const columns of [1, 2, 8, 20, 40, 80, 220]) for (const mode of modes) {
    assert.ok(stringWidth(footerText({ mode, columns, images: true, bookmarks: true })) <= Math.max(0, columns - 1));
    assert.ok(stringWidth(footerText({ mode, columns, message: 'Saved 中文 👩‍💻' })) <= Math.max(0, columns - 1));
  }
  assert.equal(fitCells('e\u0301 text', 2), 'e\u0301…');
  assert.doesNotMatch(fitCells('\x1b[2J\nmessage', 20), /\x1b|\n/);
});
test('terminal tabs use book titles with custom templates and old default migration', () => {
  assert.equal(terminalName('{title}', 'Alice', 'alice.epub'), 'Alice');
  assert.equal(terminalName('output', 'Alice', 'alice.epub'), 'Alice');
  assert.equal(terminalName('Read: {title} ({filename})', 'Alice', 'alice.epub'), 'Read: Alice (alice.epub)');
  assert.equal(terminalName('{title}', '', 'file.txt'), 'file.txt');
  assert.doesNotMatch(terminalName('{title}', '\x1b[2J\nTitle', 'file.txt'), /\x1b|\n/);
});
