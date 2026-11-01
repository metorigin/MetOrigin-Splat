import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
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
