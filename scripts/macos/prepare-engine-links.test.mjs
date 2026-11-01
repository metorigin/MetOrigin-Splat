import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveEngineLayout } from '../shared/engine-paths.mjs';
import { prepareEngineLinks } from './prepare-engine-links.mjs';

async function fixture(t, extraCompatibilityEntry = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engine links 中文 ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['engine-paths.json', 'artifact-paths.json', 'cache-paths.json']) {
    const destination = join(root, 'packaging/shared', name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(new URL(`../../packaging/shared/${name}`, import.meta.url)));
  }
  if (extraCompatibilityEntry) {
    const file = join(root, 'packaging/shared/engine-paths.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.platforms['macos-arm64'].legacy_mappings['target/distribution/macos-arm64'].compatibility_link = true;
    if (extraCompatibilityEntry === true) config.platforms['macos-arm64'].legacy_mappings['target/test-compatibility/prefix'] = {
      key: 'colmapAlphaDependencyEvidence', compatibility_link: true,
    };
    await writeFile(file, JSON.stringify(config));
  }
  const layout = await resolveEngineLayout({ repositoryRoot: root });
  const entries = layout.legacyMappings.filter(entry => entry.compatibilityLink);
  const run = extra => prepareEngineLinks({ repositoryRoot: root, platform: 'darwin', arch: 'arm64', ...extra });
  return { root, entries, layout, run };
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('Cargo-cleaned aliases are rebuilt only for physical targets and are idempotent', async t => {
  const f = await fixture(t, 'distribution');
  assert.equal(f.entries.length, 1);
  assert.equal(f.entries[0].key, 'distributionRoot');
  for (const entry of f.entries) {
    await mkdir(entry.target, { recursive: true });
    await writeFile(join(entry.target, 'keep.txt'), 'immutable target');
  }
  const first = await f.run();
  assert(first.links.every(entry => entry.status === 'created'));
  for (const entry of f.entries) {
    assert((await lstat(entry.legacy)).isSymbolicLink());
    assert.equal(await realpath(entry.legacy), await realpath(entry.target));
    assert.equal(await readFile(join(entry.legacy, 'keep.txt'), 'utf8'), 'immutable target');
  }
  assert((await f.run()).links.every(entry => entry.status === 'unchanged'));
  await rm(join(f.root, 'target'), { recursive: true });
  assert((await f.run()).links.every(entry => entry.status === 'created'));
});

test('missing targets never create dangling links or an otherwise empty target directory', async t => {
  const f = await fixture(t, 'distribution');
  assert((await f.run()).links.every(entry => entry.status === 'missing-target'));
  assert.equal(await exists(join(f.root, 'target')), false);
});

test('physical development and original prefixes never recreate target/macos-m0', async t => {
  const f = await fixture(t);
  for (const key of ['colmapDependencyPrefix', 'colmapAlphaDependencyEvidence',
    'colmapOriginalDevelopmentEvidence', 'distributionRoot']) {
    await mkdir(f.layout.paths[key], { recursive: true });
  }
  const first = await f.run();
  assert.deepEqual(first.links, []);
  assert.equal(await exists(join(f.root, 'target')), false);
  assert.equal(await exists(join(f.root, 'target/macos-m0')), false);
  assert((await f.run()).links.every(entry => entry.status === 'unchanged'));
  assert.equal(await exists(join(f.root, 'target/macos-m0')), false);
});

test('existing directories and foreign links remain intact and block all link creation', async t => {
  for (const kind of ['directory', 'foreign-link']) await t.test(kind, async t => {
    // Retain multi-entry preflight coverage even though production now has no
    // target compatibility links. A conflict in a later configured entry blocks both.
    const f = await fixture(t, true);
    assert.equal(f.entries.length, 2);
    for (const entry of f.entries) await mkdir(entry.target, { recursive: true });
    const conflict = f.entries.at(-1);
    await mkdir(dirname(conflict.legacy), { recursive: true });
    const foreign = join(f.root, 'user data');
    await mkdir(foreign);
    await writeFile(join(foreign, 'keep.txt'), 'keep unrelated files');
    if (kind === 'directory') {
      await mkdir(conflict.legacy);
      await writeFile(join(conflict.legacy, 'keep.txt'), 'keep original directory');
    } else await symlink(foreign, conflict.legacy, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.run(), /already exists and is not the expected link/);
    assert.equal(await exists(f.entries[0].legacy), false);
    assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'keep unrelated files');
    if (kind === 'directory') assert.equal(await readFile(join(conflict.legacy, 'keep.txt'), 'utf8'), 'keep original directory');
    else assert.equal(await realpath(conflict.legacy), await realpath(foreign));
  });
});

test('linked target and link-parent ancestors are rejected without redirection', async t => {
  for (const redirect of ['target', 'parent']) await t.test(redirect, async t => {
    const f = await fixture(t, 'distribution');
    for (const entry of f.entries) await mkdir(entry.target, { recursive: true });
    const foreign = join(f.root, 'unrelated');
    await mkdir(foreign);
    const link = redirect === 'target' ? f.entries[0].target : join(f.root, 'target');
    await rm(link, { recursive: true, force: true });
    await mkdir(dirname(link), { recursive: true });
    await symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.run(), /physical directories/);
    assert.equal(await exists(join(foreign, 'macos-m0')), false);
    assert.equal(await exists(join(foreign, 'distribution')), false);
  });
});

test('other host platforms do not read configuration or mutate the checkout', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'packaging'), { recursive: true });
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) {
    assert.deepEqual(await f.run({ platform, arch }), { skipped: true, links: [] });
  }
  assert.equal(await exists(join(f.root, 'target')), false);
});

test('CLI has no platform override that can bypass the native host guard', () => {
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('./prepare-engine-links.mjs', import.meta.url)), '--platform', 'darwin'],
    { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});
