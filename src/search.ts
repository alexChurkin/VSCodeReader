import { safeText, type Book, type Locator } from './book';
import { findMatches } from './screen';

export class BookSearch {
  query = '';
  matches: ReturnType<typeof findMatches> = [];
  index = -1;
  truncated = false;
  constructor(private readonly book: Book, query = '') { this.setQuery(query); }
  setQuery(query: string): void {
    this.query = safeText(query).replace(/\n/g, ' ').trim().slice(0, 256);
    this.matches = findMatches(this.book, this.query, 1001);
    this.truncated = this.matches.length > 1000;
    if (this.truncated) this.matches.pop();
    this.index = -1;
  }
  align(position: Locator): void { this.index = this.matches.findIndex(match => match.chapter === position.chapter && match.offset === position.offset); }
  next(position: Locator, direction: number): Locator | undefined {
    if (!this.matches.length) return undefined;
    const current = this.matches[this.index];
    if (current && current.chapter === position.chapter && current.offset === position.offset) {
      this.index = (this.index + direction + this.matches.length) % this.matches.length;
    } else if (direction > 0) {
      this.index = this.matches.findIndex(match => match.chapter > position.chapter || (match.chapter === position.chapter && match.offset >= position.offset));
      if (this.index < 0) this.index = 0;
    } else {
      this.index = -1;
      for (let index = this.matches.length - 1; index >= 0; index--) {
        const match = this.matches[index];
        if (match.chapter < position.chapter || (match.chapter === position.chapter && match.offset <= position.offset)) { this.index = index; break; }
      }
      if (this.index < 0) this.index = this.matches.length - 1;
    }
    return this.matches[this.index];
  }
  highlights(chapter: number) {
    return this.matches.flatMap((match, index) => match.chapter === chapter ? [{ offset: match.offset, length: match.length, active: index === this.index }] : []);
  }
  get status() { return { query: this.query, index: this.index + 1, count: this.matches.length, truncated: this.truncated }; }
}
