import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateEngineSettings } from './migrate-engine-settings.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'saved engine migration 中文 ')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packaging/shared'), { recursive: true });
  for (const name of ['artifact-paths.json', 'cache-paths.json', 'engine-paths.json']) await writeFile(path.join(root, 'packaging/shared', name), await readFile(new URL(`../../packaging/shared/${name}`, import.meta.url)));
  const current = path.join(root, '.engines/macos-arm64/distribution/engines'); await mkdir(path.join(current, 'ffmpeg/bin'), { recursive: true });
  const binary = path.join(current, 'ffmpeg/bin/ffmpeg'); await writeFile(binary, 'same frozen engine');
  const sha256 = createHash('sha256').update('same frozen engine').digest('hex');
  await writeFile(path.join(current, 'engine-manifest.json'), JSON.stringify({ schema_version: 1, platform: 'macos-arm64', engines: { ffmpeg: { files: [{ path: 'ffmpeg/bin/ffmpeg', sha256 }] } } }));
  const legacy = path.join(root, 'target/distribution/macos-arm64'); await mkdir(path.dirname(legacy), { recursive: true }); await symlink(path.dirname(current), legacy, process.platform === 'win32' ? 'junction' : 'dir');
  const settingsPath = path.join(root, 'settings.json'); const data = { engine_directory: path.join(legacy, 'engines'), engine_executables: { ffmpeg: path.join(legacy, 'engines/ffmpeg/bin/ffmpeg') }, theme: 'light', private_unrelated: { token: 'preserve-test-value' } }; await writeFile(settingsPath, JSON.stringify(data));
  return { root, current, binary, settingsPath, data, options: { repositoryRoot: root, platform: 'macos-arm64', settingsPath } };
}
test('dry-run is read-only; apply migrates only engine fields and is idempotent', async t => {
  const f = await fixture(t); const raw = await readFile(f.settingsPath); const plan = await migrateEngineSettings(f.options); assert.equal(plan.changes.length, 2); assert((await readFile(f.settingsPath)).equals(raw));
  await migrateEngineSettings({ ...f.options, apply: true }); const actual = JSON.parse(await readFile(f.settingsPath)); assert.equal(actual.engine_directory, f.current); assert.equal(actual.engine_executables.ffmpeg, f.binary); assert.deepEqual(actual.private_unrelated, f.data.private_unrelated); assert.equal(actual.theme, 'light'); assert.equal((await migrateEngineSettings({ ...f.options, apply: true })).changed, false);
});
test('corrupt destination cannot replace existing settings', async t => {
  const f = await fixture(t); const raw = await readFile(f.settingsPath); await writeFile(f.binary, 'tampered'); await assert.rejects(migrateEngineSettings({ ...f.options, apply: true }), /integrity/); assert((await readFile(f.settingsPath)).equals(raw));
});
test('foreign checkout paths and missing new packs are preserved', async t => {
  const f = await fixture(t); const data = { ...f.data, engine_directory: '/some-other-repo/target/distribution/macos-arm64/engines', engine_executables: {} }; await writeFile(f.settingsPath, JSON.stringify(data)); assert.equal((await migrateEngineSettings({ ...f.options, apply: true })).changed, false);
  await writeFile(f.settingsPath, JSON.stringify(f.data)); await rm(path.dirname(f.current), { recursive: true }); assert.equal((await migrateEngineSettings({ ...f.options, apply: true })).changed, false);
});
test('settings file links are rejected', async t => {
  const f = await fixture(t); const linked = path.join(f.root, 'linked.json'); await symlink(f.settingsPath, linked); await assert.rejects(migrateEngineSettings({ ...f.options, settingsPath: linked, apply: true }), /physical regular/);
});
test('absent old assets require a matching migration identity receipt', async t => {
  const f = await fixture(t); const legacy = path.join(f.root, 'target/distribution/macos-arm64'); await rm(legacy); const raw = await readFile(f.settingsPath);
  await assert.rejects(migrateEngineSettings({ ...f.options, apply: true }), /identity proof/); assert((await readFile(f.settingsPath)).equals(raw));
  const manifest = await readFile(path.join(f.current, 'engine-manifest.json')); const verification = path.join(f.root, 'artifacts/verification/macos-arm64'); await mkdir(verification, { recursive: true });
  await writeFile(path.join(verification, 'engine-layout-migrations.json'), JSON.stringify({ schema_version: 1, entries: [{ legacy: 'target/distribution/macos-arm64', target: '.engines/macos-arm64/distribution', manifest_sha256: createHash('sha256').update(manifest).digest('hex'), platform: 'macos-arm64', status: 'verified' }] }));
  await migrateEngineSettings({ ...f.options, apply: true }); assert.equal(JSON.parse(await readFile(f.settingsPath)).engine_directory, f.current);
});

test('Windows producer uppercase hashes migrate the verified stock pack and individual executables', async t => {
  const f = await fixture(t);
  const lock = JSON.parse(await readFile(new URL('../../packaging/windows-x64/engine-lock.json', import.meta.url), 'utf8'));
  const current = path.join(f.root, '.engines/windows-x64/distribution/engines');
  const legacy = path.join(f.root, 'target/distribution/windows-x64');
  const mappings = { ffmpeg: { ffmpeg: 'ffmpeg/bin/ffmpeg.exe', ffprobe: 'ffmpeg/bin/ffprobe.exe' },
    colmap: { colmap: 'colmap/bin/colmap.exe' }, brush: { brush: 'brush/brush_app.exe' } };
  const manifest = { schema_version: 1, pack_version: lock.pack_version, platform: 'windows-x64', engines: {} };
  const executables = {};
  for (const [name, mapping] of Object.entries(mappings)) {
    const component = lock.components[name], files = [];
    for (const [logical, relative] of Object.entries(mapping)) {
      // Synthetic file bytes with the stock producer's actual paths and casing;
      // this validates settings migration without executing Windows binaries.
      const file = path.join(current, relative), bytes = Buffer.from(`fixed ${logical} fixture`);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
      files.push({ path: relative, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() });
      executables[logical] = path.join(legacy, 'engines', relative);
    }
    manifest.engines[name] = { version: component.version, executables: mapping, files, license_files: [],
      source_url: component.source_url, source_sha256: component.sha256.toUpperCase() };
  }
  const rawManifest = JSON.stringify(manifest);
  await writeFile(path.join(current, 'engine-manifest.json'), rawManifest);
  const verification = path.join(f.root, 'artifacts/verification/windows-x64'); await mkdir(verification, { recursive: true });
  await writeFile(path.join(verification, 'engine-layout-migrations.json'), JSON.stringify({ schema_version: 1, entries: [{
    legacy: 'target/distribution/windows-x64', target: '.engines/windows-x64/distribution', platform: 'windows-x64', status: 'verified',
    manifest_sha256: createHash('sha256').update(rawManifest).digest('hex') }] }));
  const data = { ...f.data, engine_directory: path.join(legacy, 'engines'), engine_executables: executables };
  await writeFile(f.settingsPath, JSON.stringify(data));
  const result = await migrateEngineSettings({ ...f.options, platform: 'windows-x64', apply: true });
  assert.equal(result.changes.length, 5);
  const migrated = JSON.parse(await readFile(f.settingsPath, 'utf8'));
  assert.equal(migrated.engine_directory, current);
  for (const mapping of Object.values(mappings)) for (const [logical, relative] of Object.entries(mapping)) assert.equal(migrated.engine_executables[logical], path.join(current, relative));
  assert.deepEqual(migrated.private_unrelated, data.private_unrelated);
  assert.equal(await readFile(path.join(current, 'engine-manifest.json'), 'utf8'), rawManifest);
});

test('malformed manifest SHA-256 never replaces existing settings', async t => {
  const f = await fixture(t), raw = await readFile(f.settingsPath);
  const manifestFile = path.join(f.current, 'engine-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.engines.ffmpeg.files[0].sha256 = 'not-a-sha256';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(migrateEngineSettings({ ...f.options, apply: true }), /SHA-256 is invalid/);
  assert((await readFile(f.settingsPath)).equals(raw));
});
