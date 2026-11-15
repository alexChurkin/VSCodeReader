import { Archive, resolveHref } from './archive';
import { chapterText, content, elements, xml, localName } from './xml';
import { safeText, type Book, type Chapter, type TocItem } from './book';

function decode(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 200)).toString('ascii');
  const encoding = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ?? 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export async function readEpub(bytes: Uint8Array, signal?: AbortSignal): Promise<Book> {
  const archive = await Archive.open(bytes, signal);
  try {
    if ((await archive.read('mimetype')).toString().trim() !== 'application/epub+zip') throw new Error('This file is not an EPUB archive.');
    const container = xml(decode(await archive.read('META-INF/container.xml')));
    const rootfile = elements(container, 'rootfile').find(node => node.attribs['media-type'] === 'application/oebps-package+xml') ?? elements(container, 'rootfile')[0];
    if (!rootfile?.attribs['full-path']) throw new Error('EPUB has no package document.');
    const packagePath = rootfile.attribs['full-path'];
    const doc = xml(decode(await archive.read(packagePath)));
    const pkg = elements(doc, 'package')[0];
    if (!pkg || !['2.0', '3.0', '3.1', '3.2', '3.3'].includes(pkg.attribs.version)) throw new Error('Unsupported EPUB package version.');
    if (elements(doc, 'meta').some(e => e.attribs.property === 'rendition:layout' && content(e) === 'pre-paginated')) throw new Error('Fixed-layout EPUB is not supported by the terminal reader.');
    const manifest = new Map(elements(doc, 'item').map(item => [item.attribs.id, item]));
    const spine = elements(doc, 'spine')[0];
    if (!spine) throw new Error('EPUB has no reading order.');
    const chapters: Chapter[] = [];
    for (const itemref of elements(spine, 'itemref')) {
      signal?.throwIfAborted();
      if (itemref.attribs.linear === 'no') continue;
      const item = manifest.get(itemref.attribs.idref);
      if (!item?.attribs.href) throw new Error('EPUB spine references a missing manifest item.');
      if (!['application/xhtml+xml', 'text/html'].includes(item.attribs['media-type'])) throw new Error('EPUB contains unsupported spine content.');
      const path = resolveHref(packagePath, item.attribs.href).path;
      const source = decode(await archive.read(path));
      const heading = chapterText(source);
      const titleDoc = xml(source);
      const title = content(elements(titleDoc, 'h1')[0] ?? elements(titleDoc, 'h2')[0] ?? elements(titleDoc, 'title')[0] ?? titleDoc);
      chapters.push({ id: path, title: title.slice(0, 200) || `Section ${chapters.length + 1}`, ...heading });
    }
    if (!chapters.length) throw new Error('EPUB has no readable chapters.');
    const toc: TocItem[] = [];
    const add = (base: string, href: string, title: string, depth: number) => {
      try {
        const target = resolveHref(base, href);
        const chapter = chapters.findIndex(c => c.id === target.path);
        if (chapter >= 0) toc.push({ chapter, offset: chapters[chapter].anchors[target.fragment] ?? 0, title: safeText(title), depth });
      } catch { /* External TOC links cannot be followed by this reader. */ }
    };
    const nav = [...manifest.values()].find(item => item.attribs.properties?.split(/\s+/).includes('nav'));
    if (nav) {
      const path = resolveHref(packagePath, nav.attribs.href).path;
      const navDoc = xml(decode(await archive.read(path)));
      const tocNav = elements(navDoc, 'nav').find(n => (n.attribs['epub:type'] ?? n.attribs.type ?? '').split(/\s+/).includes('toc'));
      if (tocNav) for (const a of elements(tocNav, 'a')) {
        let depth = -1;
        let parent = a.parent;
        while (parent) { if ('name' in parent && localName(parent.name) === 'ol') depth++; parent = parent.parent; }
        if (a.attribs.href) add(path, a.attribs.href, content(a), Math.max(0, depth));
      }
    }
    if (!toc.length) {
      const ncx = manifest.get(spine.attribs.toc) ?? [...manifest.values()].find(item => item.attribs['media-type'] === 'application/x-dtbncx+xml');
      if (ncx) {
        const path = resolveHref(packagePath, ncx.attribs.href).path;
        const ncxDoc = xml(decode(await archive.read(path)));
        for (const point of elements(ncxDoc, 'navpoint')) {
          const label = elements(point, 'navlabel')[0];
          const target = elements(point, 'content')[0];
          let depth = 0, parent = point.parent;
          while (parent) { if ('name' in parent && localName(parent.name) === 'navpoint') depth++; parent = parent.parent; }
          if (target?.attribs.src) add(path, target.attribs.src, label ? content(label) : 'Section', depth);
        }
      }
    }
    if (!toc.length) chapters.forEach((c, chapter) => toc.push({ chapter, title: c.title, offset: 0, depth: 0 }));
    return { title: content(elements(doc, 'title')[0] ?? doc).slice(0, 200), author: elements(doc, 'creator').map(content).join(', '), chapters, toc };
  } finally { archive.close(); }
}
