import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { loadWebpOverlay } from './overlay.mjs';
import { loadWebpOverlay as loadLegacy } from '../webp-overlay.mjs';
import { verifyWebpBuildEvidence, webpBuildEvidenceFiles } from '../webp-evidence.mjs';
import { BASE } from './profile.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let overlay, temporary;
before(async () => {
  overlay = await loadWebpOverlay(root);
  temporary = await mkdtemp('/tmp/metorigin-webp3102-');
  for (const file of webpBuildEvidenceFiles(overlay.evidence)) {
    const destination = join(temporary, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file.path), destination);
  }
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function modified(change) {
  const evidence = structuredClone(overlay.evidence);
  change(evidence);
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  return { ...overlay, evidence, evidenceBytes,
    manifest: { ...overlay.manifest, build_evidence_sha256: hash(evidenceBytes) } };
}

test('new acceptance binds the level ABI, new API comparison, notices and four built entries', async () => {
  const result = await verifyWebpBuildEvidence(temporary, overlay);
  assert.deepEqual(overlay.manifest.base, BASE);
  assert.equal(result.files.length, 87); assert.equal(result.notices.length, 48);
  assert.equal(result.linked_members.length, 94);
  assert(result.files.some(file => file.path === 'evidence/sources/libwebp/sharpyuv/sharpyuv.h'));
  assert.equal(result.sources.find(source => source.name === 'splat-transform').version, '3.10.2');
});

test('published current evidence and inherited record contain no machine paths', async () => {
  assert.equal(overlay.evidence.path_normalization.original_build_evidence_sha256,
    'cc62594c79c592967ba7ba59da3ca1a5381e8c198b544938cbb004276bed5f19');
  for (const bytes of [overlay.evidenceBytes, ...await Promise.all(webpBuildEvidenceFiles(overlay.evidence)
    .map(file => readFile(join(root, file.path))))]) {
    assert(!bytes.includes(Buffer.from('/Users/')), 'Published evidence contains a machine-specific home path.');
    assert(!bytes.includes(Buffer.from('/var/folders/')), 'Published evidence contains a machine-specific temporary path.');
  }
});

test('new and legacy loaders cannot accept each other’s package base', async () => {
  await assert.rejects(loadLegacy(root), /invalid base identity/);
  await assert.rejects(loadWebpOverlay(join(root, '../webp-overlay')), /invalid base identity/);
  await assert.rejects(verifyWebpBuildEvidence(temporary, { ...overlay,
    manifest: { ...overlay.manifest, base: { ...BASE, version: '3.4.2' } } }), /Unexpected new WebP package base/);
});

test('unknown profiles and missing source files fail after enclosing hashes are rebuilt', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.profile = 'unreviewed'; })), /Unknown WebP evidence profile/);
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => {
    e.files = e.files.filter(file => file.path !== 'sources/libwebp/sharpyuv/sharpyuv.h');
  })), /reviewed 3.10.2 profile/);
});

test('inherited toolchain provenance and new source identities cannot be self-attested', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.toolchain.emscripten_version = '4.0.22'; })), /fixed SDK identity/);
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => {
    e.sources.find(source => source.name === 'splat-transform').commit = '0cb47cd81023cca117c20ce59a55ba584ee89177';
  })));
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.configuration.codec_source_change.original.sha256 = '0'.repeat(64); })));
});

test('new cleanup acceptance cannot borrow old counts or omit official binary checks', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.verification.cleanup_counts.primary_cases = 22; })));
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.verification.official_binary_comparisons = 0; })));
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => {
    e.successful_steps.find(step => step.path === 'receipts/link-webp.json').command.argv = ['emcc', '-sMODULARIZE=1', '-sEXPORT_ES6=1'];
  })), /receipt mismatch/);
});

test('actual link map and original runtime notice inventory remain exact', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => { e.runtime_evidence.linked_members.pop(); })));
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(e => {
    e.runtime_evidence.original_notices_and_linked_sources = e.runtime_evidence.original_notices_and_linked_sources
      .filter(file => !file.path.endsWith('exp_data.h'));
  })), /reviewed new runtime profile/);
});

test('retained file paths reject traversal and bytes cannot be substituted with a symlink', async () => {
  const bad = structuredClone(overlay.evidence); bad.files[0].path = '../escape';
  assert.throws(() => webpBuildEvidenceFiles(bad), /Unsafe WebP evidence path/);
  const path = join(temporary, 'evidence/licenses/splat-transform/LICENSE');
  const original = await readFile(path);
  try {
    await writeFile(path, Buffer.alloc(original.length, 88));
    await assert.rejects(verifyWebpBuildEvidence(temporary, overlay), /hash mismatch/);
    await rm(path); await symlink(join(root, 'evidence/licenses/splat-transform/LICENSE'), path);
    await assert.rejects(verifyWebpBuildEvidence(temporary, overlay), /Nonphysical/);
  } finally {
    await rm(path, { force: true }); await writeFile(path, original);
  }
});
