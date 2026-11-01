import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
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

function checkoutAlias(f) {
  const alias = join(f.root, 'linked checkout');
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return alias;
}

test('known checkout root spellings preserve the caller root and never create outputs', async t => {
  const f = fixture(t);
  const alias = checkoutAlias(f);
  const options = { repositoryRoot: alias };
  assert.equal(await resolveLicenseCollectionOutput(options), join(alias, 'artifacts/licenses/macos-arm64/current'));
  // A POSIX checkout link models the same root identity distinction as Windows
  // short/long TEMP paths. On Windows, cover both realpath implementations too.
  for (const root of new Set([alias, await realpath(alias), realpathSync(alias), realpathSync.native(alias)])) {
    const requestedOutput = join(root, 'artifacts/licenses/macos-arm64/archive/fresh');
    assert.equal(await resolveLicenseCollectionOutput({ ...options, requestedOutput }),
      join(alias, 'artifacts/licenses/macos-arm64/archive/fresh'));
  }
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('root alias normalization keeps existing collections immutable', async t => {
  const f = fixture(t);
  const alias = checkoutAlias(f);
  const current = join(f.licenses, 'current');
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, 'manifest.json'), 'original receipt bytes');
  const physicalRoot = await realpath(alias);
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: alias,
    requestedOutput: join(physicalRoot, 'artifacts/licenses/macos-arm64/current') }), /already exists/);
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: alias,
    requestedOutput: join(physicalRoot, 'artifacts/licenses/macos-arm64/current/nested') }), /existing license collection/);
  assert.equal(readFileSync(join(current, 'manifest.json'), 'utf8'), 'original receipt bytes');
  assert.equal(existsSync(join(current, 'nested')), false);
});

test('known root aliases do not hide linked output parents, including links back inside the repo', async t => {
  for (const linkedCategory of [true, false]) {
    const f = fixture(t);
    const alias = checkoutAlias(f);
    const foreign = join(f.root, 'unrelated data');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'keep.txt'), 'preserve');
    let suffix;
    if (linkedCategory) {
      symlinkSync(foreign, join(f.root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
      suffix = 'artifacts/licenses/macos-arm64/new';
    } else {
      mkdirSync(join(f.licenses, 'archive'), { recursive: true });
      symlinkSync(foreign, join(f.licenses, 'archive/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      suffix = 'artifacts/licenses/macos-arm64/archive/linked/new';
    }
    await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: alias,
      requestedOutput: join(await realpath(alias), suffix) }), /physical directories/);
    assert.equal(existsSync(join(foreign, 'new')), false);
    assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'preserve');
  }
});

test('a foreign root cannot be rebased by matching only its license-directory suffix', async t => {
  const f = fixture(t);
  const alias = checkoutAlias(f);
  const foreign = join(f.root, 'another checkout/artifacts/licenses/macos-arm64/fresh');
  await assert.rejects(resolveLicenseCollectionOutput({ repositoryRoot: alias, requestedOutput: foreign }), /fresh child/);
  assert.equal(existsSync(join(f.root, 'another checkout')), false);
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});
