import { Marked } from 'marked';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const noteId = (label: string) => 'reader-footnote-' + label.trim().toLowerCase();
const markdown = new Marked({ gfm: true, async: false }, {
  extensions: [
    {
      name: 'readerFootnoteDefinition', level: 'block',
      start: source => source.match(/^ {0,3}\[\^[^\]\n]+\]:/m)?.index,
      tokenizer(source) {
        const match = /^ {0,3}\[\^([^\]\n]{1,128})\]:[ \t]*([^\n]*(?:\n(?: {4}|\t)[^\n]*)*)(?:\n|$)/.exec(source);
        if (!match) return undefined;
        return { type: 'readerFootnoteDefinition', raw: match[0], label: match[1], noteId: noteId(match[1]), tokens: this.lexer.blockTokens(match[2].replace(/\n(?: {4}|\t)/g, '\n')) };
      },
      renderer(token) {
        return `<section id="${escape(token.noteId as string)}" role="doc-footnote"><p>[${escape(token.label as string)}]</p>${this.parser.parse(token.tokens ?? [])}</section>\n`;
      },
    },
    {
      name: 'readerFootnoteReference', level: 'inline',
      start: source => source.indexOf('[^'),
      tokenizer(source) {
        const match = /^\[\^([^\]\n]{1,128})\]/.exec(source);
        if (!match) return undefined;
        return { type: 'readerFootnoteReference', raw: match[0], label: match[1], noteId: noteId(match[1]) };
      },
      renderer(token) {
        return `<a role="doc-noteref" href="#${encodeURIComponent(token.noteId as string)}">[${escape(token.label as string)}]</a>`;
      },
    },
  ],
});
export function markdownHtml(source: string): string { return markdown.parse(source, { async: false }); }
