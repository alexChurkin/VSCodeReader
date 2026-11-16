export interface BuildInfo { version: string; revision: string; builtAt: string; dirty: boolean }
declare const __READER_BUILD__: BuildInfo | undefined;
export const buildInfo: BuildInfo = typeof __READER_BUILD__ === 'undefined'
  ? { version: '0.1.0', revision: 'development', builtAt: '', dirty: true }
  : __READER_BUILD__!;
export const releaseUrl = 'https://github.com/alexChurkin/VSCodeReader/releases/latest';
export function buildLabel(info: BuildInfo = buildInfo): string {
  return `${info.version} · code ${info.revision.slice(0, 12)}${info.dirty ? ' (local changes)' : ''}`;
}
