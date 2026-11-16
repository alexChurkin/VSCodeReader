import type { IndentedBlock } from './book';

export interface ListRange { offset: number; end: number; firstLine: number; continuation: number }

// Ranges are nested like their DOM nodes. Emit disjoint source-line blocks so
// an outer item never swallows the layout of a nested list or a table.
export function listIndents(text: string, ranges: ListRange[]): IndentedBlock[] {
  ranges.sort((a, b) => a.offset - b.offset || b.end - a.end);
  const result: IndentedBlock[] = [], active: ListRange[] = [];
  let next = 0, offset = 0;
  while (offset < text.length) {
    while (active.length && active[active.length - 1].end <= offset) active.pop();
    while (next < ranges.length && ranges[next].offset <= offset) {
      const range = ranges[next++];
      while (active.length && active[active.length - 1].end <= range.offset) active.pop();
      if (range.end > offset) active.push(range);
    }
    const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
    const item = active[active.length - 1];
    if (item && end > offset) result.push({ offset, length: Math.min(end, item.end) - offset, firstLine: offset === item.offset ? item.firstLine : item.continuation, continuation: item.continuation });
    offset = end + 1;
  }
  return result;
}

export function listNumber(value: string | undefined, fallback: number): number {
  return value !== undefined && /^-?\d+$/.test(value) ? Math.max(-1_000_000, Math.min(1_000_000, Number(value))) : fallback;
}

export function listMarker(number: number, type: string | undefined): string {
  if (number > 0 && (type === 'a' || type === 'A')) {
    let label = '', value = number;
    while (value) { value--; label = String.fromCharCode(97 + value % 26) + label; value = Math.floor(value / 26); }
    return type === 'A' ? label.toUpperCase() : label;
  }
  if (number > 0 && number < 4000 && (type === 'i' || type === 'I')) {
    let label = '', value = number;
    for (const [size, digit] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
      while (value >= size) { label += digit; value -= size; }
    }
    return type === 'i' ? label.toLowerCase() : label;
  }
  return String(number);
}
