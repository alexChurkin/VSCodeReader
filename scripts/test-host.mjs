import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [root + 'test/host.ts'], outfile: root + 'dist/host.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' });
await runTests({
  version: process.env.VSCODE_TEST_VERSION || '1.95.3',
  extensionDevelopmentPath: root,
  extensionTestsPath: root + 'dist/host.cjs',
  launchArgs: ['--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes']
});
