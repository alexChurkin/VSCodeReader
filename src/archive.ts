import * as yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { posix } from 'node:path';

export const LIMITS = { archive: 100 * 1024 * 1024, total: 300 * 1024 * 1024, entry: 10 * 1024 * 1024, entries: 10_000, text: 32 * 1024 * 1024 };
export function archivePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || /^(\/|[a-z][\w+.-]*:)/i.test(path) || path.split('/').includes('..')) throw new Error('Unsafe archive path.');
  return posix.normalize(path);
}
export function resolveHref(base: string, href: string): { path: string; fragment: string } {
  if (/^(\/|[a-z][\w+.-]*:)/i.test(href) || href.includes('\\')) throw new Error('External or absolute resource reference is not supported.');
  const hash = href.indexOf('#');
  const pathPart = (hash < 0 ? href : href.slice(0, hash)).split('?')[0];
  const path = pathPart ? posix.join(posix.dirname(base), decodeURIComponent(pathPart)) : base;
  return { path: archivePath(path), fragment: hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)) };
}

export class Archive {
  private used = 0;
  private constructor(private zip: ZipFile, readonly entries: Map<string, Entry>, private signal?: AbortSignal) {}
  static async open(bytes: Uint8Array, signal?: AbortSignal): Promise<Archive> {
    if (bytes.length > LIMITS.archive) throw new Error('Book exceeds the 100 MiB archive limit.');
    signal?.throwIfAborted();
    const zip = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!));
    });
    try {
      const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
        const found = new Map<string, Entry>();
        let total = 0, count = 0;
        const abort = () => { zip.close(); reject(new Error('Opening cancelled.')); };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        zip.on('error', error => { cleanup(); reject(error); });
        zip.on('end', () => { cleanup(); resolve(found); });
        zip.on('entry', (entry: Entry) => {
          try {
            signal?.throwIfAborted();
            const name = archivePath(entry.fileName);
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (mode === 0xa000) throw new Error('Archive symlinks are not supported.');
            if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted archives are not supported.');
            total += entry.uncompressedSize;
            if (++count > LIMITS.entries || total > LIMITS.total) throw new Error('Archive exceeds the entry count or unpacked size limit.');
            if (found.has(name)) throw new Error('Duplicate archive path.');
            found.set(name, entry);
            zip.readEntry();
          } catch (error) { cleanup(); reject(error); }
        });
        zip.readEntry();
      });
      return new Archive(zip, entries, signal);
    } catch (error) { zip.close(); throw error; }
  }
  has(path: string): boolean { return this.entries.has(archivePath(path)); }
  async read(path: string): Promise<Buffer> {
    this.signal?.throwIfAborted();
    const entry = this.entries.get(archivePath(path));
    if (!entry) throw new Error(`Missing resource: ${path}`);
    if (entry.uncompressedSize > LIMITS.entry) throw new Error('Resource exceeds the 10 MiB limit.');
    return new Promise<Buffer>((resolve, reject) => {
      this.zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error ?? new Error('Cannot read resource.')); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        const abort = () => stream.destroy(new Error('Opening cancelled.'));
        this.signal?.addEventListener('abort', abort, { once: true });
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          this.used += chunk.length;
          if (size > LIMITS.entry || this.used > LIMITS.text) stream.destroy(new Error('Extracted text exceeds the resource or 32 MiB book text limit.'));
          else chunks.push(chunk);
        });
        stream.once('error', reject);
        stream.once('close', () => this.signal?.removeEventListener('abort', abort));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        if (this.signal?.aborted) abort();
      });
    });
  }
  close(): void { this.zip.close(); }
}
