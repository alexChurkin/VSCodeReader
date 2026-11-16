import { safeText, type Chapter } from './book';

// Remove only parser-owned markers, preserving literal text that merely looks
// like a marker. Slice the original text so copied paragraphs have no UI wraps.
export function cleanPassage(chapter: Chapter, start = 0, end = chapter.text.length): string {
  const from = Math.max(0, Math.min(chapter.text.length, start));
  const to = Math.max(from, Math.min(chapter.text.length, end));
  const ranges = (chapter.imageMarkers ?? chapter.imageLinks ?? []).filter(ref => ref.offset < to && ref.offset + ref.length > from).sort((a, b) => a.offset - b.offset);
  let result = '', cursor = from;
  for (const range of ranges) {
    const offset = Math.max(cursor, range.offset);
    result += chapter.text.slice(cursor, Math.min(to, offset));
    cursor = Math.min(to, Math.max(cursor, range.offset + range.length));
  }
  result += chapter.text.slice(cursor, to);
  return safeText(result);
}
