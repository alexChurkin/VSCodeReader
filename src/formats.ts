import { posix } from 'node:path';
import { Archive, LIMITS, archivePath } from './archive';
import { type Book, safeText } from './book';
import { decodeText, type TextEncoding } from './encoding';
import { readEpub } from './epub';
import { readFb2, fb2Image } from './fb2';
import { validateImage, type ImageData } from './images';

export interface ReadOptions { filename: string; entry?: string; encoding?: TextEncoding }
export interface WorkerRequest extends ReadOptions { bytes: Uint8Array; action?: 'book' | 'image'; imageId?: string }
export type BookResult = { kind: 'book'; book: Book; entry?: string } | { kind: 'selection'; entries: string[] };
export const supportedBook = (path: string) => /\.(?:epub|fb2|fb2\.zip|fbz|txt|cbz)$/i.test(path);

export function readTxt(bytes: Uint8Array, filename: string, encoding: TextEncoding = 'utf-8'): Book {
  if (bytes.length > LIMITS.text) throw new Error('TXT exceeds the 32 MiB document limit.');
  const text = safeText(decodeText(bytes, encoding));
  if (!text.trim()) throw new Error('Text document is empty.');
  // Bound each chapter, splitting only at line boundaries to preserve paragraphs.
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const bound = Math.min(text.length, start + 64_000);
    let end = bound < text.length ? text.lastIndexOf('\n', bound) + 1 : bound;
    if (end <= start) end = bound;
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  const title = safeText(posix.basename(filename));
  const chapters = chunks.map((chunk, index) => ({ id: `text-${index}`, title: chunks.length === 1 ? title : `Part ${index + 1}`, text: chunk, anchors: {} }));
  return { title, author: '', chapters, toc: chapters.map((c, chapter) => ({ title: c.title, chapter, offset: 0, depth: 0 })), images: [] };
}
async function zippedFb2(bytes: Uint8Array, entry?: string): Promise<{ bytes: Uint8Array; entry: string } | { entries: string[] }> {
  const archive = await Archive.open(bytes);
  try {
    const entries = [...archive.entries.keys()].filter(path => /\.fb2$/i.test(path));
    if (!entries.length) throw new Error('Archive contains no FB2 books.');
    if (!entry && entries.length > 1) return { entries };
    const selected = entry ? archivePath(entry) : entries[0];
    if (!entries.includes(selected)) throw new Error('Selected FB2 book is not present in the archive.');
    return { bytes: await archive.read(selected), entry: selected };
  } finally { archive.close(); }
}
export async function readBook(bytes: Uint8Array, options: ReadOptions): Promise<BookResult> {
  if (bytes.length > LIMITS.archive) throw new Error('Book exceeds the 100 MiB file limit.');
  const name = options.filename.toLowerCase();
  if (name.endsWith('.epub')) return { kind: 'book', book: await readEpub(bytes) };
  if (name.endsWith('.cbz')) {
    const archive = await Archive.open(bytes);
    try {
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
      const pages = [...archive.entries.keys()].filter(path => /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path)).sort((a, b) => collator.compare(a, b) || a.localeCompare(b));
      if (!pages.length) throw new Error('CBZ contains no supported raster images.');
      const images = pages.map((id, index) => ({ id, label: safeText(id), mediaType: 'image/' + (id.split('.').at(-1)!.toLowerCase().replace('jpg', 'jpeg')), chapters: [index] }));
      const chapters = pages.map((path, index) => ({ id: path, title: `Page ${index + 1}`, text: `[image: ${safeText(path)}]\n\nPress i to open this page in an editor tab.`, anchors: {} }));
      return { kind: 'book', book: { title: safeText(posix.basename(options.filename)), author: '', chapters, toc: chapters.map((c, chapter) => ({ title: c.title, chapter, offset: 0, depth: 0 })), images } };
    } finally { archive.close(); }
  }
  if (name.endsWith('.fb2.zip') || name.endsWith('.fbz')) {
    const result = await zippedFb2(bytes, options.entry);
    if ('entries' in result) return { kind: 'selection', entries: result.entries };
    return { kind: 'book', book: readFb2(result.bytes), entry: result.entry };
  }
  if (name.endsWith('.fb2')) return { kind: 'book', book: readFb2(bytes) };
  if (name.endsWith('.txt')) return { kind: 'book', book: readTxt(bytes, options.filename, options.encoding) };
  throw new Error('Unsupported format. Choose EPUB, FB2, FB2.ZIP, FBZ, TXT or CBZ.');
}
export async function extractImage(bytes: Uint8Array, options: ReadOptions, imageId: string): Promise<ImageData> {
  let image: Uint8Array;
  if (/\.(?:epub|cbz)$/i.test(options.filename)) {
    const archive = await Archive.open(bytes);
    try { image = await archive.read(archivePath(imageId)); } finally { archive.close(); }
  } else if (/\.(?:fb2\.zip|fbz)$/i.test(options.filename)) {
    const result = await zippedFb2(bytes, options.entry);
    if ('entries' in result) throw new Error('Choose an FB2 book before opening its images.');
    image = fb2Image(result.bytes, imageId);
  } else if (/\.fb2$/i.test(options.filename)) image = fb2Image(bytes, imageId);
  else throw new Error('This format has no embedded images.');
  return validateImage(image);
}
