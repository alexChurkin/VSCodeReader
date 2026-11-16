import { execFileSync } from 'node:child_process';
import { context, build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function currentBuild() {
  let revision = 'development', dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* Source archives can be built without Git metadata. */ }
  return { version: '0.1.0', revision, builtAt: new Date().toISOString(), dirty };
}
const buildInfo = currentBuild();
if (process.argv.includes('--watch')) buildInfo.dirty = true;
const options = {
  define: { __READER_BUILD__: JSON.stringify(buildInfo) },
  entryPoints: { extension: 'src/extension.ts', worker: 'src/worker.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
  sourcemap: true, legalComments: 'linked', metafile: true,
  plugins: [{
    name: 'build-info',
    setup(builder) {
      builder.onEnd(async result => { if (!result.errors.length) await writeFile('dist/build-info.json', JSON.stringify(buildInfo, null, 2) + '\n'); });
    }
  }, {
    name: 'third-party-notices',
    setup(builder) {
      builder.onEnd(async result => {
        if (!result.metafile) return;
        const packages = new Map();
        for (const input of Object.keys(result.metafile.inputs)) {
          if (!input.includes('node_modules/')) continue;
          let directory = dirname(resolve(input));
          while (directory.includes('node_modules')) {
            try {
              const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
              if (metadata.name) { packages.set(directory, metadata); break; }
            } catch { /* Continue to package root. */ }
            directory = dirname(directory);
          }
        }
        const notices = [];
        for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
          const licenses = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
          const texts = await Promise.all(licenses.map(file => readFile(join(directory, file), 'utf8')));
          if (!texts.length && metadata.name === '@nodable/entities') texts.push(await readFile('licenses/nodable-LICENSE', 'utf8'));
          if (!texts.length) throw new Error(`Missing bundled dependency license: ${metadata.name}`);
          notices.push(`${metadata.name} ${metadata.version}\nLicense: ${metadata.license}\n\n${texts.join('\n')}`);
        }
        await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n----------------------------------------\n\n'));
      });
    }
  }]
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
