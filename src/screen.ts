import stringWidth from 'string-width';
import { safeText, type Book, type Locator, type StyleSpan } from './book';

export interface ReadingLayout { maxTextWidth: number; horizontalPadding: number; centerText: boolean }
export interface Highlight { offset: number; length: number; active?: boolean }
export interface ImageLinkRange { startIndex: number; length: number; imageId: string }
import type { Line } from './wrap';
import { layoutChapter } from './table-layout';
export { wrap } from './wrap';
export type { Line } from './wrap';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export class Screen {
  chapter = 0;
  row = 0;
  columns = 80;
  rows = 24;
  lines: Line[] = [];
  readonly prefix: string;
  private offset = 0;
  private activeWrap = '';
  private readonly wraps = new Map<string, Line[]>();
  private cachedLineCount = 0;
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
    const key = `${this.chapter}:${this.geometry.width}`;
    if (key !== this.activeWrap) {
      const cached = this.wraps.get(key);
      this.lines = cached ?? layoutChapter(this.book.chapters[this.chapter], this.geometry.width);
      this.activeWrap = key;
      if (cached) this.wraps.delete(key);
      else this.cachedLineCount += this.lines.length;
      this.wraps.set(key, this.lines);
      while (this.wraps.size > 4 || this.cachedLineCount > 100_000) {
        const oldest = this.wraps.entries().next().value;
        if (!oldest) break;
        this.wraps.delete(oldest[0]); this.cachedLineCount -= oldest[1].length;
      }
    }
    this.offset = Math.max(0, Math.min(this.book.chapters[this.chapter].text.length, locator.offset));
    let low = 0, high = this.lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.lines[middle].offset <= this.offset) low = middle + 1; else high = middle;
    }
    this.row = Math.max(0, low - 1);
    const table = this.book.chapters[this.chapter].tables?.find(table => this.offset >= table.offset && this.offset < table.offset + table.length);
    if (table) {
      let distance = Infinity;
      for (const [index, line] of this.lines.entries()) {
        if (line.tableOffset !== table.offset) continue;
        if (!line.runs?.length && line.offset === this.offset && this.offset === table.offset) { this.row = index; break; }
        for (const run of line.runs ?? []) {
          const current = this.offset < run.offset ? run.offset - this.offset : this.offset >= run.offset + run.length ? this.offset - run.offset - run.length + 1 : 0;
          if (current < distance) { this.row = index; distance = current; }
        }
        if (!distance) break;
      }
    }
  }
  move(delta: number): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, this.row + delta));
    this.offset = this.lines[this.row]?.offset ?? 0;
  }
  scroll(delta: number): void {
    let remaining = Math.trunc(delta);
    while (remaining) {
      const direction = Math.sign(remaining);
      const available = direction > 0 ? this.lines.length - 1 - this.row : this.row;
      const step = Math.min(Math.abs(remaining), available);
      if (step) { this.move(direction * step); remaining -= direction * step; }
      if (!remaining) break;
      const next = this.chapter + direction;
      if (next < 0 || next >= this.book.chapters.length) break;
      this.nextChapter(direction);
      if (direction < 0) this.move(this.lines.length - 1);
      remaining -= direction;
    }
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
      for (const run of line.runs ?? [{ startIndex: 0, offset: line.offset, length: line.text.length }]) for (const ref of references) {
        const start = Math.max(ref.offset, run.offset);
        const end = Math.min(ref.offset + ref.length, run.offset + run.length);
        if (end > start) links.push({ startIndex: this.effectivePrefix.length + run.startIndex + start - run.offset, length: end - start, id: ref.id });
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
      .map(line => prefix + highlightLine(line, highlights, this.book.chapters[this.chapter].styles ?? [])).join('\r\n');
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

function highlightLine(line: Line, highlights: Highlight[], styles: StyleSpan[]): string {
  const runs = line.runs ?? [{ startIndex: 0, offset: line.offset, length: line.text.length }];
  const intersects = (span: { offset: number; length: number }) => runs.some(run => span.offset < run.offset + run.length && span.offset + span.length > run.offset);
  const ranges = highlights.filter(intersects), formatting = styles.filter(intersects);
  if (!ranges.length && !formatting.length) return line.text;
  let result = '', style = '';
  for (const part of segmenter.segment(line.text)) {
    const run = runs.find(run => part.index >= run.startIndex && part.index < run.startIndex + run.length);
    const start = run ? run.offset + part.index - run.startIndex : -1, end = start + part.segment.length;
    const matches = start < 0 ? [] : ranges.filter(range => range.offset < end && range.offset + range.length > start);
    const spans = start < 0 ? [] : formatting.filter(span => span.offset < end && span.offset + span.length > start);
    const codes: number[] = [];
    if (spans.some(span => span.bold)) codes.push(1);
    if (spans.some(span => span.italic)) codes.push(3);
    if (spans.some(span => span.underline) || matches.some(match => !match.active)) codes.push(4);
    if (spans.some(span => span.strike)) codes.push(9);
    if (matches.some(match => match.active)) codes.push(7);
    const next = codes.length ? `\x1b[${codes.join(';')}m` : '';
    if (next !== style) { result += '\x1b[0m' + next; style = next; }
    result += part.segment;
  }
  return result + (style ? '\x1b[0m' : '');
}
