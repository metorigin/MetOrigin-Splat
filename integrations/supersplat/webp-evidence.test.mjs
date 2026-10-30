import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { loadWebpOverlay } from './webp-overlay.mjs';
import { verifyWebpBuildEvidence, webpBuildEvidenceFiles } from './webp-evidence.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), 'webp-overlay');
const hash = value => createHash('sha256').update(value).digest('hex');
let overlay, temporary;
before(async () => {
  overlay = await loadWebpOverlay(root);
  temporary = await mkdtemp('/tmp/metorigin-webp-evidence-');
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
  return { ...overlay, evidenceBytes, manifest: { ...overlay.manifest, build_evidence_sha256: hash(evidenceBytes) } };
}

test('frozen build evidence binds all runtime notices and v2 source changes', async () => {
  const result = await verifyWebpBuildEvidence(temporary, overlay);
  assert.equal(result.files.length, 106);
  assert.equal(result.notices.length, 48);
  assert.equal(result.linked_members.length, 94);
  assert(result.files.some(file => file.path === 'evidence/v2/source-patch.json'));
  assert(result.files.some(file => file.path === 'evidence/sources/splat-transform-v2/src/lib/utils/webp-codec.ts'));
});

test('published legacy evidence retains its original identity without machine paths', async () => {
  assert.equal(overlay.evidence.path_normalization.original_build_evidence_sha256,
    'd5b9bb0d38bb3f611656455a2853651469e5ed1f5c02cae965396630c873ecaa');
  for (const bytes of [overlay.evidenceBytes, ...await Promise.all(webpBuildEvidenceFiles(overlay.evidence)
    .map(file => readFile(join(root, file.path))))]) {
    assert(!bytes.includes(Buffer.from('/Users/')), 'Published evidence contains a machine-specific home path.');
    assert(!bytes.includes(Buffer.from('/var/folders/')), 'Published evidence contains a machine-specific temporary path.');
  }
});

test('normalized log references retain stage, log-only and provenance confinement', () => {
  const stage = overlay.evidence.successful_steps.find(step => step.path === 'receipts/install-sdk.json')
    .command.cwd.slice(0, -'/sources/emsdk'.length);
  for (const path of ['${REPO_ROOT}/unrelated/logs/untrusted.log', `${stage}/logs/../untrusted.log`,
    `${stage}/build-environment.json`, '${HOME}/untrusted.log']) {
    const evidence = structuredClone(overlay.evidence);
    evidence.configuration.environment.path = path;
    assert.throws(() => webpBuildEvidenceFiles(evidence));
  }
  const evidence = structuredClone(overlay.evidence);
  evidence.path_normalization.original_build_evidence_sha256 = '0'.repeat(64);
  assert.throws(() => webpBuildEvidenceFiles(evidence), /Unreviewed original evidence identity/);
});

test('deleting an original runtime notice fails even with rebuilt outer hashes', async () => {
  const changed = modified(evidence => {
    evidence.runtime_evidence.original_notices_and_linked_sources = evidence.runtime_evidence.original_notices_and_linked_sources
      .filter(file => file.path !== 'licenses/emscripten/system/lib/libc/musl/src/math/log10.c');
  });
  await assert.rejects(verifyWebpBuildEvidence(temporary, changed), /Missing runtime notice/);
});

test('invented source pins and cleanup counts cannot be self-attested', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(evidence => evidence.sources[0].version = '1.7.0')), /Unexpected libwebp version/);
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(evidence => evidence.verification.cleanup_counts.failed_case_groups = 1)));
});

test('runtime inventory must equal the actual link map and cover each system member', async () => {
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(evidence => evidence.runtime_evidence.linked_members.pop())), /Runtime inventory/);
  await assert.rejects(verifyWebpBuildEvidence(temporary, modified(evidence => evidence.runtime_evidence.source_mapping.pop())));
});

test('Arm source notices cannot be dropped by remapping members or omitting header references', async () => {
  const removed = 'sources/emsdk/upstream/emscripten/system/lib/libc/musl/src/math/expf.c';
  const changed = modified(evidence => {
    evidence.runtime_evidence.original_notices_and_linked_sources = evidence.runtime_evidence.original_notices_and_linked_sources.filter(file => file.source_path !== removed);
    const mapping = evidence.runtime_evidence.source_mapping.find(item => item.archive_member.endsWith('libc.a(expf.o)'));
    mapping.source_paths = ['sources/emsdk/upstream/emscripten/system/lib/libc/musl/src/math/log10.c'];
  });
  await assert.rejects(verifyWebpBuildEvidence(temporary, changed), /reviewed fixed-source profile/);
  const header = modified(evidence => {
    evidence.runtime_evidence.original_notices_and_linked_sources = evidence.runtime_evidence.original_notices_and_linked_sources.filter(file => !file.path.endsWith('/exp_data.h'));
    for (const mapping of evidence.runtime_evidence.source_mapping) mapping.source_paths = mapping.source_paths.filter(path => !path.endsWith('/exp_data.h'));
  });
  await assert.rejects(verifyWebpBuildEvidence(temporary, header), /reviewed fixed-source profile/);
});

test('selected receipts cannot escape the recorded stage', () => {
  const evidence = structuredClone(overlay.evidence);
  evidence.configuration.environment.path = '../build-environment.json';
  assert.throws(() => webpBuildEvidenceFiles(evidence), /Unsafe WebP evidence path/);
  evidence.configuration.environment.path = '/tmp/untrusted.json';
  assert.throws(() => webpBuildEvidenceFiles(evidence), /escapes the recorded stage/);
});

test('unchanged metadata cannot hide modified bytes or a symlink', async () => {
  const path = join(temporary, 'evidence/licenses/libwebp/COPYING');
  const original = await readFile(path);
  try {
    await writeFile(path, Buffer.alloc(original.length, 88));
    await assert.rejects(verifyWebpBuildEvidence(temporary, overlay), /hash mismatch/);
    await rm(path);
    await symlink(join(root, 'evidence/licenses/libwebp/COPYING'), path);
    await assert.rejects(verifyWebpBuildEvidence(temporary, overlay), /Nonphysical/);
  } finally {
    await rm(path, { force: true });
    await writeFile(path, original);
  }
});
