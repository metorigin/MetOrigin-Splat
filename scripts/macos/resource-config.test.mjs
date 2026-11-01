import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveMacosResourceConfig } from './resource-config.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'macOS 资源配置 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tauri = join(root, 'apps/desktop/src-tauri');
  const configPath = join(tauri, 'tauri.macos.full.conf.json');
  mkdirSync(tauri, { recursive: true });
  const template = JSON.parse(readFileSync(new URL('../../apps/desktop/src-tauri/tauri.macos.full.conf.json', import.meta.url), 'utf8'));
  const save = () => writeFileSync(configPath, JSON.stringify(template));
  save();
  const artifactPath = join(root, 'packaging/shared/artifact-paths.json');
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  const artifacts = JSON.parse(readFileSync(new URL('../../packaging/shared/artifact-paths.json', import.meta.url), 'utf8'));
  const saveArtifacts = () => writeFileSync(artifactPath, JSON.stringify(artifacts));
  saveArtifacts();
  for (const name of ['cache-paths.json', 'engine-paths.json']) {
    cpSync(new URL('../../packaging/shared/' + name, import.meta.url), join(root, 'packaging/shared', name));
  }
  return { root, tauri, template, configPath, save, artifacts, saveArtifacts };
}

function resourcesByTarget(config) {
  return new Map(Object.entries(config.bundle.resources).map(([source, target]) => [target.replace(/\/$/, ''), source]));
}

test('resource config keeps package roles and resolves source paths independently of config output location', async t => {
  const f = fixture(t);
  f.template.bundle.macOS.minimumSystemVersion = '15.0';
  f.template.bundle.shortDescription = 'preserve other bundle options';
  f.template.bundle.resources['../../../extra/NOTICE.txt'] = 'resources/extra/NOTICE.txt';
  f.save();
  const config = await resolveMacosResourceConfig({ repositoryRoot: f.root });
  const resources = resourcesByTarget(config);
  assert.equal(resources.size, Object.keys(f.template.bundle.resources).length);
  assert.equal(resolve(resources.get('resources/app-licenses')), join(f.root, 'artifacts/licenses/macos-arm64/current'));
  assert.equal(resolve(resources.get('resources/engines')), join(f.root, '.engines/macos-arm64/distribution/engines'));
  assert.equal(resources.get('resources/release-status.json'), join(f.root, '.engines/macos-arm64/distribution/release-status.json'));
  assert.equal(resources.get('resources/extra/NOTICE.txt'), join(f.root, 'extra/NOTICE.txt'));
  for (const source of resources.values()) assert(isAbsolute(source));
  for (const target of ['resources/app-licenses', 'resources/engines']) {
    assert(/[\\/]$/.test(resources.get(target)), `Directory source lost trailing separator: ${target}`);
  }
  assert.deepEqual(config.bundle.targets, f.template.bundle.targets);
  assert.deepEqual(config.bundle.macOS, f.template.bundle.macOS);
  assert.equal(config.bundle.shortDescription, f.template.bundle.shortDescription);
  assert.equal(config.$schema, f.template.$schema);
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('configured license root replaces a stale template source without retaining duplicate destinations', async t => {
  const f = fixture(t);
  const oldKey = Object.keys(f.template.bundle.resources).find(source => f.template.bundle.resources[source].replace(/\/$/, '') === 'resources/app-licenses');
  delete f.template.bundle.resources[oldKey];
  f.template.bundle.resources['../../../target/legacy-evidence/'] = 'resources/app-licenses/';
  f.save();
  f.artifacts.root = 'release data';
  f.artifacts.directories.licenses = 'original notices';
  f.saveArtifacts();
  const result = await resolveMacosResourceConfig({ repositoryRoot: f.root });
  const resources = resourcesByTarget(result);
  assert.equal(resolve(resources.get('resources/app-licenses')), join(f.root, 'release data/original notices/macos-arm64/current'));
  assert.equal(Object.values(result.bundle.resources).filter(target => target.replace(/\/$/, '') === 'resources/app-licenses').length, 1);
  assert(!Object.keys(result.bundle.resources).some(source => source.includes('legacy-evidence')));
});

test('missing or duplicate license roles are rejected before producing an incomplete bundle config', async t => {
  const f = fixture(t);
  const key = Object.keys(f.template.bundle.resources).find(source => f.template.bundle.resources[source].replace(/\/$/, '') === 'resources/app-licenses');
  delete f.template.bundle.resources[key];
  f.save();
  await assert.rejects(resolveMacosResourceConfig({ repositoryRoot: f.root }));
  f.template.bundle.resources[key] = 'resources/app-licenses/';
  f.template.bundle.resources['../../../target/duplicate-licenses/'] = 'resources/app-licenses/';
  f.save();
  await assert.rejects(resolveMacosResourceConfig({ repositoryRoot: f.root }));
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('engine layout controls bundled engines and status and rejects missing managed roles', async t => {
  const f = fixture(t);
  const enginePath = join(f.root, 'packaging/shared/engine-paths.json');
  const engine = JSON.parse(readFileSync(enginePath, 'utf8'));
  engine.engines_root = 'native engines';
  writeFileSync(enginePath, JSON.stringify(engine));
  const resources = resourcesByTarget(await resolveMacosResourceConfig({ repositoryRoot: f.root }));
  assert.equal(resolve(resources.get('resources/engines')), join(f.root, 'native engines/macos-arm64/distribution/engines'));
  assert.equal(resources.get('resources/release-status.json'), join(f.root, 'native engines/macos-arm64/distribution/release-status.json'));
  const key = Object.keys(f.template.bundle.resources).find(source => f.template.bundle.resources[source] === 'resources/release-status.json');
  delete f.template.bundle.resources[key];
  f.save();
  await assert.rejects(resolveMacosResourceConfig({ repositoryRoot: f.root }));
});

test('explicit signed pack overrides both engine roles without changing shared paths or license selection', async t => {
  const f = fixture(t);
  const sharedBefore = readFileSync(join(f.root, 'packaging/shared/engine-paths.json'));
  const signed = join(f.root, 'signed engines', 'candidate');
  const resources = resourcesByTarget(await resolveMacosResourceConfig({ repositoryRoot: f.root, enginePackRoot: signed }));
  assert.equal(resolve(resources.get('resources/engines')), join(signed, 'engines'));
  assert.equal(resources.get('resources/release-status.json'), join(signed, 'release-status.json'));
  assert.equal(resolve(resources.get('resources/app-licenses')), join(f.root, 'artifacts/licenses/macos-arm64/current'));
  assert.deepEqual(readFileSync(join(f.root, 'packaging/shared/engine-paths.json')), sharedBefore);
  assert.equal(existsSync(signed), false);
});

test('CLI uses its checkout configuration from an unrelated working directory', t => {
  const f = fixture(t);
  for (const [source, relative] of [
    [new URL('./resource-config.mjs', import.meta.url), 'scripts/macos/resource-config.mjs'],
    [new URL('../shared/artifact-paths.mjs', import.meta.url), 'scripts/shared/artifact-paths.mjs'],
    [new URL('../shared/cache-paths.mjs', import.meta.url), 'scripts/shared/cache-paths.mjs'],
    [new URL('../shared/engine-paths.mjs', import.meta.url), 'scripts/shared/engine-paths.mjs'],
  ]) {
    const destination = join(f.root, relative);
    mkdirSync(join(destination, '..'), { recursive: true });
    cpSync(source, destination);
  }
  for (const scriptPath of [join(f.root, 'scripts/macos/resource-config.mjs'),
    join(tmpdir(), basename(f.root), 'scripts/macos/resource-config.mjs')]) {
  const run = spawnSync(process.execPath, [scriptPath], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const resources = resourcesByTarget(JSON.parse(run.stdout));
  assert.equal(resolve(resources.get('resources/app-licenses')), join(f.root, 'artifacts/licenses/macos-arm64/current'));
  }
});
