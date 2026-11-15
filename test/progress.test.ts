import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen } from '../src/screen';
import { parseLocation, readingProgress, progressLabel, pageProgress } from '../src/progress';
import type { Book } from '../src/book';

const book: Book = { title: 'Progress', author: '', chapters: [
  { id: 'first', title: 'First', text: 'a'.repeat(1500), anchors: {} },
  { id: 'second', title: 'Second', text: 'b'.repeat(2500), anchors: {} }
], toc: [] };

test('stable locations and percentages span chapter boundaries', () => {
  assert.deepEqual(parseLocation(book, '1'), { chapter: 0, offset: 0 });
  assert.deepEqual(parseLocation(book, '3'), { chapter: 1, offset: 500 });
  assert.deepEqual(parseLocation(book, '100%'), { chapter: 1, offset: 2499 });
  assert.deepEqual(parseLocation(book, '0%'), { chapter: 0, offset: 0 });
  assert.deepEqual(parseLocation(book, '50%'), { chapter: 1, offset: 500 });
  assert.ok(parseLocation(book, '12,5%').offset > 0);
  for (const input of ['0', '5', '-1', '101%', 'nope', '1.5', '1e3', '']) assert.throws(() => parseLocation(book, input));
  const progress = readingProgress(book, { chapter: 1, offset: 500 }, 10, 5, 21);
  assert.equal(progress.location, 3); assert.equal(progress.locations, 4);
  assert.equal(progress.screen, 3); assert.equal(progress.screens, 5);
  assert.equal(progress.percent, 50); assert.match(progressLabel(progress), /Page 3\/4/);
});
test('many resizes preserve the exact text anchor and stable location', () => {
  const screen = new Screen(book, '', { chapter: 1, offset: 1234 });
  const original = screen.locator;
  for (const [width, height] of [[90, 30], [13, 5], [180, 50], [1, 1], [80, 24]]) {
    screen.resize(width, height);
    assert.deepEqual(screen.locator, original);
    assert.equal(readingProgress(book, screen.locator, screen.row, screen.rows, screen.lines.length).location, 3);
  }
  screen.move(1); assert.ok(screen.locator.offset > original.offset);
});
test('screen paging crosses chapter boundaries without resetting at book edges', () => {
  const small: Book = { ...book, chapters: [
    { id: 'a', title: 'A', text: '0\n1\n2\n3\n4', anchors: {} },
    { id: 'b', title: 'B', text: '5\n6\n7', anchors: {} }
  ] };
  const screen = new Screen(small, '', { chapter: 0, offset: 0 });
  screen.resize(20, 2);
  screen.page(1); assert.equal(screen.row, 2);
  screen.page(1); assert.equal(screen.row, 4);
  screen.page(1); assert.equal(screen.chapter, 1); assert.equal(screen.row, 0);
  screen.page(-1); assert.equal(screen.chapter, 0); assert.equal(screen.row, 4);
  screen.go({ chapter: 1, offset: 2 }); const last = screen.locator;
  screen.nextChapter(1); assert.deepEqual(screen.locator, last);
  screen.go({ chapter: 0, offset: 2 }); const first = screen.locator;
  screen.nextChapter(-1); assert.deepEqual(screen.locator, first);
});

test('text page numbers are stable across resizes; comics count real image pages', () => {
  const screen = new Screen(book, '', { chapter: 1, offset: 500 });
  for (const [width, height] of [[80, 24], [12, 3], [140, 45]]) {
    screen.resize(width, height);
    const progress = readingProgress(book, screen.locator, screen.row, screen.rows, screen.lines.length);
    assert.deepEqual(pageProgress(book, progress), { page: 3, pages: 4, percent: 50 });
    assert.deepEqual(pageProgress({ ...book, imagePages: true }, progress), { page: 2, pages: 2, percent: 100 });
    assert.deepEqual(parseLocation({ ...book, imagePages: true }, '2'), { chapter: 1, offset: 0 });
    assert.deepEqual(parseLocation({ ...book, imagePages: true }, '100%'), { chapter: 1, offset: 0 });
  }
});
