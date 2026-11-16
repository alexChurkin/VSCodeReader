import { parseDocument } from 'htmlparser2';
import type { Element, AnyNode } from 'domhandler';
import { XMLValidator } from 'fast-xml-parser';
import { safeText } from './book';

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
export function xml(source: string) {
  // Accept common EPUB HTML/NCX declarations as inert syntax, never load a DTD.
  source = source.replace(/<!DOCTYPE\s+(?:html|ncx)(?:\s+SYSTEM\s+(?:"[^"]*"|'[^']*')|\s+PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*'))?\s*>/gi, '');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('DTD and XML entities are not supported.');
  const valid = XMLValidator.validate(source);
  if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}`);
  return parseDocument(source, { xmlMode: true, decodeEntities: true });
}

export interface ImageReference { href: string; label: string; offset: number; length: number }
export function chapterText(source: string) {
  const doc = parseDocument(source, { decodeEntities: true });
  const body = elements(doc, 'body')[0] ?? doc;
  return renderNodes(body.children);
}
export interface HeadingReference { title: string; level: number; offset: number }
export function renderNodes(nodes: AnyNode[], fb2 = false, markup = false): { text: string; anchors: Record<string, number>; images: ImageReference[]; headings: HeadingReference[] } {
  const ignored = new Set(['script', 'style', 'head', 'iframe', 'object', 'embed', 'form', 'svg', 'audio', 'video']);
  const blocks = new Set([...(fb2 ? ['title', 'subtitle', 'epigraph', 'annotation', 'poem', 'stanza', 'v', 'cite', 'text-author'] : []), 'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'dt', 'dd']);
  let output = '';
  let imageSerial = 0;
  const anchors: Record<string, number> = Object.create(null);
  const images: ImageReference[] = [];
  const headings: HeadingReference[] = [];
  const listCounters = new Map<AnyNode, number>();
  const boundary = () => { if (output && !output.endsWith('\n')) output += '\n\n'; };
  const stack: Array<{ node: AnyNode; end?: boolean; pre?: boolean }> = [...nodes].reverse().map(node => ({ node }));
  while (stack.length) {
    const { node, end, pre } = stack.pop()!;
    if (node.type === 'text') {
      const text = safeText(node.data);
      if (markup && !pre && !text.trim() && (!output || output.endsWith('\n'))) continue;
      const normalized = text.replace(/\s+/g, ' ');
      output += markup && pre ? text : markup && /[ \n]$/.test(output) ? normalized.replace(/^ /, '') : normalized;
      continue;
    }
    if (!isElement(node)) continue;
    const tag = localName(node.name);
    if (node.attribs.hidden !== undefined || node.attribs['aria-hidden'] === 'true') continue;
    if (tag === 'svg') {
      for (const image of elements(node, 'image')) {
        const href = image.attribs['xlink:href'] ?? image.attribs.href ?? Object.entries(image.attribs).find(([key]) => key.endsWith(':href'))?.[1];
        if (href) {
          const marker = `[image #${++imageSerial}: illustration]`;
          images.push({ href, label: 'illustration', offset: output.length, length: marker.length });
          output += marker;
        }
      }
    }
    if ((markup && ['template', 'noscript', 'button', 'select', 'textarea', 'input'].includes(tag)) || ignored.has(tag)) continue;
    if (end) {
      if (markup && (tag === 'td' || tag === 'th')) output += ' | ';
      if (blocks.has(tag)) boundary(); continue;
    }
    if (blocks.has(tag) && !(markup && tag === 'p' && /(?:- |\d+\. |\[[ x]\] )$/.test(output))) boundary();
    if (markup && /^h[1-6]$/.test(tag)) headings.push({ title: content(node) || 'Section', level: Number(tag[1]), offset: output.length });
    if (markup && tag === 'li') {
      const parent = node.parent;
      const ordered = parent && isElement(parent) && localName(parent.name) === 'ol';
      const count = parent ? listCounters.get(parent) ?? (ordered ? Math.max(1, Math.min(1_000_000, Number(parent.attribs.start) || 1)) : 1) : 1;
      if (parent) listCounters.set(parent, count + 1);
      const checkbox = node.children.find(child => isElement(child) && localName(child.name) === 'input' && child.attribs.type === 'checkbox');
      output += checkbox && isElement(checkbox) ? (checkbox.attribs.checked !== undefined ? '[x] ' : '[ ] ') : ordered ? `${count}. ` : '- ';
    }
    if (markup && tag === 'hr') { boundary(); output += '---\n\n'; }
    if (node.attribs.id) anchors[node.attribs.id] = output.length;
    if (tag === 'br' || (fb2 && tag === 'empty-line')) output += '\n';
    else if (tag === 'img' || tag === 'image') {
      const href = node.attribs.src ?? node.attribs['xlink:href'] ?? node.attribs.href ?? Object.entries(node.attribs).find(([key]) => key.endsWith(':href'))?.[1];
      const label = safeText(node.attribs.alt || node.attribs.title || 'illustration').replace(/\s+/g, ' ');
      const marker = `[image #${++imageSerial}: ${label}]`;
      if (href) images.push({ href, label, offset: output.length, length: marker.length });
      output += marker;
    }
    else {
      stack.push({ node, end: true, pre });
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], pre: markup && (pre || tag === 'pre' || tag === 'code') });
    }
  }
  // Keep anchor offsets valid: no global trim/collapse after collecting them.
  return { text: output || '[empty chapter]', anchors, images, headings };
}
