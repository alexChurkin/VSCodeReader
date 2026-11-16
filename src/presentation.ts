import type { Element, ParentNode } from 'domhandler';
import type { TextStyle } from './book';

export interface CssRule { selector: string; declarations: Record<string, string>; specificity: number; order: number }
const allowed = new Set(['font-weight', 'font-style', 'font-size', 'font-variation-settings', 'text-decoration', 'text-decoration-line', 'white-space', 'text-indent', 'display', 'visibility']);
function declarations(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const declaration of source.split(';')) {
    const colon = declaration.indexOf(':');
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (colon >= 0 && allowed.has(name)) result[name] = declaration.slice(colon + 1).trim();
  }
  return result;
}
function flatCss(source: string): string {
  // Ignore entire @-rules, especially conditional print/media rules. Taking
  // their inner declarations out of context could hide normal reading text.
  let result = '', index = 0;
  while (index < source.length) {
    if (source[index] !== '@') { result += source[index++]; continue; }
    let depth = 0, quote = '';
    while (index < source.length) {
      const character = source[index++];
      if (quote) {
        if (character === '\\') index++;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '{') depth++;
      else if (character === '}' && --depth <= 0) break;
      else if (character === ';' && !depth) break;
    }
  }
  return result;
}
export function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of flatCss(source.replace(/\/\*[\s\S]*?\*\//g, '')).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const selector = raw.trim();
      // A deliberately small text-only subset: no resource loading, pseudo
      // content, font faces, layout engine or script-capable CSS evaluation.
      if (!selector || /[@:[\]+~\\]/.test(selector)) continue;
      const specificity = (selector.match(/#/g)?.length ?? 0) * 100 + (selector.match(/\./g)?.length ?? 0) * 10 + selector.split(/[\s>]+/).filter(part => /^[\p{L}_]/u.test(part)).length;
      const properties = declarations(match[2]);
      if (!Object.keys(properties).length) continue;
      rules.push({ selector, declarations: properties, specificity, order: rules.length });
      if (rules.length >= 5000) return rules;
    }
  }
  return rules;
}
function simpleMatch(node: Element, selector: string): boolean {
  const parts = selector.match(/^[\p{L}\p{N}_*-]+|[.#][\p{L}\p{N}_-]+/gu);
  if (!parts || parts.join('') !== selector) return false;
  const classes = new Set((node.attribs.class ?? '').split(/\s+/));
  return parts.every(part => part[0] === '.' ? classes.has(part.slice(1)) : part[0] === '#' ? node.attribs.id === part.slice(1) : part === '*' || node.name.split(':').at(-1)?.toLowerCase() === part.toLowerCase());
}
function matches(node: Element, selector: string): boolean {
  const tokens = selector.replace(/\s*>\s*/g, ' > ').split(/\s+/);
  let current: Element | undefined = node;
  if (!simpleMatch(current, tokens.pop()!)) return false;
  while (tokens.length) {
    const token = tokens.pop()!;
    const direct = token === '>';
    const wanted = direct ? tokens.pop() : token;
    if (!wanted) return false;
    let parent: ParentNode | null = current.parent;
    current = undefined;
    while (parent && 'name' in parent && 'attribs' in parent) {
      if (simpleMatch(parent, wanted)) { current = parent; break; }
      if (direct) break;
      parent = parent.parent;
    }
    if (!current) return false;
  }
  return true;
}
export interface Presentation extends TextStyle { listItem: boolean; hanging: boolean; quote: number; scale: number; pre: boolean; hidden: boolean; heading: number }
export const plainPresentation: Presentation = { listItem: false, hanging: false, quote: 0, scale: 1, pre: false, hidden: false, heading: 0 };
export function presentation(node: Element, inherited: Presentation, rules: CssRule[], fb2: boolean): Presentation {
  const tag = node.name.split(':').at(-1)!.toLowerCase();
  const style = { ...inherited };
  if (['b', 'strong', 'th', 'caption'].includes(tag)) style.bold = true;
  if (['i', 'em', 'cite'].includes(tag)) style.italic = true;
  if (['u', 'ins'].includes(tag)) style.underline = true;
  if (['s', 'del', 'strike'].includes(tag)) style.strike = true;
  if (tag === 'pre') style.pre = true;
  if (tag === 'blockquote' || /(?:^|\s)quote(?:\s|$)/i.test(node.attribs.class ?? '')) style.quote++;
  const values = new Map<string, { value: string; priority: number }>();
  const apply = (properties: Record<string, string>, weight: number) => {
    for (const [property, raw] of Object.entries(properties)) {
      const important = /!important\s*$/i.test(raw);
      const priority = weight + (important ? 100_000_000 : 0);
      if (!values.has(property) || values.get(property)!.priority <= priority) values.set(property, { value: raw.replace(/!important\s*$/i, '').trim().toLowerCase(), priority });
    }
  };
  for (const rule of rules) if (matches(node, rule.selector)) apply(rule.declarations, rule.specificity * 5001 + rule.order);
  apply(declarations(node.attribs.style ?? ''), 5_000_000);
  const get = (name: string) => values.get(name)?.value;
  const weight = get('font-weight');
  if (weight) style.bold = /bold/.test(weight) || Number(weight) >= 600;
  const italic = get('font-style'); if (italic) style.italic = /italic|oblique/.test(italic);
  const variation = get('font-variation-settings');
  const axis = (name: string) => new RegExp(`["']${name}["']\\s+(-?[\\d.]+)`).exec(variation ?? '')?.[1];
  if (axis('wght') !== undefined) style.bold = Number(axis('wght')) >= 600;
  if (axis('slnt') !== undefined) style.italic = Number(axis('slnt')) !== 0;
  if (axis('ital') !== undefined) style.italic = Number(axis('ital')) !== 0;
  const decoration = get('text-decoration-line') ?? get('text-decoration');
  if (decoration) { style.underline = decoration.includes('underline'); style.strike = decoration.includes('line-through'); }
  const size = get('font-size');
  if (size) {
    const value = Number.parseFloat(size);
    if (Number.isFinite(value)) style.scale = Math.max(0.1, Math.min(10, size.endsWith('rem') ? value : size.endsWith('em') ? inherited.scale * value : size.endsWith('%') ? inherited.scale * value / 100 : size.endsWith('pt') ? value / 12 : size.endsWith('px') ? value / 16 : inherited.scale));
  }
  const textIndent = get('text-indent'); if (textIndent && Number.isFinite(Number.parseFloat(textIndent))) style.hanging = Number.parseFloat(textIndent) < 0;
  const whiteSpace = get('white-space'); if (whiteSpace) style.pre = /pre|break-spaces/.test(whiteSpace);
  style.listItem ||= tag === 'li' || node.attribs.role === 'listitem' || get('display') === 'list-item';
  style.hidden ||= get('display') === 'none' || get('visibility') === 'hidden';
  const semantic = /^h([1-6])$/.exec(tag)?.[1] ?? (/^heading[-_]?([1-6])(?:\b|[-_])/i.exec(node.attribs.class ?? '')?.[1]);
  const level = semantic ? Number(semantic) : node.attribs.role === 'heading' ? Math.max(1, Math.min(6, Number(node.attribs['aria-level']) || 2)) : fb2 && tag === 'title' ? 2 : fb2 && tag === 'subtitle' ? 3 : 0;
  const block = ['p', 'div', 'section'].includes(tag);
  style.heading = level || (block && style.bold && style.scale >= 1.1 ? style.scale >= 1.6 ? 1 : style.scale >= 1.3 ? 2 : 3 : inherited.heading);
  if (level) { style.bold = true; style.underline = true; }
  if (style.heading && !inherited.heading) style.underline = true;
  return style;
}
