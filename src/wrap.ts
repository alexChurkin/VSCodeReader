import stringWidth from 'string-width';

export interface SourceRun { startIndex: number; offset: number; length: number }
export interface Line { text: string; offset: number; runs?: SourceRun[]; tableOffset?: number; sourceStart?: number; sourceEnd?: number }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function* graphemes(text: string) {
  if (/^[\x20-\x7e]*$/.test(text)) {
    for (let index = 0; index < text.length; index++) yield { segment: text[index], index };
  } else {
    // Keep the last grapheme for the next chunk: a chunk boundary may fall in
    // the middle of a surrogate pair, combining sequence or emoji ZWJ cluster.
    let start = 0, size = 8192;
    while (start < text.length) {
      let end = Math.min(text.length, start + size);
      if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      let previous: { segment: string; index: number } | undefined;
      for (const part of segmenter.segment(text.slice(start, end))) {
        if (previous) yield { segment: previous.segment, index: start + previous.index };
        previous = part;
      }
      if (!previous) break;
      if (end === text.length) { yield { segment: previous.segment, index: start + previous.index }; break; }
      if (previous.index === 0) size *= 2;
      else { start += previous.index; size = 8192; }
    }
  }
}
function lazyLine(source: string, start: number, length: number, base: number): Line {
  let value: string | undefined;
  return { offset: base + start, get text() { return value ??= source.slice(start, start + length); } };
}

export function wrap(text: string, columns: number, firstLineIndent = 0, continuationIndent = 0): Line[] {
  const width = Math.max(1, Math.floor(columns));
  const result: Line[] = [];
  const indent = Math.min(Math.max(0, Math.floor(firstLineIndent)), Math.max(0, width - 4));
  const continuation = Math.min(Math.max(0, Math.floor(continuationIndent)), Math.max(0, width - 4));
  let available = width - indent, indented = false;
  const emit = (line: Line) => {
    const padding = indented ? continuation : indent;
    if (padding && line.text.length) {
      result.push({ offset: line.offset, get text() { return ' '.repeat(padding) + line.text; }, runs: [{ startIndex: padding, offset: line.offset, length: line.text.length }] });
    } else result.push(line);
    if (line.text.length) indented = true;
    available = width - (indented ? continuation : indent);
  };
  const widths = new Map<string, number>();
  let base = 0;
  for (const paragraph of text.split('\n')) {
    let line = '', cells = 0, start = 0, lastSpace = -1;
    if (!paragraph) emit({ text: '', offset: base });
    // Stream graphemes: never allocate an object per character for a huge paragraph.
    for (const part of graphemes(paragraph)) {
      let size = /^[\x20-\x7e]$/.test(part.segment) ? 1 : widths.get(part.segment);
      if (size === undefined) {
        size = stringWidth(part.segment);
        if (widths.size < 1024 && part.segment.length <= 64) widths.set(part.segment, size);
      }
      let broke = false;
      while (line && cells + size > available) {
        broke = true;
        if (lastSpace > 0) {
          emit(lazyLine(paragraph, start, line.slice(0, lastSpace).trimEnd().length, base));
          start += lastSpace;
          line = line.slice(lastSpace);
          cells = stringWidth(line);
        } else {
          emit(lazyLine(paragraph, start, line.trimEnd().length, base));
          line = ''; cells = 0; start = part.index;
        }
        lastSpace = -1;
      }
      if (broke && !line && part.segment === ' ') continue;
      if (!line) start = part.index;
      if (size > available) {
        emit({ text: '\ufffd', offset: base + part.index });
        line = ''; cells = 0; lastSpace = -1;
        continue;
      }
      line += part.segment;
      cells += size;
      if (part.segment === ' ') lastSpace = line.length;
    }
    if (line) emit(lazyLine(paragraph, start, line.trimEnd().length, base));
    base += paragraph.length + 1;
  }
  return result;
}

