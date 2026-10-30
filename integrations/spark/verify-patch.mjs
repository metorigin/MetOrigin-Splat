#!/usr/bin/env node
// Verify the selected local Spark derivation, without importing or running Spark.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESLint is an existing locked desktop build dependency. Use its YAML parser
// rather than accepting a partial YAML interpretation of pnpm configuration.
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { load: parseYaml, JSON_SCHEMA } = createRequire(desktopRequire.resolve('eslint/package.json'))('js-yaml');
const PACKAGE = '@sparkjsdev/spark';
const VERSION = '2.1.0';
const PATCH_KEY = `${PACKAGE}@${VERSION}`;
const MANIFEST = 'integrations/spark/patch-manifest.json';
const FILES = ['dist/spark.cjs.js', 'dist/spark.module.js', 'dist/types/PackedSplats.d.ts',
  'dist/types/Readback.d.ts', 'dist/types/SparkRenderer.d.ts', 'dist/types/SplatAccumulator.d.ts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function safeRelative(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe relative path: ${path}`);
  return path;
}

async function physicalFile(base, path) {
  safeRelative(path);
  const full = join(base, path);
  const info = await lstat(full);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected physical file: ${path}`);
  const actual = await realpath(full);
  const fromBase = relative(await realpath(base), actual);
  assert.ok(fromBase && !fromBase.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    fromBase !== '..' && !isAbsolute(fromBase), `File escapes its root: ${path}`);
  const bytes = await readFile(full);
  const after = await lstat(full);
  assert.ok(info.size === after.size && info.mtimeMs === after.mtimeMs && info.ino === after.ino,
    `File changed while reading: ${path}`);
  return { bytes, record: { path, size_bytes: bytes.length, sha256: hash(bytes) } };
}

function configuration(bytes, source) {
  const config = parseYaml(bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: source });
  assert.ok(config && typeof config === 'object' && !Array.isArray(config), `Invalid ${source}`);
  return config;
}

function patchedDependencies(config, source) {
  const patches = config.patchedDependencies;
  assert.ok(patches && typeof patches === 'object' && !Array.isArray(patches), `Missing patchedDependencies in ${source}`);
  // A second broad or differently versioned Spark rule can select another patch.
  const sparkKeys = Object.keys(patches).filter(key => key === PACKAGE || key.startsWith(`${PACKAGE}@`));
  assert.deepEqual(sparkKeys, [PATCH_KEY], `Ambiguous Spark patch registration in ${source}`);
  return patches[PATCH_KEY];
}

function directPatchHashes(version) {
  // A patched peer has its own nested `(patch_hash=...)`. Only top-level
  // groups describe this Spark package; retain the whole snapshot identity.
  const suffix = version.slice(VERSION.length);
  const groups = [];
  let depth = 0, start = 0;
  for (let index = 0; index < suffix.length; index++) {
    const char = suffix[index];
    if (char === '(') {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (char === ')') {
      assert.ok(depth > 0, 'Desktop lock importer has malformed peer groups');
      if (--depth === 0) {
        assert.ok(index > start, 'Desktop lock importer has an empty peer group');
        groups.push(suffix.slice(start, index));
      }
    } else {
      assert.ok(depth > 0, 'Desktop lock importer has text outside peer groups');
    }
  }
  assert.equal(depth, 0, 'Desktop lock importer has an unclosed peer group');
  return groups.filter(group => group.startsWith('patch_hash=')).map(group => {
    assert.ok(/^patch_hash=[^()]+$/.test(group), 'Desktop lock importer has an invalid patch group');
    return group.slice('patch_hash='.length);
  });
}

function checkPatchPaths(bytes) {
  const text = bytes.toString('utf8');
  const headers = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)\r?$/gm)];
  assert.equal((text.match(/^diff --git /gm) ?? []).length, headers.length, 'Unsupported patch diff header');
  assert.deepEqual(headers.map(match => match[1]).sort(), FILES, 'Patch must modify exactly the declared Spark files');
  for (const match of headers) {
    assert.equal(match[1], match[2], 'Patch cannot rename Spark files');
  }
  const oldPaths = [...text.matchAll(/^--- a\/(\S+)\r?$/gm)].map(match => match[1]).sort();
  const newPaths = [...text.matchAll(/^\+\+\+ b\/(\S+)\r?$/gm)].map(match => match[1]).sort();
  assert.deepEqual(oldPaths, FILES, 'Patch must have ordinary source-file hunks');
  assert.deepEqual(newPaths, FILES, 'Patch must have ordinary destination-file hunks');
  assert.ok(!/^(?:new file mode|deleted file mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files )/m.test(text),
    'File creation, deletion, rename, copy or binary patches are outside this derivation');
}

// Keep machine-local diagnostics in CLI reports, outside distributable notices.
// An allowlist also prevents future local report fields from entering the bundle.
export function distributableSparkPatchReport(report) {
  return { schema_version: report.schema_version, input_identity: report.input_identity, scope: report.scope };
}

export async function verifySparkPatch(root, { licenseRoot } = {}) {
  root = resolve(root);
  const manifestFile = await physicalFile(root, MANIFEST);
  const manifest = JSON.parse(manifestFile.bytes);
  assert.equal(manifest.schema_version, 1, 'Unsupported Spark patch manifest');
  assert.ok(typeof manifest.id === 'string' && /^[a-z0-9][a-z0-9.-]+$/.test(manifest.id), 'Invalid Spark patch identity');
  assert.equal(manifest.package?.name, PACKAGE);
  assert.equal(manifest.package?.version, VERSION);
  assert.ok(isHash(manifest.package.package_json_sha256), 'Invalid package.json hash');
  assert.ok(isHash(manifest.patch?.sha256), 'Invalid patch hash');
  safeRelative(manifest.patch.path);
  assert.ok(manifest.patch.path.startsWith('patches/') && manifest.patch.path.endsWith('.patch'), 'Patch must be a repository patches/*.patch file');
  assert.ok(Array.isArray(manifest.files), 'Missing patched file records');
  assert.deepEqual(manifest.files.map(row => row.path).sort(), FILES, 'Manifest must declare exactly the patched files');
  for (const row of manifest.files) {
    assert.ok(isHash(row.base_sha256) && isHash(row.sha256) && row.base_sha256 !== row.sha256,
      `Invalid before/after hashes: ${row.path}`);
    assert.ok(Number.isSafeInteger(row.size_bytes) && row.size_bytes > 0, `Invalid patched size: ${row.path}`);
  }

  const workspace = await physicalFile(root, 'pnpm-workspace.yaml');
  assert.equal(patchedDependencies(configuration(workspace.bytes, workspace.record.path), workspace.record.path),
    manifest.patch.path, 'Workspace selects a different Spark patch');
  const lockfile = await physicalFile(root, 'pnpm-lock.yaml');
  const lock = configuration(lockfile.bytes, lockfile.record.path);
  assert.equal(String(lock.lockfileVersion), '9.0', 'Unsupported pnpm lockfile version');
  const locked = patchedDependencies(lock, lockfile.record.path);
  // The selected pnpm 11.12 writer records a scalar matching this patch's
  // SHA-256; older lockfile-9 writers used { hash, path }. Do not infer one
  // cross-version algorithm: retain pnpm's value and check file SHA separately.
  const lockedHash = typeof locked === 'string' ? locked : locked?.hash;
  if (typeof locked === 'string') {
    assert.equal(lockedHash, manifest.patch.sha256, 'Lockfile patch hash differs from the registered patch SHA-256');
  } else {
    assert.ok(locked && typeof locked === 'object' && !Array.isArray(locked), 'Invalid locked Spark patch');
    assert.equal(locked.path, manifest.patch.path, 'Lockfile selects a different Spark patch');
  }
  assert.ok(typeof lockedHash === 'string' && lockedHash.length > 0, 'Missing pnpm patch hash');
  const selection = lock.importers?.['apps/desktop']?.dependencies?.[PACKAGE];
  assert.equal(selection?.specifier, VERSION, 'Desktop lock importer does not select fixed Spark 2.1.0');
  assert.ok(typeof selection.version === 'string' && selection.version.startsWith(`${VERSION}(`),
    'Desktop lock importer does not select a patched Spark version');
  const selectedHashes = directPatchHashes(selection.version);
  assert.deepEqual(selectedHashes, [lockedHash], 'Desktop lock importer selects a different patch hash');
  const snapshotKey = `${PACKAGE}@${selection.version}`;
  assert.ok(lock.snapshots?.[snapshotKey] && typeof lock.snapshots[snapshotKey] === 'object' &&
    !Array.isArray(lock.snapshots[snapshotKey]), 'Missing patched Spark snapshot selected by desktop');
  assert.ok(typeof lock.packages?.[PATCH_KEY]?.resolution?.integrity === 'string', 'Missing locked Spark base package integrity');
  // Bind the full lockfile and selected snapshot as well as checking actual
  // patch and installed SHA-256s; registration alone does not prove selection.
  const patch = await physicalFile(root, manifest.patch.path);
  assert.equal(patch.record.sha256, manifest.patch.sha256, 'Spark patch bytes changed');
  checkPatchPaths(patch.bytes);

  const app = await physicalFile(root, 'apps/desktop/package.json');
  const appPackage = JSON.parse(app.bytes);
  assert.equal(appPackage.dependencies?.[PACKAGE], VERSION, 'Desktop must select fixed Spark 2.1.0');
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const selectedEntry = await realpath(require.resolve(PACKAGE));
  const packageRoot = await realpath(join(root, 'apps/desktop/node_modules', PACKAGE));
  assert.equal(selectedEntry, await realpath(join(packageRoot, 'dist/spark.cjs.js')), 'Desktop resolves a different Spark entry');
  const packageFile = await physicalFile(packageRoot, 'package.json');
  assert.equal(packageFile.record.sha256, manifest.package.package_json_sha256, 'Spark package.json differs from the declared base');
  const pkg = JSON.parse(packageFile.bytes);
  assert.equal(pkg.name, PACKAGE);
  assert.equal(pkg.version, VERSION);
  assert.deepEqual(pkg.exports?.['.'], { types: './dist/types/index.d.ts', import: './dist/spark.module.js', require: './dist/spark.cjs.js' },
    'Spark exports no longer select the verified entries');
  assert.equal(pkg.main, './dist/spark.cjs.js');
  assert.equal(pkg.module, './dist/spark.module.js');
  assert.equal(pkg.types, './dist/types/index.d.ts');

  const installed = [];
  for (const row of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const file = await physicalFile(packageRoot, row.path);
    assert.equal(file.record.size_bytes, row.size_bytes, `Installed Spark size differs: ${row.path}`);
    assert.equal(file.record.sha256, row.sha256, `Installed Spark bytes differ: ${row.path}`);
    // The distribution embeds unchanged worker source as escaped strings; its
    // worker-local map text is not the enclosing module's stale map directive.
    if (row.path.endsWith('.js')) assert.ok(!/^[\t ]*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/m.test(file.bytes.toString('utf8')),
      `Patched module retains a stale source map: ${row.path}`);
    installed.push({ ...file.record, base_sha256: row.base_sha256 });
  }
  const report = {
    schema_version: 1,
    input_identity: {
      id: manifest.id, package: { name: PACKAGE, version: VERSION, package_json_sha256: packageFile.record.sha256 },
      manifest: manifestFile.record, patch: patch.record, workspace: workspace.record, lockfile: lockfile.record,
      pnpm_patch_key: PATCH_KEY, pnpm_patch_hash: lockedHash, pnpm_snapshot_key: snapshotKey, files: installed,
    },
    installed_package_path: packageRoot,
    scope: 'Checks the registered local pnpm patch, both exact installed runtime modules selected by the fixed package exports and four related type declarations. Base hashes are provenance declarations, not a re-download of original npm bytes. Unmodified minified files and old source maps are not claimed as rebuilt or used. No GPU behavior or native memory result is established.',
  };
  if (licenseRoot) {
    for (const [path, expected] of [
      ['spark/patch-manifest.json', manifestFile.bytes], ['spark/patch.patch', patch.bytes],
      ['build-inputs/pnpm-workspace.yaml', workspace.bytes], ['build-inputs/pnpm-lock.yaml', lockfile.bytes],
    ]) {
      assert.ok((await physicalFile(licenseRoot, path)).bytes.equals(expected), `Spark license evidence differs: ${path}`);
    }
    const selected = JSON.parse((await physicalFile(licenseRoot, 'spark/installed-patch.json')).bytes);
    assert.deepEqual(selected.input_identity, report.input_identity, 'Selected license evidence describes a different Spark derivation');
    assert.deepEqual(selected, distributableSparkPatchReport(report),
      'Spark license evidence must contain only distributable report fields');
  }
  return report;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const options = {};
  let reportPath, expectedPath;
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    assert.ok(['--license-root', '--report', '--expected-report'].includes(flag), `Unknown argument: ${flag}`);
    const value = args.shift();
    assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
    if (flag === '--license-root') options.licenseRoot = resolve(value);
    else if (flag === '--report') reportPath = resolve(value);
    else expectedPath = resolve(value);
  }
  const report = await verifySparkPatch(root, options);
  if (expectedPath) assert.deepEqual(report.input_identity, JSON.parse(await readFile(expectedPath, 'utf8')).input_identity,
    'Spark derivation changed during packaging');
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ verified: true, id: report.input_identity.id, patch_sha256: report.input_identity.patch.sha256,
    installed_file_count: report.input_identity.files.length, license_evidence_verified: !!options.licenseRoot }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
