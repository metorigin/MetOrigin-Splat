import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveLicenseCollectionOutput } from './license-paths.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'license output 中文 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'packaging/shared/artifact-paths.json');
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  const config = JSON.parse(readFileSync(new URL('../../packaging/shared/artifact-paths.json', import.meta.url), 'utf8'));
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  save();
  return { root, config, save, licenses: join(root, 'artifacts/licenses/macos-arm64') };
}

test('collection defaults to configured current without creating directories', async t => {
  const f = fixture(t);
  assert.equal(await resolveLicenseCollectionOutput({ repositoryRoot: f.root }), join(f.licenses, 'current'));
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
  f.config.root = 'release data';
  f.config.directories.licenses = 'original notices';
  f.save();
  assert.equal(await resolveLicenseCollectionOutput({ repositoryRoot: f.root }), join(f.root, 'release data/original notices/macos-arm64/current'));
});

test('fresh archive children are accepted while the category root and legacy target are rejected', async t => {
  const f = fixture(t);
  const options = { repositoryRoot: f.root };
  assert.equal(await resolveLicenseCollectionOutput({ ...options, requestedOutput: join(f.licenses, 'archive/new collection') }), join(f.licenses, 'archive/new collection'));
  for (const requestedOutput of [f.licenses, 'target/macos-m4/app-license-evidence/licenses', '../outside', join(f.root, 'artifacts/licenses/windows-x64/current')]) {
    await assert.rejects(resolveLicenseCollectionOutput({ ...options, requestedOutput }));
  }
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
  assert.equal(existsSync(join(f.root, 'target')), false);
});

test('existing current and manifest-bound parents remain immutable on failed collection requests', async t => {
  const f = fixture(t);
  const current = join(f.licenses, 'current');
  mkdirSync(current, { recursive: true });
  const manifest = join(current, 'manifest.json');
  writeFileSync(manifest, 'preserve prior evidence');
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: f.root }), /already exists/);
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: f.root, requestedOutput: join(current, 'nested collection') }), /existing license collection/);
  assert.equal(readFileSync(manifest, 'utf8'), 'preserve prior evidence');
  assert.equal(existsSync(join(current, 'nested collection')), false);
});

test('linked output ancestors cannot redirect collection outside the checkout', async t => {
  const f = fixture(t);
  const foreign = join(f.root, 'unrelated data');
  mkdirSync(foreign);
  symlinkSync(foreign, join(f.root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: f.root }), /physical directories/);
  assert.equal(existsSync(join(foreign, 'licenses')), false);
});

test('a regular-file ancestor is rejected before creating a collection', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'artifacts'), 'keep file');
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: f.root }), /physical directories/);
  assert.equal(readFileSync(join(f.root, 'artifacts'), 'utf8'), 'keep file');
});
