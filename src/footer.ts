import stringWidth from 'string-width';
import { safeText } from './book';

export type HintMode = 'reading' | 'hidden' | 'picker' | 'search' | 'location' | 'name' | 'image-loading';
export interface HintState { mode: HintMode; columns: number; images?: boolean; bookmarks?: boolean; end?: boolean; message?: string }
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function fitCells(text: string, width: number): string {
  const clean = safeText(text).replace(/\n/g, ' ');
  if (stringWidth(clean) <= width) return clean;
  if (width < 1) return '';
  let result = '', used = 0;
  for (const part of segments.segment(clean)) {
    const size = stringWidth(part.segment);
    if (used + size > width - 1) break;
    result += part.segment; used += size;
  }
  return result + '…';
}
export function footerText(state: HintState): string {
  const width = Math.max(0, state.columns - 1);
  const variants: string[] = [];
  if (state.mode === 'hidden') variants.push('Text hidden | r resume | q close | ? help', 'r resume | q close | ? help', 'r resume | q close', 'r resume', 'r');
  else if (state.mode === 'image-loading') variants.push('Opening image… | Cancel in the progress notification | Esc hide | q close', 'Opening image… | Esc hide | q close', 'Opening image…');
  else if (state.mode !== 'reading') {
    const action = state.mode === 'search' ? 'Search text' : state.mode === 'location' ? 'Location number or 40%' : state.mode === 'name' ? 'Bookmark name' : 'Select an item';
    variants.push(`${action} | Enter confirm | Esc cancel`, 'Enter confirm | Esc cancel', 'Enter OK | Esc cancel', 'Esc cancel');
  } else {
    const image = state.images ? ' | i images' : '';
    const bookmarks = state.bookmarks ? ' | B bookmarks' : '';
    const start = state.end ? 'End of book | PgUp back' : 'Space/PgDn next | PgUp back';
    variants.push(
      `${start} | j/k scroll | n/p chapter | g contents | / search | b bookmark${bookmarks}${image} | l location | s progress | ? help | Esc hide | q close`,
      `${state.end ? 'End | PgUp back' : 'Space/PgUp page'} | g toc | / find | b save${state.bookmarks ? ' | B list' : ''}${state.images ? ' | i img' : ''} | ? help | Esc hide`,
      `${state.end ? 'End | PgUp back' : 'Space next'} | b save${image} | ? help | Esc hide`,
      `${state.end ? 'PgUp back' : 'Space next'} | b save | ? help`,
      '? help | Esc hide', '? help', '?'
    );
  }
  const hint = variants.find(text => stringWidth(text) <= width) ?? '';
  return state.message && state.mode === 'reading' ? fitCells(`${state.message} | ${hint}`, width) : hint;
}
export function terminalName(template: string, title: string, filename: string): string {
  // "output" was the neutral default; existing settings should pick up book titles.
  const pattern = !template.trim() || template === 'output' ? '{title}' : template;
  return safeText(pattern.split('{title}').join(title || filename).split('{filename}').join(filename)).replace(/\s+/g, ' ').trim().slice(0, 100) || 'Reader';
}
