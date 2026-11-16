export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

export function mouseInput(data: string): { pending: string; wheel: number; remainder: string } | undefined {
  if (!data.startsWith('\x1b[<')) return undefined;
  let rest = data, wheel = 0, events = 0;
  while (rest) {
    if (!rest.startsWith('\x1b[<')) return { pending: '', wheel, remainder: rest };
    const match = /^\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/.exec(rest);
    if (!match) return { pending: /^\x1b\[<[\d;]*$/.test(rest) && rest.length < 32 ? rest : '', wheel, remainder: '' };
    // Ignore clicks, releases, horizontal scrolling and invalid zero coordinates.
    const button = Number(match[1]) & ~28;
    if (match[4] === 'M' && Number(match[2]) > 0 && Number(match[3]) > 0) {
      if (button === 64) wheel--; else if (button === 65) wheel++;
    }
    rest = rest.slice(match[0].length);
    if (++events >= 256) break;
  }
  return { pending: '', wheel, remainder: '' };
}
