import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { distributableSparkPatchReport, verifySparkPatch } from './verify-patch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['dist/spark.module.js', 'dist/spark.cjs.js', 'dist/types/SparkRenderer.d.ts',
  'dist/types/SplatAccumulator.d.ts', 'dist/types/Readback.d.ts', 'dist/types/PackedSplats.d.ts'];
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spark-patch-verifier-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'apps/desktop/node_modules/@sparkjsdev/spark');
  const pkg = {
    name: '@sparkjsdev/spark', version: '2.1.0', type: 'module',
    main: './dist/spark.cjs.js', module: './dist/spark.module.js', types: './dist/types/index.d.ts',
    exports: { '.': { types: './dist/types/index.d.ts', import: './dist/spark.module.js', require: './dist/spark.cjs.js' } },
  };
  const packageBytes = JSON.stringify(pkg);
  await put(join(packageRoot, 'package.json'), packageBytes);
  await put(join(root, 'apps/desktop/package.json'), JSON.stringify({ dependencies: { '@sparkjsdev/spark': '2.1.0' } }));
  await put(join(root, 'pnpm-workspace.yaml'), "packages:\n  - apps/*\npatchedDependencies:\n  '@sparkjsdev/spark@2.1.0': patches/spark.patch\n");
  await put(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npatchedDependencies:\n  '@sparkjsdev/spark@2.1.0': pnpm-internal-hash\nimporters:\n  apps/desktop:\n    dependencies:\n      '@sparkjsdev/spark':\n        specifier: 2.1.0\n        version: 2.1.0(patch_hash=pnpm-internal-hash)(three@0.185.1)\npackages:\n  '@sparkjsdev/spark@2.1.0':\n    resolution: {integrity: sha512-fixture-only}\nsnapshots:\n  '@sparkjsdev/spark@2.1.0(patch_hash=pnpm-internal-hash)(three@0.185.1)':\n    dependencies: {three: 0.185.1}\n");
  const manifest = {
    schema_version: 1, id: 'spark-2.1.0-disposal-lifecycle-v1',
    package: { name: pkg.name, version: pkg.version, package_json_sha256: hash(packageBytes) },
    patch: { path: 'patches/spark.patch', sha256: '' }, files: [],
  };
  let patch = '';
  let lockHash = 'pnpm-internal-hash';
  for (const path of paths) {
    const before = `// before ${path}\n`;
    const after = `// after ${path}\n`;
    await put(join(packageRoot, path), after);
    manifest.files.push({ path, base_sha256: hash(before), sha256: hash(after), size_bytes: Buffer.byteLength(after) });
    patch += `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before.trimEnd()}\n+${after.trimEnd()}\n`;
  }
  await put(join(packageRoot, 'dist/types/index.d.ts'), "export { SparkRenderer } from './SparkRenderer';\n");
  const saveManifest = () => put(join(root, 'integrations/spark/patch-manifest.json'), JSON.stringify(manifest));
  const savePatch = async value => {
    patch = value;
    manifest.patch.sha256 = hash(value);
    await put(join(root, manifest.patch.path), value);
    const lock = join(root, 'pnpm-lock.yaml');
    await put(lock, (await readFile(lock, 'utf8')).replaceAll(lockHash, manifest.patch.sha256));
    lockHash = manifest.patch.sha256;
    await saveManifest();
  };
  await savePatch(patch);
  return { root, packageRoot, pkg, manifest, saveManifest, savePatch, get patch() { return patch; } };
}

async function licenses(f, report) {
  const directory = join(f.root, 'licenses');
  for (const [source, dest] of [
    ['integrations/spark/patch-manifest.json', 'spark/patch-manifest.json'],
    ['patches/spark.patch', 'spark/patch.patch'],
    ['pnpm-workspace.yaml', 'build-inputs/pnpm-workspace.yaml'],
    ['pnpm-lock.yaml', 'build-inputs/pnpm-lock.yaml'],
  ]) await put(join(directory, dest), await readFile(join(f.root, source)));
  await put(join(directory, 'spark/installed-patch.json'), JSON.stringify(distributableSparkPatchReport(report)));
  return directory;
}

test('verifies registered derived files, pnpm resolution and matching license evidence', async t => {
  const f = await fixture(t);
  const result = await verifySparkPatch(f.root);
  assert.equal(result.input_identity.patch.sha256, f.manifest.patch.sha256);
  assert.equal(result.input_identity.files.length, 6);
  assert.equal(result.installed_package_path, f.packageRoot);
  assert.ok(result.input_identity.files.every(row => row.base_sha256 !== row.sha256));
  const licenseRoot = await licenses(f, result);
  assert.deepEqual((await verifySparkPatch(f.root, { licenseRoot })).input_identity, result.input_identity);
});

test('accepts the real pnpm symlink installation layout', async t => {
  const f = await fixture(t);
  const { rename } = await import('node:fs/promises');
  const installed = join(f.root, 'node_modules/.pnpm/spark-patched/node_modules/@sparkjsdev/spark');
  await mkdir(dirname(installed), { recursive: true });
  await rename(f.packageRoot, installed);
  await symlink(installed, f.packageRoot, 'dir');
  assert.equal((await verifySparkPatch(f.root)).installed_package_path, installed);
});

test('distributes the exact identity and scope without machine-local paths or diagnostics', async t => {
  const f = await fixture(t);
  const report = await verifySparkPatch(f.root);
  const localReport = { ...report, local_diagnostic: join(f.root, 'local-debug.log') };
  const distributable = distributableSparkPatchReport(localReport);
  assert.deepEqual(distributable, {
    schema_version: report.schema_version, input_identity: report.input_identity, scope: report.scope,
  });
  assert.equal(localReport.installed_package_path, f.packageRoot);
  const strings = value => typeof value === 'string' ? [value] :
    value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  assert.ok(strings(distributable).every(value => !isAbsolute(value)), 'Distributable report includes an absolute path');
  assert.ok(!JSON.stringify(distributable).includes(f.root), 'Distributable report includes the local workspace');
  const licenseRoot = await licenses(f, localReport);
  assert.deepEqual((await verifySparkPatch(f.root, { licenseRoot })).input_identity, report.input_identity);
});

test('rejects local diagnostics in distributable Spark license evidence', async t => {
  const f = await fixture(t);
  const report = await verifySparkPatch(f.root);
  const licenseRoot = await licenses(f, report);
  await put(join(licenseRoot, 'spark/installed-patch.json'), JSON.stringify(report));
  await assert.rejects(verifySparkPatch(f.root, { licenseRoot }), /only distributable report fields/);
});

test('rejects installed bytes changed without updating provenance', async t => {
  const f = await fixture(t);
  const path = join(f.packageRoot, paths[0]);
  const bytes = await readFile(path);
  bytes[0] = 32; // Same length: the SHA comparison must detect it.
  await writeFile(path, bytes);
  await assert.rejects(verifySparkPatch(f.root), /Installed Spark bytes differ/);
});

test('rejects changed patch bytes', async t => {
  const f = await fixture(t);
  await put(join(f.root, f.manifest.patch.path), f.patch + '\n');
  await assert.rejects(verifySparkPatch(f.root), /Spark patch bytes changed/);
});

test('rejects extra files in a rehashed patch', async t => {
  const f = await fixture(t);
  await f.savePatch(f.patch + 'diff --git a/dist/spark.module.min.js b/dist/spark.module.min.js\n--- a/dist/spark.module.min.js\n+++ b/dist/spark.module.min.js\n@@ -1 +1 @@\n-old\n+new\n');
  await assert.rejects(verifySparkPatch(f.root), /exactly the declared/);
});

test('rejects workspace path and scalar lockfile hash mismatches', async t => {
  const f = await fixture(t);
  const workspace = join(f.root, 'pnpm-workspace.yaml');
  const original = await readFile(workspace, 'utf8');
  await put(workspace, original.replace('patches/spark.patch', 'patches/different.patch'));
  await assert.rejects(verifySparkPatch(f.root), /selects a different Spark patch/);
  await put(workspace, original);
  const lock = join(f.root, 'pnpm-lock.yaml');
  await put(lock, (await readFile(lock, 'utf8')).replace(f.manifest.patch.sha256, `'${'0'.repeat(64)}'`));
  await assert.rejects(verifySparkPatch(f.root), /Lockfile patch hash differs/);
});

test('supports prior lockfile-9 hash/path mappings and rejects mismatched paths', async t => {
  const f = await fixture(t);
  const lock = join(f.root, 'pnpm-lock.yaml');
  const mapped = (await readFile(lock, 'utf8')).replace(`  '@sparkjsdev/spark@2.1.0': ${f.manifest.patch.sha256}`,
    `  '@sparkjsdev/spark@2.1.0':\n    hash: ${f.manifest.patch.sha256}\n    path: patches/spark.patch`);
  await put(lock, mapped);
  assert.equal((await verifySparkPatch(f.root)).input_identity.pnpm_patch_hash, f.manifest.patch.sha256);
  await put(lock, mapped.replace('path: patches/spark.patch', 'path: patches/different.patch'));
  await assert.rejects(verifySparkPatch(f.root), /Lockfile selects a different Spark patch/);
});

test('rejects duplicate YAML keys and overlapping Spark registration', async t => {
  const f = await fixture(t);
  const workspace = join(f.root, 'pnpm-workspace.yaml');
  const original = await readFile(workspace, 'utf8');
  await put(workspace, original + "  '@sparkjsdev/spark@2.1.0': patches/other.patch\n");
  await assert.rejects(verifySparkPatch(f.root), /duplicated mapping key/);
  await put(workspace, original + "  '@sparkjsdev/spark': patches/other.patch\n");
  await assert.rejects(verifySparkPatch(f.root), /Ambiguous Spark patch registration/);
});

test('keeps the Spark patch distinct from a patched Three peer in pnpm resolution', async t => {
  const f = await fixture(t);
  const lock = join(f.root, 'pnpm-lock.yaml');
  const peerHash = 'a'.repeat(64);
  await put(lock, (await readFile(lock, 'utf8')).replaceAll('(three@0.185.1)', `(three@0.185.1(patch_hash=${peerHash}))`));
  const report = await verifySparkPatch(f.root);
  assert.equal(report.input_identity.pnpm_patch_hash, f.manifest.patch.sha256);
  assert.ok(report.input_identity.pnpm_snapshot_key.endsWith(`(three@0.185.1(patch_hash=${peerHash}))`));
});

test('rejects duplicate direct Spark patch groups and malformed peer groups', async t => {
  for (const suffix of ['(patch_hash=duplicate)', '(three@0.185.1', '(three@0.185.1))', 'unexpected']) {
    const f = await fixture(t);
    const lock = join(f.root, 'pnpm-lock.yaml');
    await put(lock, (await readFile(lock, 'utf8')).replaceAll('(three@0.185.1)', suffix));
    await assert.rejects(verifySparkPatch(f.root), /Desktop lock importer/);
  }
});

test('rejects missing desktop importer, unpatched selection, wrong hash and missing snapshot', async t => {
  for (const change of [
    text => text.replace('importers:', 'unusedImporters:'),
    text => text.replace(/version: 2.1.0\(patch_hash=[^)]+\)/, 'version: 2.1.0'),
    text => text.replace(/version: 2.1.0\(patch_hash=[^)]+\)/, 'version: 2.1.0(patch_hash=other-hash)'),
    text => text.replace('snapshots:', 'unusedSnapshots:'),
  ]) {
    const f = await fixture(t);
    const lock = join(f.root, 'pnpm-lock.yaml');
    await put(lock, change(await readFile(lock, 'utf8')));
    await assert.rejects(verifySparkPatch(f.root), /Desktop lock importer|Missing patched Spark snapshot/);
  }
});

test('rejects manifest traversal, omitted files and duplicates', async t => {
  for (const change of [
    m => { m.patch.path = '../outside.patch'; },
    m => { m.files.pop(); },
    m => { m.files[2] = m.files[0]; },
  ]) {
    const f = await fixture(t);
    change(f.manifest);
    await f.saveManifest();
    await assert.rejects(verifySparkPatch(f.root), /Unsafe relative path|exactly the patched/);
  }
});

test('rejects redirected package exports even with a newly bound package.json', async t => {
  const f = await fixture(t);
  f.pkg.exports['.'].import = './dist/spark.module.min.js';
  const bytes = JSON.stringify(f.pkg);
  f.manifest.package.package_json_sha256 = hash(bytes);
  await put(join(f.packageRoot, 'package.json'), bytes);
  await f.saveManifest();
  await assert.rejects(verifySparkPatch(f.root), /exports no longer select/);
});

test('rejects stale sourceMappingURL even when patched bytes are recorded', async t => {
  const f = await fixture(t);
  const bytes = '// derived\n//# sourceMappingURL=spark.module.js.map\n';
  await put(join(f.packageRoot, paths[0]), bytes);
  Object.assign(f.manifest.files[0], { sha256: hash(bytes), size_bytes: Buffer.byteLength(bytes) });
  await f.saveManifest();
  await assert.rejects(verifySparkPatch(f.root), /stale source map/);
});

test('keeps map text inside unchanged embedded worker strings separate from module directives', async t => {
  const f = await fixture(t);
  const bytes = 'const worker = "worker code\\n//# sourceMappingURL=worker.js.map\\n";\n';
  await put(join(f.packageRoot, paths[0]), bytes);
  Object.assign(f.manifest.files[0], { sha256: hash(bytes), size_bytes: Buffer.byteLength(bytes) });
  await f.saveManifest();
  assert.equal((await verifySparkPatch(f.root)).input_identity.files.length, 6);
});

test('rejects patched installed file symlinks', async t => {
  const f = await fixture(t);
  const path = join(f.packageRoot, paths[0]);
  const bytes = await readFile(path);
  await rm(path);
  await put(join(f.root, 'outside.js'), bytes);
  await symlink(join(f.root, 'outside.js'), path);
  await assert.rejects(verifySparkPatch(f.root), /Expected physical file/);
});

test('rejects stale copied license input and stale installed identity', async t => {
  const f = await fixture(t);
  const report = await verifySparkPatch(f.root);
  const licenseRoot = await licenses(f, report);
  const path = join(licenseRoot, 'build-inputs/pnpm-workspace.yaml');
  const original = await readFile(path);
  await put(path, Buffer.concat([original, Buffer.from('# changed\n')]));
  await assert.rejects(verifySparkPatch(f.root, { licenseRoot }), /Spark license evidence differs/);
  await put(path, original);
  report.input_identity.files[0].sha256 = '0'.repeat(64);
  await put(join(licenseRoot, 'spark/installed-patch.json'), JSON.stringify(report));
  await assert.rejects(verifySparkPatch(f.root, { licenseRoot }), /different Spark derivation/);
});
