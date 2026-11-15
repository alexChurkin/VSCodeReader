import { deflateRawSync } from 'node:zlib';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Tiny independent ZIP writer for synthetic test books (not shipped in VSIX).
export function zip(files: Array<[string, string | Buffer]>, advertisedSize?: number): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = deflateRawSync(data);
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(advertisedSize ?? data.length, 22); header.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    header.copy(dir, 8, 6, 28); // flags through filename length
    dir.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(dir, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function epub(version = '3.0', options: { fixed?: boolean; chapter?: string; nav?: boolean } = {}): Buffer {
  const files: Array<[string, string]> = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OPS/book.opf', `<package version="${version}" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Test book</dc:title><dc:creator>Author</dc:creator>${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest><item id="b" href="two.xhtml" media-type="application/xhtml+xml"/><item id="a" href="chapters/one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="toc.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>`],
    ['OPS/two.xhtml', '<html><body><h1>Second</h1><p>Текст второй главы. 中文 👩‍💻</p></body></html>'],
    ['OPS/chapters/one.xhtml', options.chapter ?? '<!DOCTYPE html><html><head><title>First</title></head><body><p>Intro &amp; text.</p><h1 id="target">First chapter</h1><p>Alice and the rabbit.</p><img alt="rabbit" src="rabbit.png"/><script>bad()</script></body></html>'],
    ['OPS/toc.xhtml', options.nav === false ? '<html><body/></html>' : '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapters/one.xhtml#target">First entry</a></li><li><a href="two.xhtml">Second entry</a></li></ol></nav></body></html>'],
    ['OPS/toc.ncx', '<ncx><navMap><navPoint><navLabel><text>NCX First</text></navLabel><content src="chapters/one.xhtml#target"/></navPoint></navMap></ncx>']
  ];
  return zip(files);
}
