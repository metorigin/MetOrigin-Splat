import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveWindowsPaths } from './WindowsPaths.mjs';
import { fullBundleConfiguration } from './ResourceConfig.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'windows paths 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packaging/shared'), { recursive: true });
  for (const name of ['engine-paths.json', 'cache-paths.json', 'artifact-paths.json']) {
    await cp(new URL(`../../packaging/shared/${name}`, import.meta.url), path.join(root, 'packaging/shared', name));
  }
  return root;
}

test('Windows runtime, source/build caches and artifacts follow all shared roots without creating output', async t => {
  const root = await fixture(t);
  for (const [name, key, value] of [['engine-paths', 'engines_root', 'runtime'], ['cache-paths', 'root', 'cache'], ['artifact-paths', 'root', 'deliveries']]) {
    const file = path.join(root, `packaging/shared/${name}.json`);
    const config = JSON.parse(await readFile(file, 'utf8'));
    config[key] = value;
    await writeFile(file, JSON.stringify(config));
  }
  const paths = await resolveWindowsPaths({ repositoryRoot: root });
  assert.equal(paths.distributionEngines, path.join(root, 'runtime/windows-x64/distribution/engines'));
  assert.equal(paths.alignmentEngines, path.join(root, 'runtime/windows-x64/alignment/engines'));
  assert(paths.engineDownloads.startsWith(path.join(root, 'cache/downloads/')));
  assert(paths.brushRuntimeSources.startsWith(path.join(root, 'cache/sources/')));
  assert(paths.brushRuntimeBuild.startsWith(path.join(root, 'cache/build/')));
  assert.equal(paths.packages, path.join(root, 'deliveries/packages/windows-x64'));
  assert.equal(paths.verification, path.join(root, 'deliveries/verification/windows-x64'));
  for (const name of ['runtime', 'cache', 'deliveries', 'target']) await assert.rejects(access(path.join(root, name)), { code: 'ENOENT' });
});

test('full bundling honors an explicit pack while preserving prerequisite and application identity', async t => {
  const root = await fixture(t);
  const folder = path.join(root, 'apps/desktop/src-tauri');
  await mkdir(folder, { recursive: true });
  await cp(new URL('../../apps/desktop/src-tauri/tauri.full.conf.json', import.meta.url), path.join(folder, 'tauri.full.conf.json'));
  const selected = path.join(root, 'explicit pack 中文');
  const result = await fullBundleConfiguration({ repositoryRoot: root, output: selected });
  for (const name of ['engines', 'licenses', 'installer']) {
    const matches = Object.entries(result.bundle.resources).filter(([, target]) => target === `resources/${name}/`);
    assert.deepEqual(matches, [[`${path.join(selected, name).split(path.sep).join('/')}/`, `resources/${name}/`]]);
  }
  assert.equal(result.identifier, 'com.metorigin.splat');
  assert.equal(result.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
  assert.equal(result.bundle.windows.nsis.installerHooks, 'nsis/full-installer-hooks.nsh');
  await assert.rejects(access(selected), { code: 'ENOENT' });
});

test('Windows path and resource CLIs run through the original TEMP spelling', async t => {
  const root = await fixture(t), canonical = await realpath(root);
  for (const name of ['engine-paths.mjs', 'artifact-paths.mjs', 'cache-paths.mjs']) {
    await mkdir(path.join(root, 'scripts/shared'), { recursive: true });
    await cp(new URL(`../shared/${name}`, import.meta.url), path.join(root, 'scripts/shared', name));
  }
  await mkdir(path.join(root, 'scripts/windows'), { recursive: true });
  for (const name of ['WindowsPaths.mjs', 'ResourceConfig.mjs']) await cp(new URL(name, import.meta.url), path.join(root, 'scripts/windows', name));
  await mkdir(path.join(root, 'apps/desktop/src-tauri'), { recursive: true });
  await cp(new URL('../../apps/desktop/src-tauri/tauri.full.conf.json', import.meta.url), path.join(root, 'apps/desktop/src-tauri/tauri.full.conf.json'));
  const alias = path.join(tmpdir(), path.basename(root));
  const invoke = (name, args = []) => spawnSync(process.execPath, [path.join(alias, 'scripts/windows', name), ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const paths = invoke('WindowsPaths.mjs');
  assert.equal(paths.status, 0, paths.stderr);
  const expected = await resolveWindowsPaths({ repositoryRoot: canonical });
  assert.deepEqual(JSON.parse(paths.stdout), expected);
  const configPath = path.join(expected.verification, 'fixture/tauri.conf.json');
  const result = invoke('ResourceConfig.mjs', ['--config', configPath]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.bundle.resources[`${expected.distributionEngines.split(path.sep).join('/')}/`], 'resources/engines/');
});
