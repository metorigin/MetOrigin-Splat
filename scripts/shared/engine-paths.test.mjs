import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveEngineLayout, resolveEnginePaths } from './engine-paths.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine paths 中文 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  for (const name of ['artifact-paths.json', 'cache-paths.json', 'engine-paths.json']) {
    cpSync(new URL('../../packaging/shared/' + name, import.meta.url), join(root, 'packaging/shared', name));
  }
  const configPath = join(root, 'packaging/shared/engine-paths.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  return { root, config, save };
}

test('runtime engines, build evidence and fresh native caches remain separate without filesystem creation', async t => {
  const f = fixture(t);
  const paths = await resolveEnginePaths({ repositoryRoot: f.root });
  assert.equal(paths.developmentRoot, join(f.root, '.engines/macos-arm64/development'));
  assert.equal(paths.distributionEngines, join(f.root, '.engines/macos-arm64/distribution/engines'));
  assert.equal(paths.releaseStatus, join(f.root, '.engines/macos-arm64/distribution/release-status.json'));
  assert.notEqual(paths.ffmpegBuild, paths.ffmpegBuildEvidence);
  assert.notEqual(paths.colmapBuild, paths.colmapDevelopmentBuildEvidence);
  assert.notEqual(paths.colmapAlphaBuild, paths.colmapAlphaBuildEvidence);
  assert.notEqual(paths.colmapDependencyPrefix, paths.colmapAlphaDependencyEvidence);
  assert.equal(paths.colmapAlphaDependencyEvidence, join(f.root, '.engines/macos-arm64/archive/colmap/dependencies-original'));
  assert.equal(paths.colmapOriginalDevelopmentEvidence, join(f.root, '.engines/macos-arm64/archive/colmap/development-original'));
  assert.notEqual(paths['brushSource.5'], paths['brushSource.6']);
  for (const name of ['.engines', '.cache', 'artifacts', 'target']) assert.equal(existsSync(join(f.root, name)), false);
});

test('all three storage roots drive their engine destinations', async t => {
  const f = fixture(t);
  f.config.engines_root = 'native engines';
  f.save();
  for (const [file, root] of [['cache-paths.json', 'local cache'], ['artifact-paths.json', 'release data']]) {
    const filePath = join(f.root, 'packaging/shared', file);
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    config.root = root;
    writeFileSync(filePath, JSON.stringify(config));
  }
  const paths = await resolveEnginePaths({ repositoryRoot: f.root });
  assert.equal(paths.developmentRoot, join(f.root, 'native engines/macos-arm64/development'));
  assert(paths.ffmpegSource.startsWith(join(f.root, 'local cache')));
  const evidence = paths['legacy.m0.brush-evidence'];
  assert(evidence.startsWith(join(f.root, 'release data/verification/macos-arm64')));
});

test('migration metadata exposes only validated compatibility targets and preserves profile distinctions', async t => {
  const f = fixture(t);
  const layout = await resolveEngineLayout({ repositoryRoot: f.root });
  const aliases = layout.legacyMappings.filter(item => item.compatibilityLink);
  assert.deepEqual(aliases.map(item => item.key), []);
  const originalPrefix = layout.legacyMappings.find(item => item.legacy === join(f.root, 'target/macos-m0/colmap-deps'));
  assert.equal(originalPrefix.key, 'colmapAlphaDependencyEvidence');
  assert.equal(originalPrefix.target, layout.paths.colmapAlphaDependencyEvidence);
  assert.equal(originalPrefix.compatibilityLink, false);
  const originalDevelopment = layout.legacyMappings.find(item => item.legacy === join(f.root, 'target/macos-m0/colmap-install'));
  assert.equal(originalDevelopment.target, layout.paths.colmapOriginalDevelopmentEvidence);
  assert.equal(layout.flatCompatibility.length, 3);
  for (const item of aliases) {
    assert(item.legacy.startsWith(join(f.root, 'target')));
    assert(item.target.startsWith(join(f.root, '.engines')));
  }
  assert.equal(existsSync(join(f.root, 'target')), false);
});

test('invalid roots, unsupported bases and unsafe compatibility entries fail before mutation', async t => {
  const f = fixture(t);
  const original = JSON.stringify(f.config);
  for (const mutate of [
    config => { config.schema_version = true; },
    config => { config.engines_root = '../outside'; },
    config => { config.platforms['macos-arm64'].paths.developmentRoot.base = 'cache'; },
    config => { config.platforms['macos-arm64'].paths.ffmpegSource.base = 'unknown'; },
    config => { config.platforms['macos-arm64'].paths.ffmpegSource.path = '/outside'; },
    config => { config.platforms['macos-arm64'].legacy_mappings['outside/link'] = { key: 'distributionRoot', compatibility_link: true }; },
  ]) {
    Object.assign(f.config, JSON.parse(original));
    mutate(f.config);
    f.save();
    await assert.rejects(resolveEnginePaths({ repositoryRoot: f.root }));
  }
  Object.assign(f.config, JSON.parse(original));
  f.save();
  await assert.rejects(resolveEnginePaths({ repositoryRoot: f.root, platform: 'unknown' }));
  assert.equal(existsSync(join(f.root, '.engines')), false);
});

test('CLI accepts an explicit checkout from an unrelated cwd and rejects unknown keys', async t => {
  const f = fixture(t);
  const script = new URL('./engine-paths.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), '--repo-root', f.root, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const result = run(['--key', 'developmentRoot']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), (await resolveEnginePaths({ repositoryRoot: f.root })).developmentRoot);
  const invalid = run(['--key', 'missing']);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.equal(existsSync(join(f.root, '.engines')), false);
});
