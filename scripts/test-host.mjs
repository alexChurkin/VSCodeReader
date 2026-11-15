import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = root + '.vscode-test/reader-profile';
await rm(profile, { recursive: true, force: true });
await build({ entryPoints: [root + 'test/host.ts'], outfile: root + 'dist/host.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' });
for (const pass of ['write', 'restore']) await runTests({
  extensionTestsEnv: { READER_TEST_PASS: pass, READER_TEST_STORAGE: profile + '/User/globalStorage/alexchurkin.vscode-reader/reading-state-v1' },
  version: process.env.VSCODE_TEST_VERSION || '1.95.3',
  extensionDevelopmentPath: root,
  extensionTestsPath: root + 'dist/host.cjs',
  launchArgs: ['--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes']
});
