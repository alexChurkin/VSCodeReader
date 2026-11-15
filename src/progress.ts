import type { Book, Locator } from './book';

export const LOCATION_SIZE = 1000;
export interface ReadingProgress {
  chapter: number; chapters: number;
  screen: number; screens: number;
  location: number; locations: number;
  percent: number;
}
function lengths(book: Book): number[] { return book.chapters.map(c => Math.max(1, c.text.length)); }
export function locatorAtOffset(book: Book, offset: number): Locator {
  const sizes = lengths(book);
  let remaining = Math.max(0, Math.min(sizes.reduce((a, b) => a + b, 0) - 1, Math.floor(offset)));
  for (let chapter = 0; chapter < sizes.length; chapter++) {
    if (remaining < sizes[chapter]) return { chapter, offset: Math.min(remaining, book.chapters[chapter].text.length) };
    remaining -= sizes[chapter];
  }
  return { chapter: 0, offset: 0 };
}
export function readingProgress(book: Book, locator: Locator, row: number, rows: number, lineCount: number): ReadingProgress {
  const sizes = lengths(book), total = sizes.reduce((a, b) => a + b, 0);
  const absolute = sizes.slice(0, locator.chapter).reduce((a, b) => a + b, 0) + Math.min(locator.offset, sizes[locator.chapter] - 1);
  return {
    chapter: locator.chapter + 1, chapters: sizes.length,
    screen: Math.floor(row / Math.max(1, rows)) + 1, screens: Math.max(1, Math.ceil(lineCount / Math.max(1, rows))),
    location: Math.floor(absolute / LOCATION_SIZE) + 1, locations: Math.max(1, Math.ceil(total / LOCATION_SIZE)),
    percent: total <= 1 ? 100 : Math.round(absolute / (total - 1) * 1000) / 10
  };
}
export function parseLocation(book: Book, input: string): Locator {
  const text = input.trim().replace(',', '.');
  const total = lengths(book).reduce((a, b) => a + b, 0);
  if (/^\d+(?:\.\d+)?%$/.test(text)) {
    const percent = Number(text.slice(0, -1));
    if (percent <= 100) return locatorAtOffset(book, Math.round((total - 1) * percent / 100));
  } else if (/^\d+$/.test(text)) {
    const location = Number(text), max = Math.max(1, Math.ceil(total / LOCATION_SIZE));
    if (Number.isSafeInteger(location) && location >= 1 && location <= max) return locatorAtOffset(book, (location - 1) * LOCATION_SIZE);
  }
  throw new Error(`Enter a location from 1 to ${Math.max(1, Math.ceil(total / LOCATION_SIZE))}, or a percentage from 0% to 100%.`);
}
export function progressLabel(progress: ReadingProgress): string {
  return `Chapter ${progress.chapter}/${progress.chapters} · Screen ${progress.screen}/${progress.screens} · Location ${progress.location}/${progress.locations} · ${progress.percent}%`;
}
