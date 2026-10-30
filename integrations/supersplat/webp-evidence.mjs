import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyWebpBuildEvidence3102, webpBuildEvidenceFiles3102 } from './webp-overlay-3.10.2/verify-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = {
  libwebp: ['1.6.0', '4fa21912338357f89e4fd51cf2368325b59e9bd9'],
  emsdk: ['4.0.21', 'b2436aafa7351ee1b581f15841f1b45ed716a279'],
  'splat-transform': ['3.4.2', '0cb47cd81023cca117c20ce59a55ba584ee89177'],
  sharpyuv: ['0.4.2', '4fa21912338357f89e4fd51cf2368325b59e9bd9'],
};
const emscriptenCommit = 'd6f42310010ddec0753a69bab01a4b33aae255b7';
const archivePins = {
  libwebp: ['webmproject/libwebp', '923f3382a47a2af185c3240c954cf004428b237bd7317413a95146d01eb4b94b'],
  emsdk: ['emscripten-core/emsdk', '0279973682a9830976256cd5b28692c4ea7931f2a47baf2d0b3e22e31b6d3741'],
  'splat-transform': ['playcanvas/splat-transform', 'a8753ef7c53f7138f6552c4b81e8f4703060aecda0b93d2b807a4602e4d1c0d6'],
};
const runtimePrefix = 'sources/emsdk/upstream/emscripten/';
const requiredNotices = ['licenses/libwebp/COPYING', 'licenses/libwebp/PATENTS', 'licenses/libwebp/AUTHORS',
  'licenses/splat-transform/LICENSE', 'licenses/emscripten/LICENSE', 'licenses/emscripten/AUTHORS',
  'licenses/emscripten/system/lib/libc/musl/COPYRIGHT', 'licenses/emscripten/system/lib/compiler-rt/LICENSE.TXT',
  'licenses/emscripten/system/lib/dlmalloc.c', 'licenses/emscripten/system/lib/libc/sbrk.c',
  'licenses/emscripten/system/lib/libc/musl/src/math/log10.c',
  'licenses/emscripten/system/lib/libc/musl/src/stdlib/qsort.c'];

function safe(path) {
  assert.equal(typeof path, 'string', 'Evidence path must be a string.');
  assert(path && path.length < 512 && path.split('/').every(p => /^[A-Za-z0-9_.-]+$/.test(p) && !['.', '..'].includes(p)), `Unsafe WebP evidence path: ${path}`);
  return path;
}
function reference(record) {
  assert(record && typeof record === 'object' && /^[a-f0-9]{64}$/.test(record.sha256)
    && Number.isSafeInteger(record.size_bytes) && record.size_bytes >= 0 && record.size_bytes <= 16 * 1024 * 1024, 'Malformed or oversized WebP evidence reference.');
  return { path: safe(record.path), sha256: record.sha256, size_bytes: record.size_bytes };
}
function member(value) {
  assert.equal(typeof value, 'string');
  const match = value.match(/(?:^|\/)(lib(?:c|dlmalloc|compiler_rt|webp|sharpyuv)\.a\([^()]+\))$/);
  assert(match, `Unexpected linked runtime archive: ${value}`);
  return match[1];
}
function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `Duplicate ${label}.`);
  return [...values].sort();
}
function profileDigest(rows) {
  // Explicit ordinal ordering is independent of the host locale. Pin the
  // reviewed fixed-source profile, not only self-reported enclosing hashes.
  rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha(Buffer.from(JSON.stringify(rows)));
}
function noticeComponent(path) {
  if (path.startsWith('licenses/libwebp/')) return 'libwebp';
  if (path === 'licenses/splat-transform/LICENSE') return 'splat-transform';
  if (path.startsWith('licenses/emscripten/system/lib/libc/musl/')) return 'musl';
  if (path.startsWith('licenses/emscripten/system/lib/compiler-rt/')) return 'compiler-rt';
  if (path === 'licenses/emscripten/system/lib/dlmalloc.c') return 'dlmalloc';
  if (path.startsWith('licenses/emscripten/') && !path.startsWith('licenses/emscripten/tools/')) return 'emscripten-runtime';
  return null; // SDK/build-selection sources are evidence, not redistributed runtimes.
}

/** The only copied subset. Paths are relative to overlayRoot, preserving the
 * original stage paths below evidence/. Archives, .a files and duplicate output
 * binaries are intentionally represented by their recorded hashes, not copied.
 */
export function webpBuildEvidenceFiles(evidence) {
  if (evidence.schema_version === 2) return webpBuildEvidenceFiles3102(evidence);
  assert.equal(evidence.schema_version, 1);
  const records = new Map();
  const first = evidence.successful_steps?.find(step => step.path === 'receipts/install-sdk.json');
  assert(first?.command?.cwd?.endsWith('/sources/emsdk'), 'Missing fixed SDK stage identity.');
  const stage = first.command.cwd.slice(0, -'/sources/emsdk'.length);
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if ('path' in value && 'sha256' in value && 'size_bytes' in value) {
      let path = value.path;
      if (path.startsWith('${REPO_ROOT}/')) {
        assert.equal(evidence.path_normalization?.schema_version, 1, 'Unreviewed normalized evidence path.');
        assert.equal(evidence.path_normalization.original_build_evidence_sha256,
          'd5b9bb0d38bb3f611656455a2853651469e5ed1f5c02cae965396630c873ecaa', 'Unreviewed original evidence identity.');
      }
      if (path.startsWith('/') || path.startsWith('${REPO_ROOT}/')) {
        assert(path.startsWith(stage + '/'), 'Build log escapes the recorded stage.');
        path = path.slice(stage.length + 1);
        assert(/^(?:v2\/)?logs\//.test(path), 'Only recorded log paths may be absolute.');
      }
      const record = reference({ ...value, path });
      const previous = records.get(path);
      if (previous) assert.deepEqual(previous, record, `Conflicting WebP evidence: ${path}`);
      else records.set(path, record);
    }
    for (const [key, child] of Object.entries(value)) if (!['path', 'source_path'].includes(key)) collect(child);
  }
  for (const source of evidence.sources ?? []) { collect(source.wrapper); collect(source.version_header); }
  for (const key of ['environment', 'emsdk_config', 'cmake_cache', 'source_changes', 'build_driver',
    'codec_source_change', 'dependency_clone', 'rebuild_recipe']) collect(evidence.configuration?.[key]);
  collect(evidence.successful_steps);
  collect(evidence.recorded_non_success_attempts);
  collect(evidence.outputs?.link_map); collect(evidence.outputs?.symbol_map); collect(evidence.outputs?.overlay_candidate);
  collect(evidence.runtime_evidence?.original_notices_and_linked_sources);
  collect(evidence.verification);
  return [...records.values()].map(record => ({ ...record, path: `evidence/${record.path}` })).sort((a, b) => a.path.localeCompare(b.path));
}

async function readPhysical(root, record) {
  let path = root;
  const parts = safe(record.path).split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const info = await lstat(path);
    assert(!info.isSymbolicLink() && (i === parts.length - 1 ? info.isFile() : info.isDirectory()), `Nonphysical WebP evidence: ${record.path}`);
    if (i === parts.length - 1) assert.equal(info.size, record.size_bytes, `WebP evidence size mismatch: ${record.path}`);
  }
  const bytes = await readFile(path);
  assert.equal(sha(bytes), record.sha256, `WebP evidence hash mismatch: ${record.path}`);
  return bytes;
}

export async function verifyWebpBuildEvidence(overlayRoot, overlay) {
  if (overlay.evidence.schema_version === 2) return verifyWebpBuildEvidence3102(overlayRoot, overlay);
  assert((await lstat(overlayRoot)).isDirectory(), 'WebP overlay must be a physical directory.');
  assert.equal(sha(overlay.evidenceBytes), overlay.manifest.build_evidence_sha256);
  const evidence = JSON.parse(overlay.evidenceBytes.toString('utf8'));
  const sources = new Map(evidence.sources.map(source => [source.name, source]));
  assert.equal(sources.size, evidence.sources.length);
  assert.deepEqual([...sources.keys()].sort(), Object.keys(pins).sort());
  for (const [name, [version, commit]] of Object.entries(pins)) {
    assert.equal(sources.get(name).version, version, `Unexpected ${name} version.`);
    assert.equal(sources.get(name).commit, commit, `Unexpected ${name} source.`);
  }
  for (const [name, [repository, digest]] of Object.entries(archivePins)) {
    const source = sources.get(name);
    assert.equal(source.repository, `https://github.com/${repository}`);
    assert.equal(source.download_url, `https://codeload.github.com/${repository}/tar.gz/${source.commit}`);
    assert.equal(source.archive.sha256, digest);
  }
  assert.equal(sources.get('splat-transform').wrapper.sha256, '32c66c6de02eb30223d629987dfbe885e9f2039a663fe3f9eebd666c0b4d62f9');
  assert.equal(sources.get('sharpyuv').version_header.sha256, '4fcb150246232b0e8e605752deb66ca861872f86dd692308d9f854e10ad964ee');
  assert.equal(overlay.manifest.base.commit, pins['splat-transform'][1]);
  assert.equal(evidence.toolchain.emscripten_version, '4.0.21');
  assert.equal(evidence.toolchain.emscripten_commit, emscriptenCommit);
  assert.equal(evidence.toolchain.release_selector, 'd70a5da89b3e673bf6a482724478fc17e81e575e');
  const sdk = evidence.toolchain.archives.find(item => item.path.endsWith('-wasm-binaries-arm64.tar.xz'));
  assert.equal(sdk?.sha256, '7960d8d33243f2f7acdac157136c6e93680550361ed71bb225fcfa25b6bbb2fb');
  assert.equal(sdk.download_url, `https://storage.googleapis.com/webassembly/emscripten-releases-builds/mac/${evidence.toolchain.release_selector}/wasm-binaries-arm64.tar.xz`);
  const emcc = evidence.toolchain.actual_versions.emcc;
  assert.equal(emcc.exit_code, 0); assert(emcc.stdout.includes(`4.0.21 (${emscriptenCommit})`));
  assert.equal(evidence.configuration.allocator, 'dlmalloc');
  assert.equal(evidence.configuration.simd, false); assert.equal(evidence.configuration.threads, false);
  const files = webpBuildEvidenceFiles(evidence), contents = new Map();
  for (const record of files) contents.set(record.path.slice('evidence/'.length), await readPhysical(overlayRoot, record));
  const changes = evidence.configuration.codec_source_change;
  assert.equal(changes.original.sha256, '1cfb3c675343af986f57eae3b66b1763008548eb2364dd6972a352958c2ed225');
  assert.equal(changes.modified.sha256, '93b36f2b4ce70c2980b321ff2c947ae84ed019e0fade3ced9a2d3bc7d7b2f594');
  const patch = JSON.parse(contents.get(changes.patch_record.path));
  assert.equal(patch.original_sha256, changes.original.sha256);
  assert.equal(patch.modified_sha256, changes.modified.sha256);
  assert(evidence.configuration.source_changes.some(item => item.sha256 === patch.patch_sha256));

  const derived = evidence.outputs.derived_files;
  assert.equal(derived.length, overlay.manifest.files.length);
  const derivedNames = [];
  for (const item of derived) {
    const match = item.file.path.match(/^sources\/splat-transform(?:-v2)?\/(.+)$/);
    assert(match, 'Unexpected derived package output path.');
    const path = match[1]; derivedNames.push(path);
    const selected = overlay.manifest.files.find(file => file.path === path);
    assert(selected, 'Unselected derived output.');
    assert.equal(item.original_sha256, selected.base_sha256);
    assert.equal(item.file.sha256, selected.sha256); assert.equal(item.file.size_bytes, selected.size_bytes);
    assert.equal(sha(overlay.files.get(path)), selected.sha256);
  }
  unique(derivedNames, 'derived outputs');
  assert.equal(evidence.outputs.paired_codec.length, 2);
  for (const [path, outputPath] of [['lib/webp.mjs', 'outputs/webp.mjs'], ['lib/webp.wasm', 'outputs/webp.wasm']]) {
    const record = evidence.outputs.paired_codec.find(file => file.path === outputPath);
    assert(record); assert.equal(sha(overlay.files.get(path)), record.sha256); assert.equal(overlay.files.get(path).length, record.size_bytes);
  }
  const candidate = JSON.parse(contents.get(evidence.outputs.overlay_candidate.path));
  assert.equal(candidate.kind, 'derived-overlay-candidate-v2');
  assert.deepEqual(candidate.base, overlay.manifest.base);
  assert.equal(candidate.files.length, overlay.manifest.files.length);
  unique(candidate.files.map(file => file.path), 'candidate outputs');
  for (const selected of overlay.manifest.files) {
    const candidateFile = candidate.files.find(file => file.path === selected.path);
    assert(candidateFile); assert.equal(candidateFile.sha256, selected.sha256); assert.equal(candidateFile.size_bytes, selected.size_bytes);
    assert.equal(candidateFile.base_sha256, selected.base_sha256); assert.equal(candidateFile.compressed_sha256, selected.compressed_sha256);
  }
  for (const step of evidence.successful_steps) {
    assert.equal(step.command.exit_code, 0, `Unsuccessful build step: ${step.path}`);
    assert.deepEqual(JSON.parse(contents.get(step.path)), step.command, `Build command receipt mismatch: ${step.path}`);
  }
  const link = evidence.successful_steps.find(step => step.path === 'receipts/link-webp.json');
  assert(link?.command.argv.includes('emcc') && link.command.argv.includes('-sMODULARIZE=1') && link.command.argv.includes('-sEXPORT_ES6=1'), 'Missing codec link recipe.');

  const runtime = evidence.runtime_evidence;
  const linked = unique(runtime.linked_members.map(member), 'linked archive members');
  const mapText = contents.get(evidence.outputs.link_map.path).toString('utf8');
  const mapMembers = [...new Set([...mapText.matchAll(/[^\s]+\.a\([^()]+\)/g)].map(match => member(match[0])))].sort();
  assert.deepEqual(linked, mapMembers, 'Runtime inventory differs from actual link map.');
  const selectedRuntime = linked.filter(value => /^(libc|libdlmalloc|libcompiler_rt)\.a\(/.test(value));
  assert(selectedRuntime.some(value => value === 'libdlmalloc.a(dlmalloc.o)') && selectedRuntime.includes('libcompiler_rt.a(stack_ops.o)'));
  assert.deepEqual(unique(runtime.source_mapping.map(item => member(item.archive_member)), 'runtime source mappings'), selectedRuntime);
  const originals = runtime.original_notices_and_linked_sources;
  unique(originals.map(item => item.path), 'original notices');
  for (const path of requiredNotices) assert(originals.some(item => item.path === path), `Missing runtime notice: ${path}`);
  assert.equal(profileDigest(runtime.source_mapping.map(item => [member(item.archive_member), [...item.source_paths].sort()])),
    '847a4dc24bb696ffaecd1d79bc634e134095481a4820195b93af113e9a2f9fb6', 'Runtime source mapping differs from the reviewed fixed-source profile.');
  // Fifty retained originals include 48 runtime notices/sources and two
  // provenance-only files (emsdk LICENSE and Emscripten system_libs.py).
  assert.equal(profileDigest(originals.map(item => [item.path, item.source_path, item.origin, item.sha256, item.size_bytes])),
    '2da6cc2e2dd175ba1c00dac1e3eb392f3080e6d5c38608d1c43d014a83f2f28a', 'Original notice/source inventory differs from the reviewed fixed-source profile.');
  for (const mapping of runtime.source_mapping) {
    assert(mapping.source_paths.length > 0);
    for (const sourcePath of mapping.source_paths) {
      assert(sourcePath.startsWith(runtimePrefix));
      const notice = originals.find(item => item.source_path === sourcePath);
      assert(notice && notice.origin === `Emscripten ${emscriptenCommit}`, `Missing linked source notice: ${sourcePath}`);
    }
  }
  const notices = originals.flatMap(item => {
    const component = noticeComponent(item.path);
    return component ? [{ ...reference(item), path: `evidence/${item.path}`, component, bytes: contents.get(item.path),
      source_path: item.source_path, origin: item.origin }] : [];
  });
  assert.equal(evidence.verification.upstream_sog_html_webp_tests.failed, 0);
  assert(evidence.verification.upstream_sog_html_webp_tests.passed > 0);
  for (const key of ['codec', 'distributions']) {
    const result = JSON.parse(contents.get(evidence.verification[key].path));
    assert(typeof result.status === 'string' && result.status.startsWith('passed'), `Missing ${key} acceptance.`);
  }
  const cleanup = JSON.parse(contents.get(evidence.verification.cleanup.path));
  assert.equal(cleanup.status, 'passed');
  assert.deepEqual(cleanup.counts, { primary_cases: 22, recovery_cases: 44, successful_output_comparisons: 5, failed_case_groups: 0 });
  assert.deepEqual(evidence.verification.cleanup_counts, cleanup.counts);
  assert.equal(cleanup.cases.length, cleanup.counts.primary_cases);
  assert.equal(cleanup.success_path_comparison.length, cleanup.counts.successful_output_comparisons);
  return { files, notices, linked_members: linked, sources: evidence.sources,
    scope: 'Fixed source/build/notice evidence. Not a symbol-level binary SBOM or public-release acceptance; original prebuilt WebP provenance remains unresolved.' };
}
