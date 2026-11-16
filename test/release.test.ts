import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { zip } from './fixtures';
import { createRequire } from 'node:module';

const publish: (options: { github: ReturnType<typeof api>['github']; context: typeof context; root: string }) => Promise<{ url?: string; skipped?: boolean }> = createRequire(__filename)('../.github/scripts/publish-release.cjs');
const sha = 'a'.repeat(40);
const context = { ref: 'refs/heads/main', eventName: 'push', sha, repo: { owner: 'owner', repo: 'reader' } };
const missing = () => Object.assign(new Error('Not found'), { status: 404 });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reader-release-'));
  await mkdir(join(root, 'release-package')); await mkdir(join(root, '.github'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await writeFile(join(root, '.github', 'release-notes.md'), 'Current reader installer');
  await writeFile(join(root, 'release-package', 'vscode-reader-0.1.0.vsix'), zip([['extension/package.json', '{"version":"0.1.0"}']]));
  return root;
}
function api(existing = false, failUpload = false, head = sha) {
  type Payload = Record<string, unknown>;
  const calls: Array<{ action: string; data: Payload }> = [];
  const track = (action: string, fn: (data: Payload) => unknown) => async (data: Payload) => { calls.push({ action, data }); return fn(data); };
  let id = 20;
  const old = [{ id: 1, name: 'vscode-reader-0.1.0.vsix' }, { id: 2, name: 'vscode-reader-0.1.0.vsix.sha256' }, { id: 3, name: 'unrelated.txt' }];
  const github = {
    paginate: async (fn: (args: Payload) => Promise<{ data: unknown }>, args: Payload) => (await fn(args)).data,
    rest: {
      git: {
        getRef: track('getRef', data => { if (data.ref === 'heads/main') return { data: { object: { sha: head } } }; if (!existing) throw missing(); return { data: { object: { sha: 'b'.repeat(40) } } }; }),
        createRef: track('createRef', () => ({ data: {} })),
        updateRef: track('updateRef', () => ({ data: {} }))
      },
      repos: {
        getReleaseByTag: track('getRelease', () => { if (!existing) throw missing(); return { data: { id: 10, tag_name: 'v0.1.0', immutable: false } }; }),
        listReleases: track('listReleases', () => ({ data: [] })),
        createRelease: track('createRelease', () => ({ data: { id: 10 } })),
        listReleaseAssets: track('listAssets', () => ({ data: existing ? old : [] })),
        uploadReleaseAsset: track('upload', data => { if (failUpload) throw new Error('Upload failed'); return { data: { id: id++, name: data.name, size: (data.data as Buffer).length, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(data.data as Buffer).digest('hex') } }; }),
        deleteReleaseAsset: track('deleteAsset', () => ({ data: {} })),
        updateReleaseAsset: track('renameAsset', () => ({ data: {} })),
        updateRelease: track('publish', () => ({ data: { html_url: 'https://github.com/owner/reader/releases/tag/v0.1.0' } }))
      }
    }
  };
  return { github, calls };
}

void test('creates one 0.1.0 release with installer, checksum and current build metadata', async () => {
  const root = await fixture(); const { github, calls } = api();
  try {
    const result = await publish({ github, context, root });
    assert.match(result.url!, /v0\.1\.0$/);
    assert.equal(calls.filter(c => c.action === 'createRelease').length, 1);
    assert.equal(calls.filter(c => c.action === 'upload').length, 2);
    assert.deepEqual(calls.filter(c => c.action === 'renameAsset').map(c => c.data.name), ['vscode-reader-0.1.0.vsix', 'vscode-reader-0.1.0.vsix.sha256']);
    const final = calls.find(c => c.action === 'publish')!.data;
    assert.equal(final.name, `VSCodeReader 0.1.0 · code ${sha.slice(0, 12)}`);
    assert.equal(final.draft, false); assert.equal(final.make_latest, 'true'); assert.match(final.body as string, /SHA-256:/); assert.match(final.body as string, /aaaaaaa/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('replaces an existing release only after successful replacement uploads', async () => {
  const updatedContext = { ...context, sha: 'c'.repeat(40) };
  const root = await fixture(); const { github, calls } = api(true, false, updatedContext.sha);
  try {
    await publish({ github, context: updatedContext, root });
    assert.equal(calls.filter(c => c.action === 'createRelease').length, 0);
    assert.ok(calls.find(c => c.action === 'updateRef')!.data.force);
    assert.equal(calls.find(c => c.action === 'updateRef')!.data.sha, updatedContext.sha);
    assert.equal(calls.find(c => c.action === 'publish')!.data.name, `VSCodeReader 0.1.0 · code ${updatedContext.sha.slice(0, 12)}`);
    assert.deepEqual(calls.filter(c => c.action === 'deleteAsset').map(c => c.data.asset_id), [1, 2]);
    const lastUpload = calls.map(c => c.action).lastIndexOf('upload');
    assert.ok(calls.findIndex(c => c.action === 'deleteAsset') > lastUpload);
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('failed uploads retain the previously published installer', async () => {
  const root = await fixture(); const { github, calls } = api(true, true);
  try {
    await assert.rejects(publish({ github, context, root }), /Upload failed/);
    assert.equal(calls.filter(c => c.action === 'deleteAsset').length, 0);
    assert.equal(calls.filter(c => c.action === 'publish').length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('stale commits, pull requests and invalid versions cannot publish', async () => {
  const root = await fixture(); const { github, calls } = api(false, false, 'b'.repeat(40));
  try {
    assert.deepEqual(await publish({ github, context, root }), { skipped: true });
    assert.equal(calls.filter(c => c.action !== 'getRef').length, 0);
    await assert.rejects(publish({ github, context: { ...context, eventName: 'pull_request' }, root }), /main/);
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    await assert.rejects(publish({ github, context, root }), /0\.1\.0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
