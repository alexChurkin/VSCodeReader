import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { LIMITS } from './archive';
import { localImagePath } from './markup';
import { validateImage, type ImageData } from './images';

export async function readLocalImage(document: string, href: string): Promise<ImageData> {
  const path = localImagePath(href);
  const root = await realpath(dirname(document));
  const target = await realpath(resolve(root, ...path.split('/')));
  const within = relative(root, target);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Image resolves outside the document folder.');
  const initial = await stat(target);
  if (!initial.isFile() || initial.size > LIMITS.entry) throw new Error('Image must be a regular file up to 10 MiB.');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > LIMITS.entry) throw new Error('Image must be a regular file up to 10 MiB.');
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= LIMITS.entry) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, LIMITS.entry + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    if (size > LIMITS.entry) throw new Error('Image exceeds the 10 MiB limit.');
    return validateImage(Buffer.concat(chunks));
  } finally { await file.close(); }
}
