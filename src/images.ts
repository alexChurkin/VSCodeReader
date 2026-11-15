import { LIMITS } from './archive';
export const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
export const isRasterMediaType = (type: string | undefined): boolean => !!type && rasterTypes.has(type.toLowerCase());
export interface ImageData { bytes: Uint8Array; extension: string; width: number; height: number }

// Detect from bytes, never use a book-supplied filename/extension for extraction.
export function validateImage(data: Uint8Array): ImageData {
  if (!data.length || data.length > LIMITS.entry) throw new Error('Image is empty or exceeds the 10 MiB limit.');
  const b = Buffer.from(data);
  let extension = '', width = 0, height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') {
    extension = 'png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    extension = 'gif'; width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    extension = 'jpg';
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) break;
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    extension = 'webp';
    const type = b.toString('ascii', 12, 16);
    if (type === 'VP8X') { width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
    else if (type === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else if (type === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
  } else if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM' && b.readUInt32LE(14) >= 40) {
    extension = 'bmp'; width = b.readInt32LE(18); height = Math.abs(b.readInt32LE(22));
  }
  if (!extension || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40_000_000) throw new Error('Unsupported, invalid or oversized image (PNG, JPEG, GIF, WebP or BMP; up to 40 megapixels).');
  return { bytes: data, extension, width, height };
}
