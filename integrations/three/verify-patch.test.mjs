import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { distributableThreePatchReport, verifyThreePatch } from './verify-patch.mjs';

const FILE = 'examples/jsm/controls/OrbitControls.js';
const COMPONENT = 'pkg:npm/three@0.185.1';
const hash = value => createHash('sha256').update(value).digest('hex');
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const json = (path, value) => put(path, JSON.stringify(value));
const mutateText = async (path, change) => put(path, change(await readFile(path, 'utf8')));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'three-patch-verifier-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'apps/desktop/node_modules/three');
  const pkg = { name: 'three', version: '0.185.1', type: 'module', license: 'MIT',
    main: './build/three.cjs', module: './build/three.module.js',
    exports: { '.': { import: './build/three.module.js', require: './build/three.cjs' },
      './examples/jsm/*': './examples/jsm/*', './addons': './examples/jsm/Addons.js', './addons/*': './examples/jsm/*' } };
  const before = '// original OrbitControls fixture\n';
  const after = '// derived OrbitControls fixture\n';
  const patch = `diff --git a/${FILE} b/${FILE}\nindex 1111111..2222222 100644\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n`;
  const manifest = { schema_version: 1, id: 'three-0.185.1-orbit-controls-root-v1',
    package: { name: 'three', version: '0.185.1', package_json_sha256: hash(JSON.stringify(pkg)) },
    patch: { path: 'patches/three@0.185.1.patch', sha256: hash(patch) },
    files: [{ path: FILE, base_sha256: hash(before), sha256: hash(after), size_bytes: Buffer.byteLength(after) }] };
  await json(join(packageRoot, 'package.json'), pkg);
  await put(join(packageRoot, FILE), after);
  await put(join(packageRoot, 'LICENSE'), 'MIT fixture license text, copied verbatim from this selected package.\n');
  await json(join(root, 'apps/desktop/package.json'), { dependencies: { three: '0.185.1' } });
  await put(join(root, 'pnpm-workspace.yaml'), "packages:\n  - apps/*\npatchedDependencies:\n  '@sparkjsdev/spark@2.1.0': patches/spark.patch\n  three@0.185.1: patches/three@0.185.1.patch\n");
  await put(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npatchedDependencies:\n  '@sparkjsdev/spark@2.1.0': independent-spark-hash\n  three@0.185.1: ${manifest.patch.sha256}\nimporters:\n  apps/desktop:\n    dependencies:\n      three:\n        specifier: 0.185.1\n        version: 0.185.1(patch_hash=${manifest.patch.sha256})\n      '@sparkjsdev/spark':\n        specifier: 2.1.0\n        version: 2.1.0(patch_hash=independent-spark-hash)(three@0.185.1(patch_hash=${manifest.patch.sha256}))\npackages:\n  three@0.185.1:\n    resolution: {integrity: sha512-fixture-only}\nsnapshots:\n  three@0.185.1(patch_hash=${manifest.patch.sha256}): {}\n`);
  await put(join(root, manifest.patch.path), patch);
  const saveManifest = () => json(join(root, 'integrations/three/patch-manifest.json'), manifest);
  const savePackage = async () => {
    const bytes = JSON.stringify(pkg);
    manifest.package.package_json_sha256 = hash(bytes);
    await put(join(packageRoot, 'package.json'), bytes);
    await saveManifest();
  };
  const savePatch = async bytes => {
    const oldHash = manifest.patch.sha256;
    manifest.patch.sha256 = hash(bytes);
    await put(join(root, manifest.patch.path), bytes);
    await mutateText(join(root, 'pnpm-lock.yaml'), text => text.replaceAll(oldHash, manifest.patch.sha256));
    await saveManifest();
  };
  await saveManifest();
  return { root, packageRoot, pkg, manifest, patch, saveManifest, savePackage, savePatch };
}

async function licenses(f, report) {
  const directory = join(f.root, 'licenses');
  for (const [source, dest] of [
    ['integrations/three/patch-manifest.json', 'three/patch-manifest.json'],
    [f.manifest.patch.path, 'three/patch.patch'], ['pnpm-workspace.yaml', 'build-inputs/pnpm-workspace.yaml'],
    ['pnpm-lock.yaml', 'build-inputs/pnpm-lock.yaml'], ['apps/desktop/package.json', 'build-inputs/desktop-package.json'],
  ]) await put(join(directory, dest), await readFile(join(f.root, source)));
  await json(join(directory, 'three/installed-patch.json'), distributableThreePatchReport(report));
  const evidence = 'installed-production-dependency-closure-before-tree-shaking';
  await json(join(directory, 'component-evidence.json'), [{ component: COMPONENT, declared_license: 'MIT', evidence,
    package_json_sha256: report.input_identity.package.package_json_sha256, local_derivation: report.input_identity.id,
    patch_evidence: 'three/installed-patch.json', modified_distribution_files: report.input_identity.files,
    original_npm_distribution_bytes_claimed: false }]);
  const notice = await readFile(join(f.packageRoot, 'LICENSE'));
  const noticePath = 'dependencies/npm/three-0.185.1/LICENSE';
  await put(join(directory, noticePath), notice);
  await json(join(directory, 'dependency-license-index.json'), [{ component: COMPONENT, path: noticePath, sha256: hash(notice), size_bytes: notice.length }]);
  await json(join(directory, 'SBOM.cdx.json'), { components: [{ name: 'three', version: '0.185.1', 'bom-ref': COMPONENT, purl: COMPONENT,
    licenses: [{ license: { name: 'MIT' } }], properties: [
      { name: 'metorigin:inventory-evidence', value: evidence },
      { name: 'metorigin:local-derivation', value: report.input_identity.id },
      { name: 'metorigin:patch-sha256', value: report.input_identity.patch.sha256 },
      { name: 'metorigin:patch-evidence', value: 'three/installed-patch.json' },
    ] }] });
  return directory;
}

test('binds exact OrbitControls bytes, both selected exports, lock snapshot and installed MIT notice', async t => {
  const f = await fixture(t);
  const report = await verifyThreePatch(f.root);
  assert.equal(report.input_identity.files.length, 1);
  assert.equal(report.input_identity.files[0].path, FILE);
  assert.equal(report.input_identity.selected_exports.length, 2);
  assert.equal(report.input_identity.pnpm_snapshot_key, `three@0.185.1(patch_hash=${f.manifest.patch.sha256})`);
  assert.equal(report.input_identity.desktop_package.path, 'apps/desktop/package.json');
  assert.equal(report.input_identity.license.declared, 'MIT');
  assert.equal(report.installed_package_path, f.packageRoot);
  assert.deepEqual((await verifyThreePatch(f.root, { licenseRoot: await licenses(f, report) })).input_identity, report.input_identity);
});

test('accepts pnpm package-directory symlinks without accepting file symlinks', async t => {
  const f = await fixture(t);
  const installed = join(f.root, 'node_modules/.pnpm/three-patched/node_modules/three');
  await mkdir(dirname(installed), { recursive: true });
  await rename(f.packageRoot, installed);
  await symlink(installed, f.packageRoot, 'dir');
  assert.equal((await verifyThreePatch(f.root)).installed_package_path, installed);
});

test('distributable report contains stable input identity and no local absolute paths', async t => {
  const f = await fixture(t);
  const report = await verifyThreePatch(f.root);
  const output = distributableThreePatchReport({ ...report, local_diagnostic: join(f.root, 'log') });
  assert.deepEqual(Object.keys(output).sort(), ['input_identity','schema_version','scope']);
  const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  assert.ok(strings(output).every(value => !isAbsolute(value)));
  assert.ok(!JSON.stringify(output).includes(f.root));
});

test('rejects same-size installed OrbitControls byte drift', async t => {
  const f = await fixture(t);
  const bytes = await readFile(join(f.packageRoot, FILE)); bytes[0] = 32;
  await put(join(f.packageRoot, FILE), bytes);
  await assert.rejects(verifyThreePatch(f.root), /Installed Three bytes differ/);
});

test('rejects patch drift and additional rehashed patch targets', async t => {
  const f = await fixture(t);
  await put(join(f.root, f.manifest.patch.path), f.patch + '\n');
  await assert.rejects(verifyThreePatch(f.root), /Three patch bytes changed/);
  await f.savePatch(f.patch + 'diff --git a/src/Three.js b/src/Three.js\n--- a/src/Three.js\n+++ b/src/Three.js\n@@ -1 +1 @@\n-old\n+new\n');
  await assert.rejects(verifyThreePatch(f.root), /exactly the declared OrbitControls file/);
});

test('rejects rename and binary patch metadata even when the patch hash is updated', async t => {
  for (const suffix of ['rename from old.js\nrename to new.js\n', 'GIT binary patch\n']) {
    const f = await fixture(t);
    await f.savePatch(f.patch + suffix);
    await assert.rejects(verifyThreePatch(f.root), /outside this derivation/);
  }
});

test('rejects workspace path and scalar lock hash disagreement', async t => {
  const f = await fixture(t);
  const workspace = join(f.root, 'pnpm-workspace.yaml');
  const original = await readFile(workspace, 'utf8');
  await put(workspace, original.replace('patches/three@0.185.1.patch', 'patches/other.patch'));
  await assert.rejects(verifyThreePatch(f.root), /Workspace selects a different Three patch/);
  await put(workspace, original);
  await mutateText(join(f.root, 'pnpm-lock.yaml'), text => text.replace(`  three@0.185.1: ${f.manifest.patch.sha256}`, `  three@0.185.1: '${'0'.repeat(64)}'`));
  await assert.rejects(verifyThreePatch(f.root), /Lockfile patch hash differs/);
});

test('supports legacy lockfile-9 hash/path form without assuming its hash algorithm', async t => {
  const f = await fixture(t);
  const lock = join(f.root, 'pnpm-lock.yaml');
  await mutateText(lock, text => text.replace(`  three@0.185.1: ${f.manifest.patch.sha256}`,
    `  three@0.185.1:\n    hash: ${f.manifest.patch.sha256}\n    path: ${f.manifest.patch.path}`).replaceAll(f.manifest.patch.sha256, 'legacy-writer-hash'));
  assert.equal((await verifyThreePatch(f.root)).input_identity.pnpm_patch_hash, 'legacy-writer-hash');
  await mutateText(lock, text => text.replace(`path: ${f.manifest.patch.path}`, 'path: patches/other.patch'));
  await assert.rejects(verifyThreePatch(f.root), /Lockfile selects a different Three patch/);
});

test('rejects duplicate YAML keys and broad or differently versioned Three registrations', async t => {
  for (const key of ['three@0.185.1', 'three', 'three@0.185.2', 'three@^0.185.1']) {
    const f = await fixture(t);
    await mutateText(join(f.root, 'pnpm-workspace.yaml'), text => text + `  '${key}': patches/other.patch\n`);
    await assert.rejects(verifyThreePatch(f.root), /duplicated mapping key|Ambiguous Three patch registration/);
  }
});

test('rejects missing importer, version/hash drift, missing snapshot and missing base integrity', async t => {
  const changes = [
    text => text.replace('importers:', 'unusedImporters:'),
    text => text.replace('specifier: 0.185.1', 'specifier: ^0.185.1'),
    text => text.replace(/version: 0.185.1\(patch_hash=[^)]+\)/, 'version: 0.185.1'),
    text => text.replace(/version: 0.185.1\(patch_hash=[^)]+\)/, 'version: 0.185.1(patch_hash=other)'),
    text => text.replace('snapshots:', 'unusedSnapshots:'),
    text => text.replace('resolution:', 'unusedResolution:'),
  ];
  for (const change of changes) {
    const f = await fixture(t);
    await mutateText(join(f.root, 'pnpm-lock.yaml'), change);
    await assert.rejects(verifyThreePatch(f.root), /Desktop lock importer|Missing patched Three snapshot|Missing locked Three base/);
  }
});

test('rejects ranged desktop dependency even with an exact patched lock selection', async t => {
  const f = await fixture(t);
  await json(join(f.root, 'apps/desktop/package.json'), { dependencies: { three: '^0.185.1' } });
  await assert.rejects(verifyThreePatch(f.root), /Desktop must select fixed Three/);
});

test('rejects unsafe manifest paths and omitted, duplicate or undeclared files', async t => {
  for (const change of [
    manifest => { manifest.patch.path = '../outside.patch'; },
    manifest => { manifest.files = []; },
    manifest => { manifest.files.push(manifest.files[0]); },
    manifest => { manifest.files[0].path = 'build/three.cjs'; },
    manifest => { manifest.files[0].base_sha256 = manifest.files[0].sha256; },
  ]) {
    const f = await fixture(t); change(f.manifest); await f.saveManifest();
    await assert.rejects(verifyThreePatch(f.root), /Unsafe relative path|exactly the patched OrbitControls|Invalid before\/after/);
  }
});

test('rejects changed package.json bytes, version and MIT declaration', async t => {
  const f = await fixture(t);
  await put(join(f.packageRoot, 'package.json'), JSON.stringify({ ...f.pkg, note: 'drift' }));
  await assert.rejects(verifyThreePatch(f.root), /package.json differs/);
  f.pkg.version = '0.185.2'; await f.savePackage();
  await assert.rejects(verifyThreePatch(f.root));
  f.pkg.version = '0.185.1'; f.pkg.license = 'Unknown'; await f.savePackage();
  await assert.rejects(verifyThreePatch(f.root), /MIT license declaration/);
});

test('rejects either redirected wildcard export after rebinding package.json hash', async t => {
  for (const pattern of ['./examples/jsm/*', './addons/*']) {
    const f = await fixture(t); f.pkg.exports[pattern] = './unverified/*'; await f.savePackage();
    await assert.rejects(verifyThreePatch(f.root), /export pattern no longer selects OrbitControls/);
  }
});

test('rejects a conditional import override even when require would resolve the verified file', async t => {
  const f = await fixture(t);
  f.pkg.exports['./examples/jsm/controls/OrbitControls.js'] = { import: './unverified.js', require: `./${FILE}` };
  await f.savePackage();
  await assert.rejects(verifyThreePatch(f.root), /Overlapping or conditional OrbitControls export/);
});

test('rejects patched file symlinks and directory escapes', async t => {
  for (const mode of ['file', 'directory']) {
    const f = await fixture(t);
    const full = join(f.packageRoot, FILE);
    const bytes = await readFile(full);
    if (mode === 'file') {
      await rm(full); await put(join(f.root, 'outside.js'), bytes); await symlink(join(f.root, 'outside.js'), full);
    } else {
      await rename(dirname(full), join(f.root, 'outside-controls'));
      await symlink(join(f.root, 'outside-controls'), dirname(full), 'dir');
    }
    await assert.rejects(verifyThreePatch(f.root), /Expected physical file|File escapes its root/);
  }
});

test('rejects stale copied package/lock provenance and local paths in distributed evidence', async t => {
  for (const name of ['build-inputs/desktop-package.json', 'build-inputs/pnpm-lock.yaml', 'three/patch.patch']) {
    const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
    await mutateText(join(licenseRoot, name), text => text + '\n');
    await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /Three license evidence differs/);
  }
  const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
  await json(join(licenseRoot, 'three/installed-patch.json'), report);
  await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /only distributable report fields/);
});

test('rejects stale distributed derivation identity', async t => {
  const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
  const copied = distributableThreePatchReport(structuredClone(report)); copied.input_identity.files[0].sha256 = '0'.repeat(64);
  await json(join(licenseRoot, 'three/installed-patch.json'), copied);
  await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /different Three derivation/);
});

test('rejects inventory omission, duplicate versions and unmarked original-byte claims', async t => {
  const changes = [
    rows => [], rows => [...rows, { ...rows[0], component: 'pkg:npm/three@0.185.2' }],
    rows => [{ ...rows[0], original_npm_distribution_bytes_claimed: true }],
    rows => [{ ...rows[0], local_derivation: 'other' }],
    rows => [{ ...rows[0], modified_distribution_files: [] }],
    rows => [{ ...rows[0], package_json_sha256: '0'.repeat(64) }],
    rows => [{ ...rows[0], evidence: 'unverified-input' }],
  ];
  for (const change of changes) {
    const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
    const file = join(licenseRoot, 'component-evidence.json');
    await json(file, change(JSON.parse(await readFile(file, 'utf8'))));
    await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /Three component|original npm|local derivation|modified files|package.json differs|production dependency source/);
  }
});

test('rejects substituted license text or its inventory hash', async t => {
  const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
  const noticePath = join(licenseRoot, 'dependencies/npm/three-0.185.1/LICENSE');
  const original = await readFile(noticePath);
  await put(noticePath, 'Substituted notice\n');
  await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /copied LICENSE differs/);
  await put(noticePath, original);
  const indexPath = join(licenseRoot, 'dependency-license-index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')); index[0].sha256 = '0'.repeat(64);
  await json(indexPath, index);
  await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /LICENSE inventory hash differs/);
});

test('rejects omitted or conflicting SBOM derivation provenance', async t => {
  for (const change of [
    bom => { bom.components[0].properties = []; },
    bom => { bom.components[0].properties.push({ name: 'metorigin:patch-sha256', value: 'other' }); },
    bom => { bom.components[0].version = '0.185.2'; },
  ]) {
    const f = await fixture(t); const report = await verifyThreePatch(f.root); const licenseRoot = await licenses(f, report);
    const file = join(licenseRoot, 'SBOM.cdx.json'); const bom = JSON.parse(await readFile(file, 'utf8')); change(bom); await json(file, bom);
    await assert.rejects(verifyThreePatch(f.root, { licenseRoot }), /Three SBOM property differs|SBOM Three version differs/);
  }
});
