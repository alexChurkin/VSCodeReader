import type { Book, Locator } from './book';

export const LOCATION_SIZE = 1000;
export interface ReadingProgress {
  chapter: number; chapters: number;
  screen: number; screens: number;
  location: number; locations: number;
  percent: number;
}
const indexes = new WeakMap<Book, { sizes: number[]; starts: number[]; total: number }>();
function indexFor(book: Book) {
  let index = indexes.get(book);
  if (!index) {
    const sizes = book.chapters.map(chapter => Math.max(1, chapter.text.length));
    const starts: number[] = []; let total = 0;
    for (const size of sizes) { starts.push(total); total += size; }
    index = { sizes, starts, total }; indexes.set(book, index);
  }
  return index;
}
export function locatorAtOffset(book: Book, offset: number): Locator {
  const { sizes, starts, total } = indexFor(book);
  const absolute = Math.max(0, Math.min(total - 1, Math.floor(offset)));
  let low = 0, high = sizes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= absolute) low = middle + 1; else high = middle;
  }
  const chapter = Math.max(0, low - 1);
  return { chapter, offset: Math.min(absolute - starts[chapter], book.chapters[chapter].text.length) };
}
export function readingProgress(book: Book, locator: Locator, row: number, rows: number, lineCount: number): ReadingProgress {
  const { sizes, starts, total } = indexFor(book);
  const absolute = starts[locator.chapter] + Math.min(locator.offset, sizes[locator.chapter] - 1);
  return {
    chapter: locator.chapter + 1, chapters: sizes.length,
    screen: Math.floor(row / Math.max(1, rows)) + 1, screens: Math.max(1, Math.ceil(lineCount / Math.max(1, rows))),
    location: Math.floor(absolute / LOCATION_SIZE) + 1, locations: Math.max(1, Math.ceil(total / LOCATION_SIZE)),
    percent: total <= 1 ? 100 : Math.round(absolute / (total - 1) * 1000) / 10
  };
}
export function parseLocation(book: Book, input: string): Locator {
  const text = input.trim().replace(',', '.');
  const total = indexFor(book).total;
  const pages = book.imagePages ? book.chapters.length : Math.max(1, Math.ceil(total / LOCATION_SIZE));
  if (/^\d+(?:\.\d+)?%$/.test(text)) {
    const percent = Number(text.slice(0, -1));
    if (percent <= 100) return book.imagePages ? { chapter: Math.round((pages - 1) * percent / 100), offset: 0 } : locatorAtOffset(book, Math.round((total - 1) * percent / 100));
  } else if (/^\d+$/.test(text)) {
    const location = Number(text);
    if (Number.isSafeInteger(location) && location >= 1 && location <= pages) return book.imagePages ? { chapter: location - 1, offset: 0 } : locatorAtOffset(book, (location - 1) * LOCATION_SIZE);
  }
  throw new Error(`Enter a page from 1 to ${pages}, or a percentage from 0% to 100%.`);
}
export function progressLabel(progress: ReadingProgress, book: Pick<Book, 'imagePages'> = {}): string {
  const page = pageProgress(book, progress);
  return `Chapter ${progress.chapter}/${progress.chapters} · Screen ${progress.screen}/${progress.screens} · Page ${page.page}/${page.pages} · ${page.percent}%`;
}

export interface PageProgress { page: number; pages: number; percent: number }
export function pageProgress(book: Pick<Book, 'imagePages'>, progress: ReadingProgress): PageProgress {
  if (book.imagePages) return { page: progress.chapter, pages: progress.chapters, percent: progress.chapters <= 1 ? 100 : Math.round((progress.chapter - 1) / (progress.chapters - 1) * 1000) / 10 };
  return { page: progress.location, pages: progress.locations, percent: progress.percent };
}
