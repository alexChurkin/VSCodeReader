import { parseDocument } from 'htmlparser2';
import type { Element, AnyNode } from 'domhandler';
import { XMLValidator } from 'fast-xml-parser';
import { cssRules, presentation, plainPresentation, type CssRule, type Presentation } from './presentation';
import { safeText, type ImageMarker, type StyleSpan, type BookTable, type TableCell, type TableRow } from './book';

export function localName(name: string): string { return name.split(':').at(-1)!.toLowerCase(); }
export function isElement(node: AnyNode): node is Element { return 'name' in node && 'attribs' in node; }
export function elements(node: { children: AnyNode[] }, tag?: string): Element[] {
  const found: Element[] = [];
  // Iteration avoids stack overflow on deeply nested untrusted input.
  const stack = [...node.children].reverse();
  while (stack.length) {
    const current = stack.pop()!;
    if (isElement(current)) {
      if (!tag || localName(current.name) === tag) found.push(current);
      stack.push(...[...current.children].reverse());
    }
  }
  return found;
}
export function content(node: AnyNode): string {
  const stack = [node];
  let text = '';
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === 'text') text += current.data;
    else if ('children' in current) stack.push(...[...current.children].reverse());
  }
  return safeText(text).replace(/\s+/g, ' ').trim();
}
export function validatedXml(source: string): string {
  // Accept common EPUB HTML/NCX declarations as inert syntax, never load a DTD.
  source = source.replace(/<!DOCTYPE\s+(?:html|ncx)(?:\s+SYSTEM\s+(?:"[^"]*"|'[^']*')|\s+PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*'))?\s*>/gi, '');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('DTD and XML entities are not supported.');
  const valid = XMLValidator.validate(source);
  if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}`);
  return source;
}

export function xml(source: string) { return parseDocument(validatedXml(source), { xmlMode: true, decodeEntities: true }); }

export interface LinkReference { href: string; offset: number; length: number; label: string; footnote: boolean }
export interface ImageReference { href: string; label: string; offset: number; length: number }
export function chapterText(source: string, rules: CssRule[] = []) { return documentText(parseDocument(source, { decodeEntities: true }), rules); }
export function documentText(doc: { children: AnyNode[] }, rules: CssRule[] = []) {
  const body = elements(doc, 'body')[0] ?? doc;
  const title = content(elements(doc, 'h1')[0] ?? elements(doc, 'h2')[0] ?? elements(doc, 'title')[0] ?? doc);
  const inlineRules = elements(doc, 'style').flatMap(node => cssRules(content(node)));
  const rendered = renderNodes(body.children, false, true, [...rules, ...inlineRules].slice(0, 5000).map((rule, order) => ({ ...rule, order })));
  return { ...rendered, title: rendered.headings[0]?.title || title };
}
export interface HeadingReference { title: string; level: number; offset: number }
export function renderNodes(nodes: AnyNode[], fb2 = false, markup = false, rules: CssRule[] = []): { text: string; anchors: Record<string, number>; images: ImageReference[]; markers: ImageMarker[]; links: LinkReference[]; headings: HeadingReference[]; styles: StyleSpan[]; tables: BookTable[]; paragraphs: Array<{ offset: number; length: number }> } {
  markup ||= fb2;
  // FB2 <style name="…"> contains readable inline text, unlike HTML <style>.
  const ignored = new Set(['script', fb2 ? 'stylesheet' : 'style', 'head', 'iframe', 'object', 'embed', 'form', 'svg', 'audio', 'video']);
  const blocks = new Set([...(fb2 ? ['title', 'subtitle', 'epigraph', 'annotation', 'poem', 'stanza', 'v', 'cite', 'text-author'] : []), 'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'caption', 'tr', 'dt', 'dd']);
  let output = '';
  let imageSerial = 0;
  const anchors: Record<string, number> = Object.create(null);
  const images: ImageReference[] = [];
  const markers: ImageMarker[] = [];
  const links: LinkReference[] = [];
  const linkStarts = new Map<AnyNode, Omit<LinkReference, 'length'>>();
  const headings: HeadingReference[] = [];
  const styles: StyleSpan[] = [];
  const paragraphs: Array<{ offset: number; length: number }> = [];
  const paragraphStarts = new Map<AnyNode, number>();
  const tables: BookTable[] = [];
  const tableStack: BookTable[] = [];
  const tableNodes = new Map<AnyNode, BookTable>();
  const rowNodes = new Map<AnyNode, TableRow>();
  const captionNodes = new Map<AnyNode, { offset: number; length: number }>();
  const cellNodes = new Map<AnyNode, TableCell>();
  const occupancy = new Map<BookTable, number[]>();
  const append = (text: string, style: Presentation) => {
    const offset = output.length; output += text;
    if (!text || !(style.bold || style.italic || style.underline || style.strike)) return;
    const previous = styles[styles.length - 1];
    if (previous && previous.offset + previous.length === offset && !!previous.bold === !!style.bold && !!previous.italic === !!style.italic && !!previous.underline === !!style.underline && !!previous.strike === !!style.strike) previous.length += text.length;
    else styles.push({ offset, length: text.length, bold: style.bold, italic: style.italic, underline: style.underline, strike: style.strike });
  };
  const listCounters = new Map<AnyNode, number>();
  const boundary = (lines = 2) => { if (output && !output.endsWith('\n')) output += '\n'.repeat(lines); };
  const stack: Array<{ node: AnyNode; end?: boolean; pre?: boolean; inherited: Presentation; resolved?: Presentation }> = [...nodes].reverse().map(node => ({ node, inherited: plainPresentation }));
  while (stack.length) {
    const { node, end, pre, inherited, resolved } = stack.pop()!;
    if (node.type === 'text') {
      const text = safeText(node.data);
      if (markup && !pre && !text.trim() && (!output || output.endsWith('\n'))) continue;
      if (inherited.quote && text.trim() && (!output || output.endsWith('\n'))) output += '  '.repeat(Math.min(8, inherited.quote - 1)) + '> ';
      const normalized = text.replace(/\s+/g, ' ');
      append(markup && pre ? text : markup && /[ \n]$/.test(output) ? normalized.replace(/^ /, '') : normalized, inherited);
      continue;
    }
    if (!isElement(node)) continue;
    const tag = localName(node.name);
    const style = resolved ?? presentation(node, inherited, rules, fb2);
    if (style.hidden || node.attribs.hidden !== undefined || node.attribs['aria-hidden'] === 'true') continue;
    if (tag === 'svg') {
      for (const image of elements(node, 'image')) {
        const href = image.attribs['xlink:href'] ?? image.attribs.href ?? Object.entries(image.attribs).find(([key]) => key.endsWith(':href'))?.[1];
        if (href) {
          const marker = `[image #${++imageSerial}: illustration]`;
          images.push({ href, label: 'illustration', offset: output.length, length: marker.length });
          markers.push({ offset: output.length, length: marker.length });
          output += marker;
        }
      }
    }
    if ((markup && ['template', 'noscript', 'button', 'select', 'textarea', 'input'].includes(tag)) || ignored.has(tag)) continue;
    if (end) {
      const paragraphStart = paragraphStarts.get(node);
      if (paragraphStart !== undefined) {
        let prose = '', cursor = paragraphStart;
        for (const marker of markers) {
          if (marker.offset < paragraphStart || marker.offset >= output.length) continue;
          prose += output.slice(cursor, marker.offset); cursor = marker.offset + marker.length;
        }
        prose += output.slice(cursor);
        if (prose.trim() && !/^(?:[-*+•●○◦▪‣]|\d+(?:\.\d+)*[.)]|\[[ xX]\])\s/u.test(prose.trimStart())) paragraphs.push({ offset: paragraphStart, length: output.length - paragraphStart });
      }
      const link = linkStarts.get(node);
      if (link) links.push({ ...link, length: output.length - link.offset });
      const caption = captionNodes.get(node);
      if (caption) {
        const source = output.slice(caption.offset);
        caption.offset += source.length - source.trimStart().length; caption.length = source.trim().length;
      }
      const cell = cellNodes.get(node);
      if (cell) {
        const source = output.slice(cell.offset);
        const lead = source.length - source.trimStart().length;
        cell.offset += lead; cell.length = source.trim().length;
        output += ' | ';
      }
      const row = rowNodes.get(node); if (row) row.end = output.length;
      const table = tableNodes.get(node);
      if (table) { table.length = output.length - table.offset; tableStack.pop(); }
      if (blocks.has(tag)) boundary(fb2 && tag === 'v' ? 1 : 2);
      if (fb2 && tag === 'stanza' && output.endsWith('\n') && !output.endsWith('\n\n')) output += '\n';
      continue;
    }
    if (blocks.has(tag) && !(markup && tag === 'p' && /(?:- |\d+\. |\[[ x]\] )$/.test(output))) boundary(fb2 && tag === 'v' ? 1 : 2);
    if (tag === 'table') {
      boundary();
      const table: BookTable = { offset: output.length, length: 0, columns: 0, rows: [] };
      if (!tableStack.length) tables.push(table);
      tableNodes.set(node, table); tableStack.push(table); occupancy.set(table, []);
    }
    if (tag === 'caption' && tableStack.length) {
      const table = tableStack[tableStack.length - 1];
      table.caption = { offset: output.length, length: 0 }; captionNodes.set(node, table.caption);
    }
    if (tag === 'tr' && tableStack.length) {
      const table = tableStack[tableStack.length - 1];
      const row: TableRow = { offset: output.length, end: output.length, cells: [] };
      table.rows.push(row); rowNodes.set(node, row);
    }
    if ((tag === 'td' || tag === 'th') && tableStack.length) {
      const table = tableStack[tableStack.length - 1], row = table.rows[table.rows.length - 1];
      if (row) {
        const occupied = occupancy.get(table)!;
        let column = 0; while ((occupied[column] ?? 0) >= table.rows.length) column++;
        const span = (value: string | undefined) => Math.max(1, Math.min(32, Number.parseInt(value ?? '1', 10) || 1));
        const colSpan = span(node.attribs.colspan), rowSpan = span(node.attribs.rowspan);
        while (Array.from({ length: colSpan }, (_, index) => (occupied[column + index] ?? 0) >= table.rows.length).some(Boolean)) column++;
        const cell: TableCell = { offset: output.length, length: 0, column, colSpan, rowSpan, header: tag === 'th' };
        for (let col = column; col < column + colSpan; col++) occupied[col] = table.rows.length + rowSpan - 1;
        row.cells.push(cell); cellNodes.set(node, cell); table.columns = Math.max(table.columns, column + colSpan);
      }
    }
    const heading = style.heading && !inherited.heading && !tableStack.length;
    if (heading) {
      boundary();
      headings.push({ title: content(node) || 'Section', level: style.heading, offset: output.length });
    }
    if (tag === 'p' && !style.listItem && !style.heading && !style.quote && !style.pre && !style.hanging && !tableStack.length) {
      const visibleChildren = node.children.filter(child => child.type !== 'text' || child.data.trim());
      let ordinary = !visibleChildren.length || !visibleChildren.every(child => isElement(child) && localName(child.name) === 'code');
      let ancestor: AnyNode | null = node;
      while (ancestor && isElement(ancestor)) {
        if (['li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'table', 'caption', 'figure', 'figcaption', 'nav', 'poem', 'stanza', 'v', 'title', 'subtitle', 'epigraph'].includes(localName(ancestor.name))
          || /(?:^|\s)(?:poem|poetry|verse|stanza|caption|code|pre|list[-_\w]*|bullet[-_\w]*|numbered[-_\w]*|[\w-]*toc)(?:\s|$)/i.test(ancestor.attribs.class ?? '')
          || /^(?:heading|list|listitem|table|row|cell|navigation|doc-toc)$/.test(ancestor.attribs.role ?? '')
          || (ancestor.attribs['epub:type'] ?? '').split(/\s+/).includes('toc')) { ordinary = false; break; }
        ancestor = ancestor.parent;
      }
      if (ordinary) paragraphStarts.set(node, output.length);
    }
    if (tag === 'blockquote') boundary();
    if (tag === 'li') {
      const parent = node.parent;
      const ordered = parent && isElement(parent) && localName(parent.name) === 'ol';
      const count = parent ? listCounters.get(parent) ?? (ordered ? Math.max(1, Math.min(1_000_000, Number(parent.attribs.start) || 1)) : 1) : 1;
      if (parent) listCounters.set(parent, count + 1);
      const checkbox = node.children.find(child => isElement(child) && localName(child.name) === 'input' && child.attribs.type === 'checkbox');
      let depth = 0, ancestor = node.parent;
      while (ancestor && 'name' in ancestor) { if (['ol', 'ul'].includes(localName(ancestor.name))) depth++; ancestor = ancestor.parent; }
      output += '  '.repeat(Math.min(8, Math.max(0, depth - 1)));
      output += checkbox && isElement(checkbox) ? (checkbox.attribs.checked !== undefined ? '[x] ' : '[ ] ') : ordered ? `${count}. ` : '- ';
    }
    if (tag === 'hr') { boundary(); output += '---\n\n'; }
    if (node.attribs.id || (tag === 'a' && node.attribs.name)) anchors[node.attribs.id || node.attribs.name] = output.length;
    const linkHref = tag === 'a' ? node.attribs.href ?? Object.entries(node.attribs).find(([key]) => key.endsWith(':href'))?.[1] : undefined;
    if (linkHref) linkStarts.set(node, { href: linkHref, offset: output.length, label: content(node), footnote: node.attribs.type === 'note' || (node.attribs['epub:type'] ?? '').split(/\s+/).includes('noteref') || node.attribs.role === 'doc-noteref' });
    if (tag === 'br' || (fb2 && tag === 'empty-line')) output += '\n';
    else if (tag === 'img' || tag === 'image') {
      const href = node.attribs.src ?? node.attribs['xlink:href'] ?? node.attribs.href ?? Object.entries(node.attribs).find(([key]) => key.endsWith(':href'))?.[1];
      const label = safeText(node.attribs.alt || node.attribs.title || 'illustration').replace(/\s+/g, ' ');
      const marker = `[image #${++imageSerial}: ${label}]`;
      if (href) images.push({ href, label, offset: output.length, length: marker.length });
      markers.push({ offset: output.length, length: marker.length });
      output += marker;
    }
    else {
      stack.push({ node, end: true, pre, inherited, resolved: style });
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], pre: markup && (pre || style.pre || tag === 'pre' || tag === 'code'), inherited: style });
    }
  }
  // Keep anchor offsets valid: no global trim/collapse after collecting them.
  return { text: output || '[empty chapter]', anchors, images, markers, links, headings, styles, tables, paragraphs };
}
