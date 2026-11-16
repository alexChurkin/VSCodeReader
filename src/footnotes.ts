import type { Chapter, Locator } from './book';
import type { LinkReference } from './xml';

export function fragment(href: string): string | undefined {
  if (!href.startsWith('#')) return undefined;
  try { return decodeURIComponent(href.slice(1)); } catch { return undefined; }
}
export function attachFootnotes(chapter: Chapter, links: LinkReference[], resolve: (href: string) => Locator | undefined): void {
  chapter.footnotes = links.flatMap((link, index) => {
    const target = resolve(link.href);
    return target && link.length > 0 ? [{ id: `reference-${index}`, offset: link.offset, length: link.length, label: link.label || 'Footnote', target }] : [];
  });
}
