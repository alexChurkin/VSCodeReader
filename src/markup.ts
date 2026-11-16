import { posix } from 'node:path';
import { parseDocument } from 'htmlparser2';
import { markdownHtml } from './markdown';
import { cssRules } from './presentation';
import { fragment } from './footnotes';
import { LIMITS } from './archive';
import { type Book, type BookImage, type Chapter, safeText } from './book';
import { decodeText, type TextEncoding } from './encoding';
import { content, elements, renderNodes } from './xml';
import { isRasterMediaType, validateImage, type ImageData } from './images';

export const isMarkup = (filename: string) => /\.(?:html?|md|markdown)$/i.test(filename);
export interface MarkupDocument { book: Book; resources: Map<string, string> }
export function localImagePath(href: string): string {
  const path = decodeURIComponent(href.split(/[?#]/)[0]);
  if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith('/')) throw new Error('Image must be a relative file inside the document folder.');
  const normalized = posix.normalize(path);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') throw new Error('Image must stay inside the document folder.');
  return normalized;
}
function htmlEncoding(bytes: Uint8Array, fallback: TextEncoding): string {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  return /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1] ?? fallback;
}
function supportedReference(href: string): boolean {
  if (/^data:/i.test(href)) return /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(href);
  try { return !/\.svg$/i.test(localImagePath(href)); } catch { return false; }
}

export function readMarkup(bytes: Uint8Array, filename: string, encoding: TextEncoding = 'utf-8'): MarkupDocument {
  if (bytes.length > LIMITS.text) throw new Error('HTML/Markdown exceeds the 32 MiB document limit.');
  const md = /\.(?:md|markdown)$/i.test(filename);
  const source = decodeText(bytes, md ? encoding : htmlEncoding(bytes, encoding));
  const html = md ? markdownHtml(source) : source;
  const doc = parseDocument(html, { decodeEntities: true });
  const body = elements(doc, 'body')[0] ?? doc;
  const rendered = renderNodes(body.children, false, true, elements(doc, 'style').flatMap(node => cssRules(content(node))).slice(0, 5000).map((rule, order) => ({ ...rule, order })));
  if (rendered.text === '[empty chapter]' || !rendered.text.trim()) throw new Error('Document has no readable text.');
  const titleNode = elements(doc, 'title')[0];
  const title = (titleNode ? content(titleNode) : rendered.headings[0]?.title) || safeText(posix.basename(filename));
  const author = elements(doc, 'meta').find(meta => meta.attribs.name?.toLowerCase() === 'author')?.attribs.content ?? '';
  // Sections follow visible headings. Long sections are additionally split at
  // line boundaries so wrapping never processes a whole large document at once.
  const headingStarts = [...new Set(rendered.headings.map(h => h.offset))].sort((a, b) => a - b);
  const first = headingStarts[0] ?? 0;
  const boundaries = [...new Set([rendered.text.slice(0, first).trim() ? 0 : first, ...headingStarts, rendered.text.length])];
  const starts: number[] = [], chapters: Chapter[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    let start = boundaries[index];
    const end = boundaries[index + 1];
    const label = rendered.headings.find(h => h.offset === start)?.title || (index === 0 ? title : 'Section');
    let part = 0;
    while (start < end) {
      const limit = Math.min(end, start + 64_000);
      let stop = limit < end ? rendered.text.lastIndexOf('\n', limit) + 1 : limit;
      if (stop <= start) stop = limit;
      const spanningTable = rendered.tables.find(table => table.offset < stop && table.offset + table.length > stop);
      if (spanningTable) stop = Math.min(end, spanningTable.offset + spanningTable.length);
      if (stop < end && /[\ud800-\udbff]/.test(rendered.text[stop - 1])) stop--;
      const anchors: Record<string, number> = Object.create(null);
      for (const [anchor, offset] of Object.entries(rendered.anchors)) if (offset >= start && offset < stop) anchors[anchor] = offset - start;
      starts.push(start);
      chapters.push({ id: `section-${chapters.length}`, title: part ? `${label} (${part + 1})` : label, text: rendered.text.slice(start, stop), anchors,
        paragraphs: rendered.paragraphs.filter(paragraph => paragraph.offset >= start && paragraph.offset < stop).map(paragraph => ({ offset: paragraph.offset - start, length: Math.min(paragraph.length, stop - paragraph.offset) })),
        indents: rendered.indents.flatMap(block => {
          const offset = Math.max(block.offset, start), finish = Math.min(block.offset + block.length, stop);
          return finish > offset ? [{ ...block, offset: offset - start, length: finish - offset, firstLine: offset > block.offset ? block.continuation : block.firstLine }] : [];
        }),
        styles: rendered.styles.flatMap(style => {
          const offset = Math.max(style.offset, start), finish = Math.min(style.offset + style.length, stop);
          return finish > offset ? [{ ...style, offset: offset - start, length: finish - offset }] : [];
        }),
        tables: rendered.tables.filter(table => table.offset >= start && table.offset + table.length <= stop).map(table => ({ ...table, offset: table.offset - start, caption: table.caption ? { ...table.caption, offset: table.caption.offset - start } : undefined, rows: table.rows.map(row => ({ ...row, offset: row.offset - start, end: row.end - start, cells: row.cells.map(cell => ({ ...cell, offset: cell.offset - start })) })) })),
      });
      start = stop; part++;
    }
  }
  const locate = (offset: number) => {
    let chapter = 0;
    for (let i = 0; i < starts.length; i++) { if (starts[i] > offset) break; chapter = i; }
    return { chapter, offset: Math.max(0, offset - starts[chapter]) };
  };
  const minLevel = Math.min(...rendered.headings.map(h => h.level), 6);
  const toc = rendered.headings.length ? rendered.headings.map(h => ({ title: h.title, depth: Math.max(0, h.level - minLevel), ...locate(h.offset) })) : chapters.map((c, chapter) => ({ title: c.title, chapter, offset: 0, depth: 0 }));
  const resources = new Map<string, string>();
  const images: BookImage[] = [];
  for (const ref of rendered.images) {
    if (!supportedReference(ref.href)) continue;
    let image = images.find(item => resources.get(item.id) === ref.href);
    if (!image) {
      const id = `image-${images.length}`;
      resources.set(id, ref.href);
      const label = ref.label === 'illustration' ? (/^data:/i.test(ref.href) ? `Embedded image ${images.length + 1}` : safeText(ref.href)) : ref.label;
      image = { id, label, mediaType: 'image/raster', chapters: [] }; images.push(image);
    }
    const { chapter } = locate(ref.offset);
    if (!image.chapters.includes(chapter)) image.chapters.push(chapter);
    // A long marker can cross the artificial 64k section boundary.
    for (let index = chapter; index < chapters.length && starts[index] < ref.offset + ref.length; index++) {
      const offset = Math.max(0, ref.offset - starts[index]);
      const end = Math.min(chapters[index].text.length, ref.offset + ref.length - starts[index]);
      if (end > offset) (chapters[index].imageLinks ??= []).push({ imageId: image.id, offset, length: end - offset });
    }
  }
  for (const marker of rendered.markers) {
    const source = locate(marker.offset);
    for (let chapter = source.chapter; chapter < chapters.length && starts[chapter] < marker.offset + marker.length; chapter++) {
      const offset = Math.max(0, marker.offset - starts[chapter]);
      const end = Math.min(chapters[chapter].text.length, marker.offset + marker.length - starts[chapter]);
      if (end > offset) (chapters[chapter].imageMarkers ??= []).push({ offset, length: end - offset });
    }
  }
  rendered.links.forEach((ref, index) => {
    const id = fragment(ref.href);
    if (!id || !Object.hasOwn(rendered.anchors, id)) return;
    const target = locate(rendered.anchors[id]);
    const source = locate(ref.offset);
    for (let chapter = source.chapter; chapter < chapters.length && starts[chapter] < ref.offset + ref.length; chapter++) {
      const offset = Math.max(0, ref.offset - starts[chapter]);
      const end = Math.min(chapters[chapter].text.length, ref.offset + ref.length - starts[chapter]);
      if (end > offset) (chapters[chapter].footnotes ??= []).push({ id: `reference-${index}`, offset, length: end - offset, label: ref.label, target });
    }
  });
  return { book: { title: safeText(title), author: safeText(author), chapters, toc, images }, resources };
}
export function embeddedImage(href: string): ImageData {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(href);
  if (!match || !isRasterMediaType(match[1])) throw new Error('Unsupported embedded image.');
  const base64 = match[2].replace(/\s/g, '');
  if (base64.length > Math.ceil(LIMITS.entry / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid or oversized base64 image.');
  return validateImage(Buffer.from(base64, 'base64'));
}
