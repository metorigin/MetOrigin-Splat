import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { migrateWindowsLayout } from './MigrateLocalLayout.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'windows migration 中文 ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'packaging/shared'), { recursive: true });
  for (const name of ['engine-paths.json', 'cache-paths.json', 'artifact-paths.json']) await fs.cp(new URL(`../../packaging/shared/${name}`, import.meta.url), path.join(root, 'packaging/shared', name));
  const old = path.join(root, 'target/distribution/windows-x64');
  const target = path.join(root, '.engines/windows-x64/distribution');
  const manifest = { schema_version: 1, platform: 'windows-x64', pack_version: 'fixture.1', engines: {} };
  for (const name of ['ffmpeg', 'colmap', 'brush']) {
    const relative = `${name}/bin/${name}.exe`, data = Buffer.from(`exact ${name} bytes`);
    await fs.mkdir(path.dirname(path.join(old, 'engines', relative)), { recursive: true });
    await fs.writeFile(path.join(old, 'engines', relative), data);
    manifest.engines[name] = { files: [{ path: relative, size_bytes: data.length, sha256: sha(data) }], executables: { [name]: relative } };
  }
  const ffprobe = Buffer.from('exact ffprobe bytes');
  await fs.writeFile(path.join(old, 'engines/ffmpeg/bin/ffprobe.exe'), ffprobe);
  manifest.engines.ffmpeg.files.push({ path: 'ffmpeg/bin/ffprobe.exe', size_bytes: ffprobe.length, sha256: sha(ffprobe) });
  manifest.engines.ffmpeg.executables.ffprobe = 'ffmpeg/bin/ffprobe.exe';
  await fs.writeFile(path.join(old, 'engines/engine-manifest.json'), JSON.stringify(manifest));
  await fs.mkdir(path.join(old, 'licenses')); await fs.writeFile(path.join(old, 'licenses/notice.txt'), 'exact notice');
  return { root, old, target, manifest };
}

test('known pack migration preserves every byte and is idempotent without a target alias', async t => {
  const f = await fixture(t);
  const manifestSha = sha(await fs.readFile(path.join(f.old, 'engines/engine-manifest.json')));
  const result = await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] });
  assert.equal(result[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(f.target, 'licenses/notice.txt'), 'utf8'), 'exact notice');
  await assert.rejects(fs.lstat(f.old), { code: 'ENOENT' });
  const proof = JSON.parse(await fs.readFile(path.join(f.root, 'artifacts/verification/windows-x64/engine-layout-migrations.json'), 'utf8'));
  assert.deepEqual(proof, { schema_version: 1, entries: [{ legacy: 'target/distribution/windows-x64',
    target: '.engines/windows-x64/distribution', manifest_sha256: manifestSha, platform: 'windows-x64', status: 'verified' }] });
  assert.deepEqual(await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] }), []);
});

test('different destination and corrupt/foreign manifests preserve existing source data', async t => {
  for (const kind of ['destination', 'hash', 'platform']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'destination') { await fs.mkdir(f.target, { recursive: true }); await fs.writeFile(path.join(f.target, 'keep'), 'foreign'); }
    if (kind === 'hash') await fs.writeFile(path.join(f.old, 'engines/colmap/bin/colmap.exe'), 'changed');
    if (kind === 'platform') { f.manifest.platform = 'macos-arm64'; await fs.writeFile(path.join(f.old, 'engines/engine-manifest.json'), JSON.stringify(f.manifest)); }
    await assert.rejects(migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] }), /different data|integrity failure|invalid Windows manifest/);
    assert.equal(await fs.readFile(path.join(f.old, 'licenses/notice.txt'), 'utf8'), 'exact notice');
    if (kind === 'destination') assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'foreign');
  });
});

test('identical existing destination is verified before removing only the redundant old tree', async t => {
  const f = await fixture(t);
  await fs.cp(f.old, f.target, { recursive: true });
  const result = await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] });
  assert.equal(result[0].status, 'identical-destination');
  assert.equal(await fs.readFile(path.join(f.target, 'licenses/notice.txt'), 'utf8'), 'exact notice');
  await assert.rejects(fs.lstat(f.old), { code: 'ENOENT' });
  const proof = JSON.parse(await fs.readFile(path.join(f.root, 'artifacts/verification/windows-x64/engine-layout-migrations.json'), 'utf8'));
  assert.equal(proof.entries[0].manifest_sha256, sha(await fs.readFile(path.join(f.target, 'engines/engine-manifest.json'))));
});

test('migration proof follows artifact configuration and merges stable and candidate identities', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.root, 'packaging/shared/artifact-paths.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8')); config.root = 'deliveries';
  await fs.writeFile(configFile, JSON.stringify(config));
  const alignment = path.join(f.root, 'target/distribution/windows-x64-alignment');
  await fs.cp(f.old, alignment, { recursive: true });
  await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] });
  await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['alignmentRoot'] });
  const proof = JSON.parse(await fs.readFile(path.join(f.root, 'deliveries/verification/windows-x64/engine-layout-migrations.json'), 'utf8'));
  assert.deepEqual(proof.entries.map(entry => entry.legacy), ['target/distribution/windows-x64', 'target/distribution/windows-x64-alignment']);
  assert.equal(proof.entries[1].target, '.engines/windows-x64/alignment');
  await assert.rejects(fs.lstat(path.join(f.root, 'artifacts')), { code: 'ENOENT' });
});

test('foreign receipt or active proof lock blocks migration before changing the source', async t => {
  for (const kind of ['receipt', 'lock']) await t.test(kind, async t => {
    const f = await fixture(t), folder = path.join(f.root, 'artifacts/verification/windows-x64');
    await fs.mkdir(folder, { recursive: true });
    if (kind === 'receipt') await fs.writeFile(path.join(folder, 'engine-layout-migrations.json'), '{"schema_version":99}');
    else await fs.mkdir(path.join(folder, 'engine-layout-migrations.json.lock'));
    await assert.rejects(migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] }), /Unrecognized migration receipt|EEXIST/);
    assert.equal(await fs.readFile(path.join(f.old, 'licenses/notice.txt'), 'utf8'), 'exact notice');
    await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' });
  });
});

test('linked source contents and destination ancestors are refused without following them', async t => {
  for (const kind of ['contents', 'destination']) await t.test(kind, async t => {
    const f = await fixture(t), foreign = path.join(f.root, 'unrelated');
    await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'user bytes');
    if (kind === 'contents') await fs.symlink(foreign, path.join(f.old, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    else { await fs.mkdir(path.join(f.root, '.engines')); await fs.symlink(foreign, path.join(f.root, '.engines/windows-x64'), process.platform === 'win32' ? 'junction' : 'dir'); }
    await assert.rejects(migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] }), /linked|non-regular/);
    assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'user bytes');
    assert.equal(await fs.readFile(path.join(f.old, 'licenses/notice.txt'), 'utf8'), 'exact notice');
  });
});

test('all selected migrations preflight before moving any pack and explicit keys leave unrelated cache alone', async t => {
  const f = await fixture(t), cache = path.join(f.root, '.engines/downloads');
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'foreign.zip'), 'not a locked package');
  await fs.mkdir(path.join(f.root, 'packaging/windows-x64'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'packaging/windows-x64/engine-lock.json'), '{"components":{}}');
  await assert.rejects(migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot', 'engineDownloads'] }), /Unrecognized/);
  await fs.access(f.old);
  await migrateWindowsLayout({ repositoryRoot: f.root, keys: ['distributionRoot'] });
  assert.equal(await fs.readFile(path.join(cache, 'foreign.zip'), 'utf8'), 'not a locked package');
});

test('migration CLI runs through the original TEMP spelling and records the verified result', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'scripts/shared'), { recursive: true });
  for (const name of ['engine-paths.mjs', 'artifact-paths.mjs', 'cache-paths.mjs']) await fs.cp(new URL(`../shared/${name}`, import.meta.url), path.join(f.root, 'scripts/shared', name));
  await fs.mkdir(path.join(f.root, 'scripts/windows'), { recursive: true });
  await fs.cp(new URL('./MigrateLocalLayout.mjs', import.meta.url), path.join(f.root, 'scripts/windows/MigrateLocalLayout.mjs'));
  const alias = path.join(tmpdir(), path.basename(f.root), 'scripts/windows/MigrateLocalLayout.mjs');
  const result = spawnSync(process.execPath, [alias, '--key', 'distributionRoot'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrations[0].target, f.target);
  assert.equal(await fs.readFile(path.join(f.target, 'licenses/notice.txt'), 'utf8'), 'exact notice');
  await assert.rejects(fs.lstat(f.old), { code: 'ENOENT' });
});
