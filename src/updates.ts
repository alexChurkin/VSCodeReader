import * as vscode from 'vscode';
import { buildInfo, buildLabel, releaseUrl } from './build-info';

export async function openLatestRelease(): Promise<boolean> {
  return vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
}
export async function showInstalledBuild(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    `VSCodeReader ${buildLabel()}${buildInfo.builtAt ? `\nBuilt: ${buildInfo.builtAt}` : ''}`,
    { modal: true, detail: `Installed code: ${buildInfo.revision}\nThe extension version stays at 0.1.0. Compare this revision with the title of the latest GitHub Release. Install its VSIX with --force, then reload VS Code.` },
    'Open latest release', 'Copy revision',
  );
  if (action === 'Open latest release') await openLatestRelease();
  else if (action === 'Copy revision') await vscode.env.clipboard.writeText(buildInfo.revision);
}
