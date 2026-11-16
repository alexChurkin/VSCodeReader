import type * as vscode from 'vscode';
import type { ReaderTerminal } from './terminal';

interface ImageLink extends vscode.TerminalLink {
  reader: ReaderTerminal;
  imageId: string;
  revision: number;
}

export class ReaderImageLinks implements vscode.TerminalLinkProvider<ImageLink> {
  constructor(private readonly findReader: (terminal: vscode.Terminal) => ReaderTerminal | undefined) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken): ImageLink[] {
    if (token.isCancellationRequested) return [];
    const reader = this.findReader(context.terminal);
    if (!reader) return [];
    return reader.imageLinks(context.line).map(link => ({ ...link, reader, tooltip: 'Open illustration in an editor tab' }));
  }

  async handleTerminalLink(link: ImageLink): Promise<void> {
    await link.reader.openImageLink(link.imageId, link.revision);
  }
}
