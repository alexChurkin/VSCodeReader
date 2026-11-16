import stringWidth from 'string-width';
import { safeText, type Book, type Locator } from './book';

export interface ReadingLayout { maxTextWidth: number; horizontalPadding: number; centerText: boolean }
export interface Highlight { offset: number; length: number; active?: boolean }
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
  private layout: ReadingLayout = { maxTextWidth: 0, horizontalPadding: 0, centerText: false };
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
    this.lines = wrap(this.book.chapters[this.chapter].text, this.geometry.width);
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
  setLayout(layout: Partial<ReadingLayout>): void {
    const integer = (value: number | undefined, max: number) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value!))) : 0;
    this.layout = { maxTextWidth: integer(layout.maxTextWidth, 300), horizontalPadding: integer(layout.horizontalPadding, 40), centerText: layout.centerText === true };
    this.go(this.locator);
  }
  private get geometry() {
    const padding = Math.min(this.layout.horizontalPadding, Math.floor(Math.max(0, this.columns - 2) / 2));
    const available = Math.max(1, this.columns - 1 - padding * 2);
    const prefix = stringWidth(this.prefix) < available ? this.prefix : '';
    const width = Math.max(1, Math.min(available - stringWidth(prefix), this.layout.maxTextWidth || 3000));
    const indent = padding + (this.layout.centerText ? Math.floor((available - stringWidth(prefix) - width) / 2) : 0);
    return { width, prefix: ' '.repeat(indent) + prefix };
  }
  private get effectivePrefix(): string { return this.geometry.prefix; }
  imageLinks(text: string): ImageLinkRange[] {
    const references = (this.book.chapters[this.chapter].imageLinks ?? []).filter(ref => this.book.images?.some(image => image.id === ref.imageId));
    return this.linkRanges(text, references.map(ref => ({ ...ref, id: ref.imageId }))).map(({ id, ...range }) => ({ ...range, imageId: id }));
  }
  footnoteLinks(text: string) { return this.linkRanges(text, this.book.chapters[this.chapter].footnotes ?? []); }
  private linkRanges(text: string, references: Array<{ id: string; offset: number; length: number }>) {
    const links: Array<{ startIndex: number; length: number; id: string }> = [];
    for (const line of this.lines.slice(this.row, this.row + this.rows)) {
      if ((this.effectivePrefix + line.text).trimEnd() !== text.trimEnd()) continue;
      for (const ref of references) {
        const start = Math.max(ref.offset, line.offset);
        const end = Math.min(ref.offset + ref.length, line.offset + line.text.length);
        if (end > start) links.push({ startIndex: this.effectivePrefix.length + start - line.offset, length: end - start, id: ref.id });
      }
    }
    // VS Code supplies text rather than a row number: discard ambiguous fragments.
    return links.filter((link, index) =>
      !links.some(other => other.id !== link.id && other.startIndex < link.startIndex + link.length && link.startIndex < other.startIndex + other.length)
      && links.findIndex(other => other.startIndex === link.startIndex && other.length === link.length && other.id === link.id) === index);
  }
  render(highlights: Highlight[] = []): string {
    // Reserve the last terminal cell to avoid wrap-pending/accidental scroll.
    const prefix = this.effectivePrefix;
    return '\x1b[H\x1b[2J' + this.lines.slice(this.row, this.row + this.rows)
      .map(line => prefix + highlightLine(line, highlights)).join('\r\n');
  }
}

export function findMatches(book: Book, query: string, limit = 200): Array<Locator & { label: string; length: number }> {
  const matches: Array<Locator & { label: string; length: number }> = [];
  if (!query.trim()) return matches;
  // Unicode case-insensitive regex keeps offsets in the ORIGINAL UTF-16 text.
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const [chapter, content] of book.chapters.entries()) {
    for (const match of content.text.matchAll(expression)) {
      matches.push({ chapter, offset: match.index, length: match[0].length, label: content.text.slice(Math.max(0, match.index - 24), match.index + query.length + 64).replace(/\n/g, ' ') });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

function highlightLine(line: Line, highlights: Highlight[]): string {
  const ranges = highlights.filter(range => range.offset < line.offset + line.text.length && range.offset + range.length > line.offset);
  if (!ranges.length) return line.text;
  let result = '', style = '';
  for (const part of segmenter.segment(line.text)) {
    const start = line.offset + part.index, end = start + part.segment.length;
    const matches = ranges.filter(range => range.offset < end && range.offset + range.length > start);
    const next = matches.some(range => range.active) ? '\x1b[7m' : matches.length ? '\x1b[4m' : '';
    if (next !== style) { result += '\x1b[0m' + next; style = next; }
    result += part.segment;
  }
  return result + (style ? '\x1b[0m' : '');
}
