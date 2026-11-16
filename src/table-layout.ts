import stringWidth from 'string-width';
import type { BookTable, Chapter, TableCell } from './book';
import { wrap, type Line, type SourceRun } from './wrap';

function cellLines(chapter: Chapter, cell: TableCell, width: number): Line[] {
  return wrap(chapter.text.slice(cell.offset, cell.offset + cell.length), Math.max(1, width)).map(line => ({ text: line.text, offset: cell.offset + line.offset }));
}
function tableLines(chapter: Chapter, table: BookTable, width: number): Line[] {
  if (!table.columns || !table.rows.length) return [];
  const result: Line[] = [];
  const inner = Math.floor((width - table.columns - 1) / table.columns) - 2;
  const grid = inner >= 12 && table.columns <= 16;
  const border = grid ? '+' + Array.from({ length: table.columns }, () => '-'.repeat(inner + 2)).join('+') + '+' : '-'.repeat(Math.min(width, 32));
  const decoration = (text: string, offset: number) => result.push({ text, offset, runs: [], tableOffset: table.offset, sourceStart: offset, sourceEnd: offset });
  if (table.caption?.length) {
    for (const line of wrap(chapter.text.slice(table.caption.offset, table.caption.offset + table.caption.length), width)) result.push({ text: line.text, offset: table.caption.offset + line.offset, runs: [{ startIndex: 0, offset: table.caption.offset + line.offset, length: line.text.length }], tableOffset: table.offset, sourceStart: table.caption.offset, sourceEnd: table.caption.offset + table.caption.length });
  }
  if (grid) decoration(border, table.rows[0].offset);
  for (const [rowIndex, row] of table.rows.entries()) {
    if (grid) {
      const cells: Array<{ cell?: TableCell; column: number; span: number; lines: Line[]; width: number }> = [];
      for (let column = 0; column < table.columns;) {
        const cell = row.cells.find(cell => cell.column === column);
        const span = cell ? Math.min(table.columns - column, cell.colSpan) : 1;
        const size = inner * span + (span - 1) * 3;
        cells.push({ cell, column, span, width: size, lines: cell ? cellLines(chapter, cell, size) : [] });
        column += span;
      }
      const height = Math.max(1, ...cells.map(cell => cell.lines.length));
      for (let lineIndex = 0; lineIndex < height; lineIndex++) {
        let text = '|'; const runs: SourceRun[] = [];
        for (const cell of cells) {
          const line = cell.lines[lineIndex];
          text += ' ';
          if (line?.text) runs.push({ startIndex: text.length, offset: line.offset, length: line.text.length });
          text += (line?.text ?? '') + ' '.repeat(Math.max(0, cell.width - stringWidth(line?.text ?? ''))) + ' |';
        }
        const anchors = cells.flatMap(cell => cell.lines[lineIndex] ? [cell.lines[lineIndex].offset] : []);
        result.push({ text, offset: anchors.length ? Math.min(...anchors) : row.offset, runs, tableOffset: table.offset, sourceStart: row.offset, sourceEnd: row.end });
      }
      decoration(border, row.end);
    } else {
      const title = `Row ${rowIndex + 1}`;
      for (const line of wrap(title, width)) decoration(line.text, row.offset);
      for (const cell of row.cells) {
        const heading = table.rows[0].cells.find(header => header.column === cell.column);
        const label = rowIndex > 0 && heading?.length ? chapter.text.slice(heading.offset, heading.offset + heading.length).replace(/\s+/g, ' ') : `Column ${cell.column + 1}`;
        for (const line of wrap(label + ':', width)) decoration(line.text, cell.offset);
        const indent = width >= 4 ? '  ' : '';
        for (const line of cellLines(chapter, cell, width - indent.length)) result.push({ text: indent + line.text, offset: line.offset, runs: line.text ? [{ startIndex: indent.length, offset: line.offset, length: line.text.length }] : [], tableOffset: table.offset, sourceStart: row.offset, sourceEnd: row.end });
      }
      decoration(border, row.end);
    }
  }
  return result;
}

export function layoutChapter(chapter: Chapter, width: number): Line[] {
  const blocks = [
    ...(chapter.tables ?? []).filter(table => table.rows.length).map(table => ({ offset: table.offset, length: table.length, table })),
    ...(chapter.paragraphs ?? []).map(paragraph => ({ ...paragraph, table: undefined })),
  ].sort((a, b) => a.offset - b.offset);
  if (!blocks.length) return wrap(chapter.text, width);
  const lines: Line[] = [];
  const append = (start: number, end: number, indent = 0) => {
    if (end <= start) return;
    const text = chapter.text.slice(start, end);
    const wrapped = wrap(text, width, indent);
    if (lines.length && text.startsWith('\n') && start > 0 && chapter.text[start - 1] !== '\n') wrapped.shift();
    if (end < chapter.text.length && text.endsWith('\n')) wrapped.pop();
    for (const line of wrapped) lines.push({
      get text() { return line.text; }, offset: start + line.offset,
      ...(line.runs ? { runs: line.runs.map(run => ({ ...run, offset: start + run.offset })) } : {}),
    });
  };
  let cursor = 0;
  for (const block of blocks) {
    if (block.offset < cursor) continue;
    append(cursor, block.offset);
    if (block.table) for (const line of tableLines(chapter, block.table, width)) lines.push(line);
    else append(block.offset, block.offset + block.length, 4);
    cursor = block.offset + block.length;
  }
  append(cursor, chapter.text.length);
  return lines;
}
