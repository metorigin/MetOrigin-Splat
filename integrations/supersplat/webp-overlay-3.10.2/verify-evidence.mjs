import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE, PINS, PROFILE } from './profile.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = rows => sha(Buffer.from(JSON.stringify(rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));
const member = value => {
  const match = value.match(/(?:^|\/)(lib(?:c|dlmalloc|compiler_rt|webp|sharpyuv)\.a\([^()]+\))$/);
  assert(match, 'Unexpected linked archive member.');
  return match[1];
};
const unique = (values, label) => { assert.equal(new Set(values).size, values.length, `Duplicate ${label}.`); return [...values].sort(); };

function reference(record) {
  assert(record && typeof record === 'object', 'Missing evidence record.');
  assert(typeof record.path === 'string' && record.path.length > 0 && record.path.length < 512
    && record.path.split('/').every(p => /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..'), 'Unsafe WebP evidence path.');
  assert(/^[a-f0-9]{64}$/.test(record.sha256) && Number.isSafeInteger(record.size_bytes)
    && record.size_bytes >= 0 && record.size_bytes <= 16 * 1024 * 1024, 'Malformed WebP evidence record.');
  return { path: record.path, sha256: record.sha256, size_bytes: record.size_bytes };
}

export function webpBuildEvidenceFiles3102(evidence) {
  assert.equal(evidence.schema_version, 2);
  assert.equal(evidence.profile, PROFILE, 'Unknown WebP evidence profile.');
  assert(Array.isArray(evidence.files), 'Missing evidence file inventory.');
  const records = evidence.files.map(reference);
  unique(records.map(file => file.path), 'evidence paths');
  assert.equal(digest(records.map(file => [file.path, file.sha256, file.size_bytes])), PINS.files,
    'WebP evidence file inventory differs from the reviewed 3.10.2 profile.');
  return records.map(file => ({ ...file, path: `evidence/${file.path}` }));
}

async function physical(root, record) {
  let path = root;
  const parts = record.path.split('/');
  for (let i = 0; i < parts.length; ++i) {
    path = join(path, parts[i]);
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `Nonphysical WebP evidence: ${record.path}`);
    if (i === parts.length - 1) assert.equal(stat.size, record.size_bytes, `WebP evidence size mismatch: ${record.path}`);
  }
  const bytes = await readFile(path);
  assert.equal(sha(bytes), record.sha256, `WebP evidence hash mismatch: ${record.path}`);
  return bytes;
}

function noticeComponent(path) {
  if (path.startsWith('licenses/libwebp/')) return 'libwebp';
  if (path === 'licenses/splat-transform/LICENSE') return 'splat-transform';
  if (path.startsWith('licenses/emscripten/system/lib/libc/musl/')) return 'musl';
  if (path.startsWith('licenses/emscripten/system/lib/compiler-rt/')) return 'compiler-rt';
  if (path === 'licenses/emscripten/system/lib/dlmalloc.c') return 'dlmalloc';
  if (path.startsWith('licenses/emscripten/') && !path.startsWith('licenses/emscripten/tools/')) return 'emscripten-runtime';
  return null;
}

export async function verifyWebpBuildEvidence3102(root, overlay) {
  assert((await lstat(root)).isDirectory(), 'WebP overlay must be physical.');
  assert.equal(sha(overlay.evidenceBytes), overlay.manifest.build_evidence_sha256);
  assert.deepEqual(overlay.manifest.base, BASE, 'Unexpected new WebP package base.');
  const evidence = JSON.parse(overlay.evidenceBytes.toString('utf8'));
  assert.equal(evidence.status, 'passed-node-acceptance');
  const files = webpBuildEvidenceFiles3102(evidence);
  const contents = new Map();
  for (const file of files) contents.set(file.path.slice(9), await physical(root, file));
  const bytesOf = record => {
    const selected = reference(record), bytes = contents.get(selected.path);
    assert(bytes, `Unretained evidence reference: ${selected.path}`);
    assert.equal(bytes.length, selected.size_bytes); assert.equal(sha(bytes), selected.sha256);
    return bytes;
  };
  const jsonOf = record => JSON.parse(bytesOf(record).toString('utf8'));
  const inherited = jsonOf(evidence.configuration.reused_build_evidence);
  assert.equal(evidence.configuration.reused_build_evidence.sha256, PINS.inheritedBuild);
  const sources = new Map(evidence.sources.map(source => [source.name, source]));
  assert.equal(sources.size, 4); assert.equal(evidence.sources.length, 4);
  for (const name of ['libwebp', 'emsdk', 'sharpyuv']) {
    assert.deepEqual(sources.get(name), inherited.sources.find(source => source.name === name), `Changed inherited ${name} provenance.`);
  }
  bytesOf(sources.get('sharpyuv').version_header);
  const transform = sources.get('splat-transform');
  assert.equal(transform?.version, BASE.version); assert.equal(transform.commit, BASE.commit);
  assert.equal(transform.repository, 'https://github.com/playcanvas/splat-transform');
  assert.equal(transform.download_url, `https://codeload.github.com/playcanvas/splat-transform/tar.gz/${BASE.commit}`);
  assert.equal(transform.archive.sha256, PINS.sourceArchive);
  assert.equal(transform.npm.download_url, 'https://registry.npmjs.org/@playcanvas/splat-transform/-/splat-transform-3.10.2.tgz');
  assert.equal(transform.npm.archive.sha256, PINS.npmArchive);
  assert.equal(transform.npm.integrity, 'sha512-HqPKu4mY63Ec7Cf92UQKopc9LdNyszWka47eepbL30RCg76RIECn4EUX+zyQtMs7NWfjU29e6q3zO4itA8T/eQ==');
  assert.equal(transform.wrapper.sha256, PINS.wrapper); bytesOf(transform.wrapper);
  assert.equal(transform.wrapper_unchanged_from_pinned_source, true);
  assert.deepEqual(evidence.toolchain, inherited.toolchain, 'Changed inherited fixed SDK identity.');
  assert.equal(evidence.configuration.allocator, 'dlmalloc');
  assert.equal(evidence.configuration.simd, false); assert.equal(evidence.configuration.threads, false);
  assert.equal(evidence.configuration.upstream_C_wrapper_unchanged, true);
  assert.deepEqual(evidence.configuration.reused_libraries.map(file => [file.sha256, file.size_bytes]), [
    ['9f13951a3f97af7da304543988d3afec5d1e4569ee7f0ced355241e99d11e8d3', 504710],
    ['969f51b18202d9791ff01b949a23d30eb16bbda83b35268fd0def051e1bbf4f3', 22012],
  ]);
  assert.equal(sha(contents.get('originals/package.json')), BASE.package_json_sha256);
  const changes = evidence.configuration.codec_source_change;
  for (const [key, pin] of [['original', PINS.originalCodec], ['modified', PINS.modifiedCodec], ['patch', PINS.cleanupPatch]]) {
    assert.equal(changes[key].sha256, pin); bytesOf(changes[key]);
  }
  const patch = jsonOf(changes.patch_record);
  assert.equal(patch.original_sha256, PINS.originalCodec); assert.equal(patch.modified_sha256, PINS.modifiedCodec);
  assert.equal(patch.patch_sha256, PINS.cleanupPatch);

  const candidate = jsonOf(evidence.outputs.overlay_candidate);
  assert.equal(candidate.kind, 'derived-overlay-candidate-3.10.2-v1');
  assert.deepEqual(candidate.base, BASE); assert.deepEqual(candidate.files, overlay.manifest.files);
  assert.equal(evidence.outputs.derived_files.length, 10);
  const derivedPaths = [];
  for (const item of evidence.outputs.derived_files) {
    const match = item.file.path.match(/^sources\/splat-transform\/(.+)$/);
    assert(match, 'Unexpected new derived output path.');
    const path = match[1]; derivedPaths.push(path);
    const selected = overlay.manifest.files.find(file => file.path === path);
    assert(selected); assert.equal(item.original_sha256, selected.base_sha256);
    assert.equal(item.file.sha256, selected.sha256); assert.equal(item.file.size_bytes, selected.size_bytes);
    assert.equal(sha(overlay.files.get(path)), selected.sha256);
  }
  unique(derivedPaths, 'derived outputs');
  for (const name of ['webp.mjs', 'webp.wasm']) {
    const output = evidence.outputs.paired_codec.find(file => file.path === `outputs/${name}`);
    assert(output); assert.equal(sha(overlay.files.get(`lib/${name}`)), output.sha256);
  }
  const requiredSteps = ['download-npm', 'npm-ci', 'link-webp', 'build-distributions', 'verify-cleanup-official', 'verify-distributions', 'verify-upstream'];
  assert.deepEqual(evidence.successful_steps.map(step => step.path), requiredSteps.map(name => `receipts/${name}.json`));
  for (const step of evidence.successful_steps) {
    assert.equal(step.command.exit_code, 0);
    assert.deepEqual(JSON.parse(contents.get(step.path)), step.command, `Build receipt mismatch: ${step.path}`);
    bytesOf(step.command.log);
  }
  const link = evidence.successful_steps.find(step => step.path === 'receipts/link-webp.json').command;
  assert(link.argv.includes('emcc') && link.argv.includes('-sMODULARIZE=1') && link.argv.includes('-sEXPORT_ES6=1'));
  assert(link.argv.some(arg => arg.includes('_webp_encode_lossless_rgba_level')), 'Missing new WebP level ABI.');
  const mapText = bytesOf(evidence.outputs.link_map).toString('utf8');
  bytesOf(evidence.outputs.symbol_map);
  assert(mapText.includes('webp_encode_lossless_rgba_level'), 'New level wrapper absent from the actual link map.');
  const runtime = evidence.runtime_evidence;
  const linked = unique(runtime.linked_members.map(member), 'runtime members');
  assert.deepEqual(linked, [...new Set([...mapText.matchAll(/[^\s]+\.a\([^()]+\)/g)].map(match => member(match[0])))].sort());
  assert.deepEqual(linked, inherited.runtime_evidence.linked_members.map(member).sort());
  assert.equal(digest(runtime.source_mapping.map(item => [member(item.archive_member), [...item.source_paths].sort()])), PINS.runtimeMapping);
  const originals = runtime.original_notices_and_linked_sources;
  unique(originals.map(item => item.path), 'runtime originals');
  assert.equal(digest(originals.map(item => [item.path, item.source_path, item.origin, item.sha256, item.size_bytes])), PINS.runtimeNotices,
    'Original notices differ from the reviewed new runtime profile.');
  const systemMembers = linked.filter(value => /^(libc|libdlmalloc|libcompiler_rt)\.a\(/.test(value));
  assert.deepEqual(unique(runtime.source_mapping.map(item => member(item.archive_member)), 'runtime mappings'), systemMembers);
  for (const item of originals) bytesOf(item);
  assert.equal(originals.find(item => item.path === 'licenses/splat-transform/LICENSE').sha256, PINS.license);
  for (const mapping of runtime.source_mapping) for (const path of mapping.source_paths) {
    assert(originals.some(item => item.source_path === path), `Missing linked runtime source ${path}`);
  }
  const cleanup = jsonOf(evidence.verification.cleanup);
  assert.deepEqual(evidence.verification.codec, evidence.verification.cleanup);
  assert.equal(cleanup.status, 'passed');
  const expectedCounts = { primary_cases: 33, recovery_cases: 99, successful_output_comparisons: 30, failed_case_groups: 0 };
  assert.deepEqual(cleanup.counts, expectedCounts); assert.deepEqual(evidence.verification.cleanup_counts, expectedCounts);
  assert.equal(cleanup.cases.length, 33); assert.equal(cleanup.success_path_comparison.length, 30);
  assert.equal(cleanup.official_binary_comparison.length, 12); assert.equal(evidence.verification.official_binary_comparisons, 12);
  assert.deepEqual(cleanup.invalid_efforts, ['-1', '10', '1.5', 'NaN', 'Infinity']);
  for (const test of cleanup.cases) {
    assert.equal(test.status, 'passed'); assert.equal(test.recovery.length, 3);
    for (const result of [test, ...test.recovery]) {
      assert.equal(result.status, 'passed'); assert.equal(result.observed.outstanding_callers, 0);
      assert.equal(result.observed.outstanding_codec_outputs, 0); assert.deepEqual(result.observed.violations, []);
    }
  }
  for (const row of cleanup.official_binary_comparison) assert(row.identical_decoded_RGBA && row.cross_decode);
  const distributions = jsonOf(evidence.verification.distributions);
  assert.equal(distributions.status, 'passed-with-known-limitations'); assert.equal(distributions.direct_built_worker, true);
  assert.equal(distributions.results.length, 2); assert.equal(distributions.source_map_bindings.length, 4);
  for (const result of distributions.results) assert(result.codec_roundtrip && result.real_worker_queue_roundtrip);
  for (const binding of distributions.source_map_bindings) {
    assert.equal(binding.glue_sha256, sha(overlay.files.get('lib/webp.mjs')));
    assert.equal(binding.codec_source_sha256, PINS.modifiedCodec);
    assert.equal(binding.entry_sha256, sha(overlay.files.get(`dist/${binding.entry}`)));
  }
  const upstream = jsonOf(evidence.verification.upstream_sog_html_webp_tests.receipt);
  assert.equal(upstream.status, 'passed'); assert.equal(upstream.passed, 16); assert.equal(upstream.failed, 0);
  assert.equal(evidence.verification.upstream_sog_html_webp_tests.passed, 16);
  assert.equal(evidence.verification.upstream_sog_html_webp_tests.failed, 0);
  const notices = originals.flatMap(item => {
    const component = noticeComponent(item.path);
    return component ? [{ ...reference(item), path: `evidence/${item.path}`, component, bytes: bytesOf(item),
      source_path: item.source_path, origin: item.origin }] : [];
  });
  return { files, notices, linked_members: linked, sources: evidence.sources,
    scope: 'New fixed 3.10.2 wrapper, linked codec and distribution acceptance; reused fixed libwebp/SDK provenance is explicitly separate. Node only; native/public release acceptance remains separate.' };
}
