export interface TxtHeading { title: string; offset: number; length: number; depth: number }

// Deliberately conservative: short, explicit chapter labels surrounded by
// blank lines. Never join or rewrite lines: poems, ASCII art and saved offsets
// must remain intact even when detection is enabled.
export function txtHeadings(text: string): TxtHeading[] {
  const headings: TxtHeading[] = [];
  const pattern = /^[ \t]*(?:(?:chapter|part|book|глава|часть|книга|раздел)[ \t]+(?:\d+|[ivxlcdm]+)(?:[. :—–-][^\n]*)?|prologue|epilogue|пролог|эпилог)[ \t]*$/gimu;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length > 120) continue;
    const start = match.index, end = start + match[0].length;
    const before = text.slice(text.lastIndexOf('\n', start - 2) + 1, Math.max(0, start - 1));
    const nextNewline = text.indexOf('\n', end + 1);
    const after = text.slice(end + 1, nextNewline < 0 ? text.length : nextNewline);
    if ((start && before.trim()) || (end < text.length && after.trim())) continue;
    const title = match[0].trim(), offset = start + match[0].indexOf(title);
    headings.push({ title, offset, length: title.length, depth: /^(?:chapter|глава)\s/iu.test(title) ? 1 : 0 });
    if (headings.length >= 5000) break;
  }
  if (!headings.some(heading => /^(?:part|book|часть|книга|раздел)\s/iu.test(heading.title))) for (const heading of headings) heading.depth = 0;
  return headings;
}
