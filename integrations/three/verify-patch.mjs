#!/usr/bin/env node
// Verify the local OrbitControls derivation without importing or running Three.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the YAML parser from an existing locked desktop build dependency.
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { load: parseYaml, JSON_SCHEMA } = createRequire(desktopRequire.resolve('eslint/package.json'))('js-yaml');
const PACKAGE = 'three';
const VERSION = '0.185.1';
const PATCH_KEY = `${PACKAGE}@${VERSION}`;
const COMPONENT = `pkg:npm/${PACKAGE}@${VERSION}`;
const MANIFEST = 'integrations/three/patch-manifest.json';
const FILE = 'examples/jsm/controls/OrbitControls.js';
const FILES = [FILE];
const EXPORTS = [
  { specifier: 'three/examples/jsm/controls/OrbitControls.js', pattern: './examples/jsm/*', target: './examples/jsm/*' },
  { specifier: 'three/addons/controls/OrbitControls.js', pattern: './addons/*', target: './examples/jsm/*' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const recordObject = value => value && typeof value === 'object' && !Array.isArray(value);

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
  assert.ok(fromBase && fromBase !== '..' && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase), `File escapes its root: ${path}`);
  const bytes = await readFile(full);
  const after = await lstat(full);
  assert.ok(info.size === after.size && info.mtimeMs === after.mtimeMs && info.ino === after.ino, `File changed while reading: ${path}`);
  return { bytes, record: { path, size_bytes: bytes.length, sha256: hash(bytes) } };
}

function configuration(bytes, source) {
  const config = parseYaml(bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: source });
  assert.ok(recordObject(config), `Invalid ${source}`);
  return config;
}

function patchedDependency(config, source) {
  assert.ok(recordObject(config.patchedDependencies), `Missing patchedDependencies in ${source}`);
  const keys = Object.keys(config.patchedDependencies).filter(key => key === PACKAGE || key.startsWith(`${PACKAGE}@`));
  assert.deepEqual(keys, [PATCH_KEY], `Ambiguous Three patch registration in ${source}`);
  return config.patchedDependencies[PATCH_KEY];
}

function checkPatchPaths(bytes) {
  const text = bytes.toString('utf8');
  const headers = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)\r?$/gm)];
  assert.equal((text.match(/^diff --git /gm) ?? []).length, headers.length, 'Unsupported patch diff header');
  assert.deepEqual(headers.map(match => match[1]).sort(), FILES, 'Patch must modify exactly the declared OrbitControls file');
  for (const match of headers) assert.equal(match[1], match[2], 'Patch cannot rename Three files');
  assert.deepEqual([...text.matchAll(/^--- a\/(\S+)\r?$/gm)].map(match => match[1]).sort(), FILES, 'Patch must have an ordinary source-file hunk');
  assert.deepEqual([...text.matchAll(/^\+\+\+ b\/(\S+)\r?$/gm)].map(match => match[1]).sort(), FILES, 'Patch must have an ordinary destination-file hunk');
  assert.ok(!/^(?:new file mode|deleted file mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files )/m.test(text),
    'File creation, deletion, rename, copy or binary patches are outside this derivation');
}

function exportMatches(key, subpath) {
  if (!key.includes('*')) return key === subpath;
  const [prefix, suffix, extra] = key.split('*');
  return extra === undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix);
}

function checkExportMap(pkg) {
  assert.equal(pkg.type, 'module', 'Three package must retain its ESM package type');
  assert.ok(recordObject(pkg.exports), 'Missing Three export map');
  for (const entry of EXPORTS) {
    assert.equal(pkg.exports[entry.pattern], entry.target, `Three export pattern no longer selects OrbitControls: ${entry.pattern}`);
    const subpath = `.${entry.specifier.slice(PACKAGE.length)}`;
    assert.deepEqual(Object.keys(pkg.exports).filter(key => exportMatches(key, subpath)), [entry.pattern],
      `Overlapping or conditional OrbitControls export: ${entry.specifier}`);
  }
}

// Keep absolute installed paths and any future local diagnostics out of notices.
export function distributableThreePatchReport(report) {
  return { schema_version: report.schema_version, input_identity: report.input_identity, scope: report.scope };
}

async function checkLicenseInventory(licenseRoot, report, license) {
  const evidence = JSON.parse((await physicalFile(licenseRoot, 'component-evidence.json')).bytes);
  assert.ok(Array.isArray(evidence), 'Invalid component license inventory');
  const rows = evidence.filter(row => row.component?.startsWith('pkg:npm/three@'));
  assert.equal(rows.length, 1, 'License inventory must select exactly one Three component');
  const row = rows[0];
  assert.equal(row.component, COMPONENT, 'License inventory selects another Three version');
  assert.equal(row.package_json_sha256, report.input_identity.package.package_json_sha256, 'Three inventory package.json differs');
  assert.equal(row.declared_license, 'MIT', 'Three inventory must retain the selected MIT declaration');
  assert.ok(['installed-desktop-production-root-before-tree-shaking', 'installed-production-dependency-closure-before-tree-shaking'].includes(row.evidence),
    'Three inventory must identify the selected installed production dependency source');
  assert.equal(row.local_derivation, report.input_identity.id, 'Three inventory local derivation differs');
  assert.equal(row.patch_evidence, 'three/installed-patch.json', 'Three inventory patch evidence differs');
  assert.deepEqual(row.modified_distribution_files, report.input_identity.files, 'Three inventory modified files differ');
  assert.equal(row.original_npm_distribution_bytes_claimed, false, 'Three inventory must not claim original npm distribution bytes');

  const notices = JSON.parse((await physicalFile(licenseRoot, 'dependency-license-index.json')).bytes);
  assert.ok(Array.isArray(notices), 'Invalid dependency license index');
  const noticePath = `dependencies/npm/three-${VERSION}/LICENSE`;
  const selected = notices.filter(item => item.component === COMPONENT && item.path === noticePath);
  assert.equal(selected.length, 1, 'Three LICENSE must have one selected inventory record');
  const copiedLicense = await physicalFile(licenseRoot, noticePath);
  assert.ok(copiedLicense.bytes.equals(license.bytes), 'Three copied LICENSE differs from the selected installed source');
  assert.equal(selected[0].sha256, license.record.sha256, 'Three LICENSE inventory hash differs');
  assert.equal(selected[0].size_bytes, license.record.size_bytes, 'Three LICENSE inventory size differs');

  const bom = JSON.parse((await physicalFile(licenseRoot, 'SBOM.cdx.json')).bytes);
  assert.ok(Array.isArray(bom.components), 'Invalid component SBOM');
  const components = bom.components.filter(component => component.name === PACKAGE);
  assert.equal(components.length, 1, 'SBOM must select exactly one Three component');
  const component = components[0];
  assert.equal(component['bom-ref'], COMPONENT, 'SBOM Three component reference differs');
  assert.equal(component.purl, COMPONENT, 'SBOM Three purl differs');
  assert.equal(component.version, VERSION, 'SBOM Three version differs');
  for (const [name, value] of [
    ['metorigin:inventory-evidence', row.evidence],
    ['metorigin:local-derivation', report.input_identity.id],
    ['metorigin:patch-sha256', report.input_identity.patch.sha256],
    ['metorigin:patch-evidence', 'three/installed-patch.json'],
  ]) {
    const properties = component.properties?.filter(property => property.name === name);
    assert.deepEqual(properties, [{ name, value }], `Three SBOM property differs: ${name}`);
  }
  assert.ok(component.licenses?.some(item => item.license?.name === 'MIT'), 'Three SBOM must retain the MIT declaration');
}

export async function verifyThreePatch(root, { licenseRoot } = {}) {
  root = resolve(root);
  const manifestFile = await physicalFile(root, MANIFEST);
  const manifest = JSON.parse(manifestFile.bytes);
  assert.equal(manifest.schema_version, 1, 'Unsupported Three patch manifest');
  assert.ok(typeof manifest.id === 'string' && /^[a-z0-9][a-z0-9.-]+$/.test(manifest.id), 'Invalid Three patch identity');
  assert.equal(manifest.package?.name, PACKAGE);
  assert.equal(manifest.package?.version, VERSION);
  assert.ok(isHash(manifest.package.package_json_sha256), 'Invalid package.json hash');
  assert.ok(isHash(manifest.patch?.sha256), 'Invalid patch hash');
  safeRelative(manifest.patch.path);
  assert.ok(manifest.patch.path.startsWith('patches/') && manifest.patch.path.endsWith('.patch'), 'Patch must be a repository patches/*.patch file');
  assert.ok(Array.isArray(manifest.files), 'Missing patched file records');
  assert.deepEqual(manifest.files.map(row => row.path).sort(), FILES, 'Manifest must declare exactly the patched OrbitControls file');
  for (const row of manifest.files) {
    assert.ok(isHash(row.base_sha256) && isHash(row.sha256) && row.base_sha256 !== row.sha256, `Invalid before/after hashes: ${row.path}`);
    assert.ok(Number.isSafeInteger(row.size_bytes) && row.size_bytes > 0, `Invalid patched size: ${row.path}`);
  }

  const workspace = await physicalFile(root, 'pnpm-workspace.yaml');
  assert.equal(patchedDependency(configuration(workspace.bytes, workspace.record.path), workspace.record.path), manifest.patch.path, 'Workspace selects a different Three patch');
  const lockfile = await physicalFile(root, 'pnpm-lock.yaml');
  const lock = configuration(lockfile.bytes, lockfile.record.path);
  assert.equal(String(lock.lockfileVersion), '9.0', 'Unsupported pnpm lockfile version');
  const locked = patchedDependency(lock, lockfile.record.path);
  // pnpm 11 scalar hashes are SHA-256. Older lockfile-9 writers use a hash/path
  // mapping; retain that writer's selected hash without inventing its algorithm.
  const lockedHash = typeof locked === 'string' ? locked : locked?.hash;
  if (typeof locked === 'string') assert.equal(lockedHash, manifest.patch.sha256, 'Lockfile patch hash differs from the registered patch SHA-256');
  else {
    assert.ok(recordObject(locked), 'Invalid locked Three patch');
    assert.equal(locked.path, manifest.patch.path, 'Lockfile selects a different Three patch');
  }
  assert.ok(typeof lockedHash === 'string' && lockedHash.length > 0, 'Missing pnpm patch hash');
  const selection = lock.importers?.['apps/desktop']?.dependencies?.[PACKAGE];
  assert.equal(selection?.specifier, VERSION, 'Desktop lock importer must select fixed Three 0.185.1');
  // Three has no peer qualifiers here. Do not scan nested Spark peer hashes.
  assert.equal(selection.version, `${VERSION}(patch_hash=${lockedHash})`, 'Desktop lock importer selects a different patched Three version');
  const snapshotKey = `${PACKAGE}@${selection.version}`;
  assert.ok(recordObject(lock.snapshots?.[snapshotKey]), 'Missing patched Three snapshot selected by desktop');
  const integrity = lock.packages?.[PATCH_KEY]?.resolution?.integrity;
  assert.ok(typeof integrity === 'string' && integrity.startsWith('sha512-'), 'Missing locked Three base package integrity');
  const patch = await physicalFile(root, manifest.patch.path);
  assert.equal(patch.record.sha256, manifest.patch.sha256, 'Three patch bytes changed');
  checkPatchPaths(patch.bytes);

  const app = await physicalFile(root, 'apps/desktop/package.json');
  assert.equal(JSON.parse(app.bytes).dependencies?.[PACKAGE], VERSION, 'Desktop must select fixed Three 0.185.1');
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const packageRoot = await realpath(join(root, 'apps/desktop/node_modules', PACKAGE));
  const packageFile = await physicalFile(packageRoot, 'package.json');
  assert.equal(packageFile.record.sha256, manifest.package.package_json_sha256, 'Three package.json differs from the declared base');
  const pkg = JSON.parse(packageFile.bytes);
  assert.equal(pkg.name, PACKAGE);
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.license, 'MIT', 'Three package must retain its MIT license declaration');
  checkExportMap(pkg);
  for (const entry of EXPORTS) assert.equal(await realpath(require.resolve(entry.specifier)), await realpath(join(packageRoot, FILE)),
    `Desktop resolves a different OrbitControls file: ${entry.specifier}`);
  const installed = [];
  for (const row of manifest.files) {
    const file = await physicalFile(packageRoot, row.path);
    assert.equal(file.record.size_bytes, row.size_bytes, `Installed Three size differs: ${row.path}`);
    assert.equal(file.record.sha256, row.sha256, `Installed Three bytes differ: ${row.path}`);
    installed.push({ ...file.record, base_sha256: row.base_sha256 });
  }
  const license = await physicalFile(packageRoot, 'LICENSE');
  const report = {
    schema_version: 1,
    input_identity: {
      id: manifest.id, package: { name: PACKAGE, version: VERSION, package_json_sha256: packageFile.record.sha256 },
      manifest: manifestFile.record, patch: patch.record, workspace: workspace.record, lockfile: lockfile.record, desktop_package: app.record,
      pnpm_patch_key: PATCH_KEY, pnpm_patch_hash: lockedHash, pnpm_snapshot_key: snapshotKey, pnpm_base_integrity: integrity,
      files: installed, selected_exports: EXPORTS.map(entry => ({ specifier: entry.specifier, path: FILE })),
      license: { declared: pkg.license, file: license.record },
    },
    installed_package_path: packageRoot,
    scope: 'Checks the registered version-specific pnpm patch and exact installed OrbitControls ESM file selected by both examples/jsm and addons exports, plus the installed MIT notice source. Other Three runtime files are not claimed as rebuilt or patched. Base file hashes and npm integrity are provenance declarations, not a re-download of original npm bytes. With licenseRoot, checks copied derivation inputs, component evidence, license index/text and SBOM provenance. No runtime, native memory, signing or release acceptance is established.',
  };
  if (licenseRoot) {
    for (const [path, expected] of [
      ['three/patch-manifest.json', manifestFile.bytes], ['three/patch.patch', patch.bytes],
      ['build-inputs/pnpm-workspace.yaml', workspace.bytes], ['build-inputs/pnpm-lock.yaml', lockfile.bytes],
      ['build-inputs/desktop-package.json', app.bytes],
    ]) assert.ok((await physicalFile(licenseRoot, path)).bytes.equals(expected), `Three license evidence differs: ${path}`);
    const selected = JSON.parse((await physicalFile(licenseRoot, 'three/installed-patch.json')).bytes);
    assert.deepEqual(selected.input_identity, report.input_identity, 'Selected license evidence describes a different Three derivation');
    assert.deepEqual(selected, distributableThreePatchReport(report), 'Three license evidence must contain only distributable report fields');
    await checkLicenseInventory(licenseRoot, report, license);
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
  const report = await verifyThreePatch(root, options);
  if (expectedPath) assert.deepEqual(report.input_identity, JSON.parse(await readFile(expectedPath, 'utf8')).input_identity, 'Three derivation changed during packaging');
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ verified: true, id: report.input_identity.id, patch_sha256: report.input_identity.patch.sha256,
    installed_file_count: report.input_identity.files.length, license_evidence_verified: !!options.licenseRoot }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
