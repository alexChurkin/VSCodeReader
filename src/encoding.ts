export type TextEncoding = 'utf-8' | 'windows-1251';
export function decodeText(bytes: Uint8Array, fallback: string = 'utf-8'): string {
  let encoding = fallback;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error(`Cannot decode document as ${encoding}. For TXT, select UTF-8 or Windows-1251 in vscodeReader.textEncoding.`); }
}
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0 || bytes[1] === 0 || bytes[0] === 0xff || bytes[0] === 0xfe) {
    return decodeText(bytes, bytes[0] === 0 ? 'utf-16be' : 'utf-16le');
  }
  const head = Buffer.from(bytes.subarray(0, 200)).toString('ascii');
  const encoding = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ?? 'utf-8';
  return decodeText(bytes, encoding);
}
