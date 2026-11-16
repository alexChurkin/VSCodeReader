import type * as vscode from 'vscode';
import type { ReaderTerminal } from './terminal';

interface ReaderLink extends vscode.TerminalLink {
  reader: ReaderTerminal;
  kind: 'image' | 'footnote';
  id: string;
  revision: number;
}

export class ReaderLinks implements vscode.TerminalLinkProvider<ReaderLink> {
  constructor(private readonly findReader: (terminal: vscode.Terminal) => ReaderTerminal | undefined) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken): ReaderLink[] {
    if (token.isCancellationRequested) return [];
    const reader = this.findReader(context.terminal);
    if (!reader) return [];
    return [
      ...reader.imageLinks(context.line).map(link => ({ ...link, id: link.imageId, kind: 'image' as const, reader, tooltip: 'Open illustration in an editor tab' })),
      ...reader.footnoteLinks(context.line).map(link => ({ ...link, kind: 'footnote' as const, reader, tooltip: 'Follow internal reference (u to return)' })),
    ];
  }

  async handleTerminalLink(link: ReaderLink): Promise<void> {
    if (link.kind === 'image') await link.reader.openImageLink(link.id, link.revision);
    else link.reader.openFootnoteLink(link.id, link.revision);
  }
}
