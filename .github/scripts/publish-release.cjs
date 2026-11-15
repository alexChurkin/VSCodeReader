const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

module.exports = async function publishRelease({ github, context, root = process.cwd(), artifactDirectory = 'release-package' }) {
  if (context.ref !== 'refs/heads/main' || context.eventName === 'pull_request') throw new Error('Releases can only be published from main.');
  const repo = context.repo;
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.1.0') throw new Error('The release version must stay at 0.1.0.');
  const name = 'vscode-reader-0.1.0.vsix';
  const bytes = await fs.readFile(path.resolve(root, artifactDirectory, name));
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Missing or invalid VSIX package.');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const notes = await fs.readFile(path.join(root, '.github', 'release-notes.md'), 'utf8');
  const main = await github.rest.git.getRef({ ...repo, ref: 'heads/main' });
  if (main.data.object.sha !== context.sha) return { skipped: true };
  const tag = 'v0.1.0';
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({ ...repo, tag })).data; }
  catch (error) {
    if (error.status !== 404) throw error;
    const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
    release = releases.find(item => item.tag_name === tag);
  }
  if (release?.immutable) throw new Error('The 0.1.0 release is immutable. Disable immutable releases to keep the single rolling build.');
  try {
    await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
    await github.rest.git.updateRef({ ...repo, ref: `tags/${tag}`, sha: context.sha, force: true });
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha: context.sha });
  }
  const body = `${notes.trim()}\n\nBuild commit: [${context.sha.slice(0, 7)}](https://github.com/${repo.owner}/${repo.repo}/commit/${context.sha})\n\nSHA-256: \`${checksum}\`\n`;
  if (!release) release = (await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: context.sha, name: 'VSCodeReader 0.1.0', body, draft: true, prerelease: false })).data;
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  const upload = async (filename, data, contentType) => {
    const stagedName = `${filename}.upload-${context.sha.slice(0, 12)}`;
    for (const asset of assets.filter(a => a.name === stagedName)) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    const result = await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: release.id, name: stagedName, data, headers: { 'content-type': contentType, 'content-length': data.length } });
    if (result.data.state !== 'uploaded' || result.data.size !== data.length) throw new Error(`Incomplete release upload: ${filename}`);
    const digest = createHash('sha256').update(data).digest('hex');
    if (result.data.digest && result.data.digest !== `sha256:${digest}`) throw new Error(`Release asset checksum mismatch: ${filename}`);
    return result.data;
  };
  // Upload both replacements before deleting the published installers.
  const vsix = await upload(name, bytes, 'application/octet-stream');
  const hash = await upload(name + '.sha256', Buffer.from(`${checksum}  ${name}\n`), 'text/plain');
  for (const asset of assets) {
    if (/^vscode-reader-.*\.vsix(?:\.sha256)?(?:\.upload-[a-f0-9]+)?$/.test(asset.name) && asset.id !== vsix.id && asset.id !== hash.id) {
      // Stale uploads with the current staging names were already removed above.
      if (asset.name === vsix.name || asset.name === hash.name) continue;
      await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    }
  }
  await github.rest.repos.updateReleaseAsset({ ...repo, asset_id: vsix.id, name });
  await github.rest.repos.updateReleaseAsset({ ...repo, asset_id: hash.id, name: name + '.sha256' });
  const published = await github.rest.repos.updateRelease({ ...repo, release_id: release.id, tag_name: tag, target_commitish: context.sha, name: 'VSCodeReader 0.1.0', body, draft: false, prerelease: false, make_latest: 'true' });
  return { url: published.data.html_url };
};
