import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveArtifactPaths } from './artifact-paths.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'artifact paths 中文 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'packaging/shared/artifact-paths.json');
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  const config = JSON.parse(readFileSync(new URL('../../packaging/shared/artifact-paths.json', import.meta.url), 'utf8'));
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  save();
  return { root, configPath, config, save };
}

test('resolves separate platform destinations without creating output directories', async t => {
  const f = fixture(t);
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const paths = await resolveArtifactPaths({ repositoryRoot: f.root, platform });
    assert.equal(paths.root, join(f.root, 'artifacts'));
    for (const kind of ['packages', 'verification', 'licenses']) {
      assert.equal(paths[kind], join(f.root, 'artifacts', kind, platform));
      assert.equal(existsSync(paths[kind]), false);
    }
    assert.equal(paths.licenseCurrent, join(paths.licenses, 'current'));
    assert.equal(paths.licenseArchive, join(paths.licenses, 'archive'));
  }
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('uses the shared configuration as the source of destination paths', async t => {
  const f = fixture(t);
  f.config.root = 'generated release';
  f.config.directories.packages = 'installers';
  f.config.directories.verification = 'reports';
  f.save();
  const paths = await resolveArtifactPaths({ repositoryRoot: f.root, platform: 'macos-arm64' });
  assert.equal(paths.packages, join(f.root, 'generated release/installers/macos-arm64'));
  assert.equal(paths.verification, join(f.root, 'generated release/reports/macos-arm64'));
  assert.equal(paths.licenses, join(f.root, 'generated release/licenses/macos-arm64'));
  assert.equal(existsSync(paths.root), false);
});

test('rejects unknown schemas, platforms and incomplete configuration', async t => {
  const f = fixture(t);
  for (const version of [0, 2, true, '1']) {
    f.config.schema_version = version;
    f.save();
    await assert.rejects(resolveArtifactPaths({ repositoryRoot: f.root, platform: 'macos-arm64' }));
  }
  f.config.schema_version = 1;
  f.save();
  for (const platform of [undefined, 'linux-x64', '../macos-arm64']) {
    await assert.rejects(resolveArtifactPaths({ repositoryRoot: f.root, platform }));
  }
  delete f.config.directories.verification;
  f.save();
  await assert.rejects(resolveArtifactPaths({ repositoryRoot: f.root, platform: 'macos-arm64' }));
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('rejects absolute paths and traversal in artifact roots and category directories', async t => {
  const f = fixture(t);
  for (const invalid of ['../outside', '/outside', 'C:\\outside', '..\\outside', '.', 'reports/../outside', 'reports\nother']) {
    f.config.root = invalid;
    f.save();
    await assert.rejects(resolveArtifactPaths({ repositoryRoot: f.root, platform: 'macos-arm64' }));
    f.config.root = 'artifacts';
    f.config.directories.packages = invalid;
    f.save();
    await assert.rejects(resolveArtifactPaths({ repositoryRoot: f.root, platform: 'macos-arm64' }));
    f.config.directories.packages = 'packages';
  }
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('CLI resolves a linked checkout independently of cwd and reports invalid requests without mutation', t => {
  const f = fixture(t);
  const script = join(f.root, 'scripts/shared/artifact-paths.mjs');
  mkdirSync(join(f.root, 'scripts/shared'), { recursive: true });
  writeFileSync(script, readFileSync(new URL('./artifact-paths.mjs', import.meta.url)));
  const linkedRoot = join(f.root, 'linked checkout');
  symlinkSync(f.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  for (const invokedScript of [join(linkedRoot, 'scripts/shared/artifact-paths.mjs'),
    join(tmpdir(), basename(f.root), 'linked checkout/scripts/shared/artifact-paths.mjs')]) {
  const run = args => spawnSync(process.execPath, [invokedScript, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const single = run(['--platform', 'macos-arm64', '--kind', 'packages']);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(single.stdout.trim(), join(f.root, 'artifacts/packages/macos-arm64'));
  const all = run(['--platform', 'windows-x64']);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(all.stdout).verification, join(f.root, 'artifacts/verification/windows-x64'));
  for (const [kind, leaf] of [['license-current', 'current'], ['license-archive', 'archive']]) {
    const result = run(['--platform', 'macos-arm64', '--kind', kind]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(f.root, 'artifacts/licenses/macos-arm64', leaf));
  }
  for (const args of [[], ['--platform'], ['--platform', 'macos-arm64', '--kind'],
    ['--platform', 'macos-arm64', '--kind', 'unknown'], ['--unknown']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
  }
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});
