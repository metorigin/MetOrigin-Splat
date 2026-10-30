import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findVerifiedNpmNotices } from './npm-notice-evidence.mjs';

const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const gitBlob = value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'npm-notice-unit-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = join(root, 'packaging/shared/licenses');
  const installed = join(root, 'installed');
  mkdirSync(evidence, { recursive: true }); mkdirSync(join(installed, 'dist'), { recursive: true });
  const name = 'unit-fixture-package', version = '1.0.0', repository = 'https://github.com/example/unit-fixture';
  const manifest = JSON.stringify({ name, version, repository, license: 'MIT' });
  const runtime = 'export const fixture = true;\n';
  const license = readFileSync(new URL('../../packaging/shared/licenses/npm/react-resizable-panels/3.0.6/LICENSE', import.meta.url), 'utf8');
  writeFileSync(join(installed, 'package.json'), manifest); writeFileSync(join(installed, 'dist/index.js'), runtime);
  const prefix = 'packaging/shared/licenses/';
  const commit = '1234567890123456789012345678901234567890';
  const integrity = `sha512-${createHash('sha512').update('synthetic unit archive').digest('base64')}`;
  const publication = { url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity, sha1: hash('synthetic unit archive', 'sha1'), sha256: hash('synthetic unit archive'), file_count: 2,
    files: [{ path: 'package.json', bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }, { path: 'dist/index.js', bytes: Buffer.byteLength(runtime), sha256: hash(runtime) }], unpacked_size: Buffer.byteLength(manifest) + Buffer.byteLength(runtime) };
  const metadata = { name, version, license: 'MIT', gitHead: commit, repository, dist: { integrity, shasum: publication.sha1, tarball: publication.url, fileCount: 2, unpackedSize: publication.unpacked_size } };
  const metadataText = JSON.stringify(metadata);
  writeFileSync(join(evidence, 'registry.json'), metadataText); writeFileSync(join(evidence, 'upstream-package.json'), manifest); writeFileSync(join(evidence, 'LICENSE'), license);
  writeFileSync(join(root, 'pnpm-lock.yaml'), `packages:\n  ${name}@${version}:\n    resolution: {integrity: ${integrity}}\n`);
  const entry = { name, version, license: 'MIT', repository, commit, publication,
    metadata: { path: `${prefix}registry.json`, sha256: hash(metadataText) },
    upstream_manifest: { path: `${prefix}upstream-package.json`, upstream_path: 'package.json', sha256: hash(manifest), git_blob_sha1: gitBlob(manifest) },
    notices: [{ path: `${prefix}LICENSE`, upstream_path: 'LICENSE', sha256: hash(license), git_blob_sha1: gitBlob(license), url: `${repository}/blob/${commit}/LICENSE` }] };
  const index = { schema_version: 1, packages: [entry], unresolved: [] };
  const save = () => writeFileSync(join(evidence, 'npm-notice-index.json'), JSON.stringify(index));
  save();
  return { root, evidence, installed, index, entry, metadata, save };
}

test('returns an original fixed-publication notice without changing installed files', t => {
  const f = fixture(t);
  const before = readFileSync(join(f.installed, 'package.json'));
  const notices = findVerifiedNpmNotices(f.root, f.installed);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].matchedPublicationFiles, 2);
  assert.equal(notices[0].commit, f.entry.commit);
  assert.equal(notices[0].publishedTarballIntegrity, f.entry.publication.integrity);
  assert.equal(hash(readFileSync(notices[0].sourcePath)), notices[0].sha256);
  assert.deepEqual(readFileSync(join(f.installed, 'package.json')), before);
});

test('returns no notice for unmatched versions rather than applying an older license', t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(join(f.installed, 'package.json')));
  writeFileSync(join(f.installed, 'package.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
  assert.deepEqual(findVerifiedNpmNotices(f.root, f.installed), []);
});

test('rejects changed runtime bytes and missing publication members', t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, 'dist/index.js'), 'modified');
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /publication bytes differ/);
  rmSync(join(f.installed, 'dist/index.js'));
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed));
});

test('rejects a lock integrity mismatch and a changed original notice', t => {
  const f = fixture(t);
  const lock = readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8');
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), lock.replace('sha512-', 'sha256-'));
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /lock mismatch/);
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), lock);
  writeFileSync(join(f.evidence, 'LICENSE'), 'truncated');
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /hash mismatch/);
});

test('rejects changed metadata, non-fixed commits and incomplete member inventories', t => {
  const f = fixture(t);
  f.entry.commit = 'main'; f.save();
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /fixed npm publication/);
  f.entry.commit = f.metadata.gitHead; f.entry.publication.files.pop(); f.save();
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /Incomplete npm publication file inventory/);
  writeFileSync(join(f.evidence, 'registry.json'), '{}');
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /hash mismatch/);
});

test('rejects path traversal, absolute paths and source symlink escape', t => {
  const f = fixture(t);
  for (const path of ['../../package.json', '/etc/passwd', '..\\package.json']) {
    f.entry.notices[0].path = path; f.save();
    assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /shared license collection/);
  }
  symlinkSync(join(f.installed, 'package.json'), join(f.evidence, 'escape'));
  f.entry.notices[0].path = 'packaging/shared/licenses/escape'; f.save();
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /escapes/);
});

test('rejects installed-member symlink escape and incorrect Git blob identity', t => {
  const f = fixture(t);
  rmSync(join(f.installed, 'dist/index.js'));
  symlinkSync(join(f.evidence, 'LICENSE'), join(f.installed, 'dist/index.js'));
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /escapes/);
  rmSync(join(f.installed, 'dist/index.js')); writeFileSync(join(f.installed, 'dist/index.js'), 'export const fixture = true;\n');
  f.entry.notices[0].git_blob_sha1 = '0000000000000000000000000000000000000000'; f.save();
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /Git blob mismatch/);
});

test('keeps unresolved identity evidence visible and rejects its corruption', t => {
  const f = fixture(t);
  f.index.packages = [];
  const text = JSON.stringify({ status: 'unresolved-original-notice' });
  writeFileSync(join(f.evidence, 'unresolved.json'), text);
  f.index.unresolved = [{ name: f.entry.name, version: f.entry.version, evidence_path: 'packaging/shared/licenses/unresolved.json', sha256: hash(text) }]; f.save();
  assert.deepEqual(findVerifiedNpmNotices(f.root, f.installed), []);
  writeFileSync(join(f.evidence, 'unresolved.json'), 'changed');
  assert.throws(() => findVerifiedNpmNotices(f.root, f.installed), /hash mismatch/);
});
