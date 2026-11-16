export interface FootnoteReference { id: string; offset: number; length: number; label: string; target: Locator }
export interface ImageMarker { offset: number; length: number }
export interface ChapterImageLink { imageId: string; offset: number; length: number }
export interface Chapter {
  id: string;
  title: string;
  text: string;
  anchors: Record<string, number>;
  imageLinks?: ChapterImageLink[];
  imageMarkers?: ImageMarker[];
  footnotes?: FootnoteReference[];
}
export interface TocItem { title: string; chapter: number; offset: number; depth: number }
export interface BookImage {
  id: string;
  label: string;
  mediaType: string;
  chapters: number[];
}
export interface Book { title: string; author: string; chapters: Chapter[]; toc: TocItem[]; images?: BookImage[]; imagePages?: boolean }
export interface Locator { chapter: number; offset: number }
export interface Bookmark extends Locator { label: string }
export interface ReadingState extends Locator { version: 1; bookmarks: Bookmark[]; searchQuery?: string }

// Book text must never be interpreted as terminal instructions. Keep only LF
// among C0/C1 controls; normalize tabs, remove bidi overrides from untrusted text.
export function safeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function restoreState(raw: unknown, book: Book): ReadingState {
  const value = raw && typeof raw === 'object' ? raw as Partial<ReadingState> : {};
  const clamp = (p: Partial<Locator>): Locator => {
    const chapter = Number.isSafeInteger(p.chapter) ? Math.max(0, Math.min(book.chapters.length - 1, p.chapter!)) : 0;
    const offset = Number.isSafeInteger(p.offset) ? Math.max(0, Math.min(book.chapters[chapter]?.text.length ?? 0, p.offset!)) : 0;
    return { chapter, offset };
  };
  if (value.version !== 1) return { version: 1, chapter: 0, offset: 0, bookmarks: [] };
  return { version: 1, ...clamp(value), searchQuery: typeof value.searchQuery === 'string' ? safeText(value.searchQuery).replace(/\n/g, ' ').slice(0, 256) : undefined, bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks.slice(0, 500).filter((b): b is Bookmark => !!b && typeof b === 'object' && typeof b.label === 'string').map(b => ({ ...clamp(b), label: safeText(b.label).slice(0, 120) })) : [] };
}
