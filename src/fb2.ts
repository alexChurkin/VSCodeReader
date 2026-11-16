import { attachFootnotes, fragment } from './footnotes';
import type { LinkReference } from './xml';
import type { Element } from 'domhandler';
import { LIMITS } from './archive';
import { type Book, type Chapter, type TocItem, type BookImage, safeText } from './book';
import { decodeXml } from './encoding';
import { isRasterMediaType } from './images';
import { xml, elements, isElement, localName, content, renderNodes } from './xml';

const children = (node: Element, tag: string) => node.children.filter(isElement).filter(n => localName(n.name) === tag);
export function fb2Document(bytes: Uint8Array) {
  if (bytes.length > LIMITS.text) throw new Error('FB2 exceeds the 32 MiB document limit.');
  const doc = xml(decodeXml(bytes));
  const root = doc.children.find(isElement);
  if (!root || localName(root.name) !== 'fictionbook') throw new Error('This file is not a FictionBook 2 document.');
  return root;
}
export function readFb2(bytes: Uint8Array): Book {
  const root = fb2Document(bytes);
  const info = elements(root, 'title-info')[0];
  const title = info && elements(info, 'book-title')[0];
  const author = info ? elements(info, 'author').map(a => children(a, 'first-name').concat(children(a, 'middle-name'), children(a, 'last-name')).map(content).join(' ')).join(', ') : '';
  const chapters: Chapter[] = [], toc: TocItem[] = [];
  const images: BookImage[] = elements(root, 'binary').filter(b => b.attribs.id && isRasterMediaType(b.attribs['content-type'])).map(b => ({ id: b.attribs.id, label: safeText(b.attribs.id), mediaType: b.attribs['content-type'], chapters: [] }));
  const references: LinkReference[][] = [];
  let serial = 0;
  const addChapter = (nodes: Element[], label: string) => {
    const sections = nodes.flatMap(n => localName(n.name) === 'section' ? [n, ...elements(n, 'section')] : []);
    for (const section of sections) section.attribs.id ||= `__vscode_reader_section_${serial++}`;
    const rendered = renderNodes(nodes, true);
    const index = chapters.length;
    references.push(rendered.links);
    chapters.push({ id: `body-${index}`, title: safeText(label), text: rendered.text, anchors: rendered.anchors, imageLinks: [] });
    if (!sections.length) toc.push({ title: label, chapter: index, offset: 0, depth: 0 });
    for (const section of sections) {
      let depth = 0, parent = section.parent;
      while (parent && 'name' in parent && localName(parent.name) === 'section') { depth++; parent = parent.parent; }
      const heading = children(section, 'title')[0];
      toc.push({ title: heading ? content(heading) : label, chapter: index, offset: rendered.anchors[section.attribs.id] ?? 0, depth });
    }
    for (const ref of rendered.images) {
      if (!ref.href.startsWith('#')) continue;
      const image = images.find(i => i.id === ref.href.slice(1));
      if (image) {
        if (!image.chapters.includes(index)) image.chapters.push(index);
        if (ref.length) chapters[index].imageLinks!.push({ imageId: image.id, offset: ref.offset, length: ref.length });
      }
    }
  };
  for (const body of children(root, 'body')) {
    const sections = children(body, 'section');
    const bodyTitle = children(body, 'title')[0];
    const label = bodyTitle ? content(bodyTitle) : safeText(body.attribs.name || 'Text');
    const prologue = body.children.filter(isElement).filter(node => localName(node.name) !== 'section');
    if (prologue.length) addChapter(prologue, label);
    for (const section of sections) addChapter([section], children(section, 'title')[0] ? content(children(section, 'title')[0]) : label);
    if (!sections.length && !prologue.length && content(body)) addChapter([body], label);
  }
  if (!chapters.length) throw new Error('FB2 has no readable body.');
  chapters.forEach((chapter, index) => attachFootnotes(chapter, references[index], href => {
    const id = fragment(href);
    if (!id) return undefined;
    const target = chapters.findIndex(item => Object.hasOwn(item.anchors, id));
    return target < 0 ? undefined : { chapter: target, offset: chapters[target].anchors[id] };
  }));
  return { title: title ? content(title) : 'FictionBook', author, chapters, toc, images };
}
export function fb2Image(bytes: Uint8Array, id: string): Buffer {
  const binary = elements(fb2Document(bytes), 'binary').find(b => b.attribs.id === id);
  if (!binary || !isRasterMediaType(binary.attribs['content-type'])) throw new Error('Image is missing or its type is unsupported.');
  const base64 = content(binary).replace(/\s/g, '');
  if (base64.length > Math.ceil(LIMITS.entry / 3) * 4 || (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))) throw new Error('Invalid or oversized base64 image.');
  return Buffer.from(base64, 'base64');
}
