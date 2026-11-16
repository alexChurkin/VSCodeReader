import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { footerText, fitCells, terminalName, type HintMode } from '../src/footer';

void test('footer adapts to reading, hidden, modal and loading states', () => {
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
void test('hint lines never use the last terminal cell or split graphemes', () => {
  const modes: HintMode[] = ['reading', 'hidden', 'picker', 'search', 'location', 'name', 'image-loading'];
  for (const columns of [1, 2, 8, 20, 40, 80, 220]) for (const mode of modes) {
    assert.ok(stringWidth(footerText({ mode, columns, images: true, bookmarks: true })) <= Math.max(0, columns - 1));
    assert.ok(stringWidth(footerText({ mode, columns, message: 'Saved 中文 👩‍💻' })) <= Math.max(0, columns - 1));
  }
  assert.equal(fitCells('e\u0301 text', 2), 'e\u0301…');
  assert.doesNotMatch(fitCells('\x1b[2J\nmessage', 20), /\x1b|\n/);
});
void test('terminal tabs use book titles with custom templates and old default migration', () => {
  assert.equal(terminalName('{title}', 'Alice', 'alice.epub'), 'Alice');
  assert.equal(terminalName('output', 'Alice', 'alice.epub'), 'Alice');
  assert.equal(terminalName('Read: {title} ({filename})', 'Alice', 'alice.epub'), 'Read: Alice (alice.epub)');
  assert.equal(terminalName('{title}', '', 'file.txt'), 'file.txt');
  assert.doesNotMatch(terminalName('{title}', '\x1b[2J\nTitle', 'file.txt'), /\x1b|\n/);
});

void test('page status remains visible ahead of hints and feedback, including narrow terminals', () => {
  const progress = { page: 12, pages: 47, percent: 24.3 };
  for (const mode of ['reading', 'search', 'location', 'picker', 'image-loading'] as HintMode[]) {
    const line = footerText({ mode, columns: 100, progress, message: 'Bookmark saved', images: true, bookmarks: true });
    assert.match(line, /Page 12\/47 \| 24\.3%$/);
    assert.ok(stringWidth(line) < 100);
  }
  assert.match(footerText({ mode: 'reading', columns: 25, progress, message: 'A very long notification that must not displace the page counter' }), /Page 12\/47 \| 24\.3%$/);
  assert.equal(footerText({ mode: 'reading', columns: 12, progress }), 'Page 12/47');
  assert.equal(footerText({ mode: 'reading', columns: 8, progress }), '12/47');
  assert.doesNotMatch(footerText({ mode: 'hidden', columns: 100, progress }), /Page|24\.3%/);
  for (const columns of [1, 2, 5, 8, 12, 25, 80]) assert.ok(stringWidth(footerText({ mode: 'reading', columns, progress, message: 'Saved 中文 👩‍💻' })) <= Math.max(0, columns - 1));
});

void test('search, history and footnote hints preserve the page counter at every width', () => {
  const progress = { page: 12, pages: 47, percent: 24.3 };
  const search = { query: 'Alice', index: 2, count: 10, truncated: false };
  assert.match(footerText({ mode: 'reading', columns: 100, search, progress }), /Find 2\/10.*\[.*\].*c clear/);
  assert.match(footerText({ mode: 'reading', columns: 100, history: true, progress }), /u back.*U forward/);
  assert.match(footerText({ mode: 'reading', columns: 100, footnotes: true, progress }), /f footnotes/);
  for (const columns of [2, 5, 12, 25, 80, 200]) {
    const line = footerText({ mode: 'reading', columns, progress, search, history: true, footnotes: true });
    assert.ok(stringWidth(line) < columns);
    if (columns >= 25) assert.match(line, /Page 12\/47 \| 24\.3%$/);
  }
});
