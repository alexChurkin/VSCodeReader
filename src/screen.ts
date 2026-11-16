import stringWidth from 'string-width';
import { safeText, type Book, type Locator } from './book';

export interface ImageLinkRange { startIndex: number; length: number; imageId: string }
export interface Line { text: string; offset: number }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function wrap(text: string, columns: number): Line[] {
  const width = Math.max(1, Math.floor(columns));
  const result: Line[] = [];
  let base = 0;
  for (const paragraph of text.split('\n')) {
    let line = '', cells = 0, start = 0, lastSpace = -1;
    if (!paragraph) result.push({ text: '', offset: base });
    // Stream graphemes: never allocate an object per character for a huge paragraph.
    for (const part of segmenter.segment(paragraph)) {
      const size = /^[\x20-\x7e]$/.test(part.segment) ? 1 : stringWidth(part.segment);
      let broke = false;
      while (line && cells + size > width) {
        broke = true;
        if (lastSpace > 0) {
          result.push({ text: line.slice(0, lastSpace).trimEnd(), offset: base + start });
          start += lastSpace;
          line = line.slice(lastSpace);
          cells = stringWidth(line);
        } else {
          result.push({ text: line.trimEnd(), offset: base + start });
          line = ''; cells = 0; start = part.index;
        }
        lastSpace = -1;
      }
      if (broke && !line && part.segment === ' ') continue;
      if (!line) start = part.index;
      if (size > width) {
        result.push({ text: '\ufffd', offset: base + part.index });
        line = ''; cells = 0; lastSpace = -1;
        continue;
      }
      line += part.segment;
      cells += size;
      if (part.segment === ' ') lastSpace = line.length;
    }
    if (line) result.push({ text: line.trimEnd(), offset: base + start });
    base += paragraph.length + 1;
  }
  return result;
}

export class Screen {
  chapter = 0;
  row = 0;
  columns = 80;
  rows = 24;
  lines: Line[] = [];
  readonly prefix: string;
  private offset = 0;
  constructor(readonly book: Book, prefix: string, locator: Locator) {
    this.prefix = safeText(prefix).replace(/\n/g, '').slice(0, 12);
    this.go(locator);
  }
  get locator(): Locator { return { chapter: this.chapter, offset: this.offset }; }
  resize(columns: number, rows: number): void {
    const position = this.locator;
    this.columns = Math.max(1, Math.min(500, Math.floor(columns)));
    this.rows = Math.max(1, Math.min(200, Math.floor(rows)));
    this.go(position);
  }
  go(locator: Locator): void {
    this.chapter = Math.max(0, Math.min(this.book.chapters.length - 1, locator.chapter));
    this.lines = wrap(this.book.chapters[this.chapter].text, Math.max(1, this.columns - stringWidth(this.effectivePrefix) - 1));
    this.offset = Math.max(0, Math.min(this.book.chapters[this.chapter].text.length, locator.offset));
    this.row = 0;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].offset > locator.offset) break;
      this.row = i;
    }
  }
  move(delta: number): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, this.row + delta));
    this.offset = this.lines[this.row]?.offset ?? 0;
  }
  nextChapter(delta: number): void {
    const chapter = Math.max(0, Math.min(this.book.chapters.length - 1, this.chapter + delta));
    if (chapter !== this.chapter) this.go({ chapter, offset: 0 });
  }
  page(direction: number): void {
    if (direction > 0) {
      if (this.row + this.rows < this.lines.length) this.move(this.rows);
      else if (this.chapter < this.book.chapters.length - 1) this.nextChapter(1);
    } else if (this.row > 0) this.move(-this.rows);
    else if (this.chapter > 0) {
      this.nextChapter(-1);
      this.move((Math.ceil(this.lines.length / this.rows) - 1) * this.rows);
    }
  }
  private get effectivePrefix(): string { return stringWidth(this.prefix) < this.columns - 1 ? this.prefix : ''; }
  imageLinks(text: string): ImageLinkRange[] {
    const references = this.book.chapters[this.chapter].imageLinks ?? [];
    const links: ImageLinkRange[] = [];
    // VS Code supplies line text, not a buffer row number. Only use lines from
    // our current viewport and discard ambiguous wrapped fragments.
    for (const line of this.lines.slice(this.row, this.row + this.rows)) {
      if ((this.effectivePrefix + line.text).trimEnd() !== text.trimEnd()) continue;
      for (const ref of references) {
        const start = Math.max(ref.offset, line.offset);
        const end = Math.min(ref.offset + ref.length, line.offset + line.text.length);
        if (end <= start || !this.book.images?.some(image => image.id === ref.imageId)) continue;
        links.push({ startIndex: this.effectivePrefix.length + start - line.offset, length: end - start, imageId: ref.imageId });
      }
    }
    return links.filter((link, index) =>
      !links.some(other => other.imageId !== link.imageId && other.startIndex < link.startIndex + link.length && link.startIndex < other.startIndex + other.length)
      && links.findIndex(other => other.startIndex === link.startIndex && other.length === link.length && other.imageId === link.imageId) === index);
  }
  render(): string {
    // Reserve the last terminal cell to avoid wrap-pending/accidental scroll.
    const prefix = this.effectivePrefix;
    return '\x1b[H\x1b[2J' + this.lines.slice(this.row, this.row + this.rows)
      .map(line => prefix + line.text).join('\r\n');
  }
}

export function findMatches(book: Book, query: string, limit = 200): Array<Locator & { label: string }> {
  const matches: Array<Locator & { label: string }> = [];
  if (!query.trim()) return matches;
  // Unicode case-insensitive regex keeps offsets in the ORIGINAL UTF-16 text.
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const [chapter, content] of book.chapters.entries()) {
    for (const match of content.text.matchAll(expression)) {
      matches.push({ chapter, offset: match.index, label: content.text.slice(Math.max(0, match.index - 24), match.index + query.length + 64).replace(/\n/g, ' ') });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}
