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

export function chapterText(source: string): { text: string; anchors: Record<string, number> } {
  const doc = parseDocument(source, { decodeEntities: true });
  const body = elements(doc, 'body')[0] ?? doc;
  const ignored = new Set(['script', 'style', 'head', 'iframe', 'object', 'embed', 'form', 'svg', 'audio', 'video']);
  const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'dt', 'dd']);
  let output = '';
  const anchors: Record<string, number> = Object.create(null);
  const boundary = () => { if (output && !output.endsWith('\n')) output += '\n\n'; };
  const stack: Array<{ node: AnyNode; end?: boolean }> = [...body.children].reverse().map(node => ({ node }));
  while (stack.length) {
    const { node, end } = stack.pop()!;
    if (node.type === 'text') { output += safeText(node.data).replace(/\s+/g, ' '); continue; }
    if (!isElement(node)) continue;
    const tag = localName(node.name);
    if (ignored.has(tag) || node.attribs.hidden !== undefined || node.attribs['aria-hidden'] === 'true') continue;
    if (end) { if (blocks.has(tag)) boundary(); continue; }
    if (blocks.has(tag)) boundary();
    if (node.attribs.id) anchors[node.attribs.id] = output.length;
    if (tag === 'br') output += '\n';
    else if (tag === 'img') output += `[image: ${safeText(node.attribs.alt || 'illustration').replace(/\s+/g, ' ')}]`;
    else {
      stack.push({ node, end: true });
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i] });
    }
  }
  // Keep anchor offsets valid: no global trim/collapse after collecting them.
  return { text: output || '[empty chapter]', anchors };
}
