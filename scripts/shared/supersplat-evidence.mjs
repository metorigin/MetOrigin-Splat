import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { overlayIdentity, preparationSignature, verifyPreparedAssets } from '../../integrations/supersplat/prepared-assets.mjs';
import { verifyWebpBuildEvidence } from '../../integrations/supersplat/webp-evidence.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const CURRENT_SUPERSPLAT = Object.freeze({
  repository: 'https://github.com/playcanvas/supersplat.git',
  version: '3.7.0', commit: 'b89029dd20911fd18905b61de2701094ac390a73',
});
export const CURRENT_TRANSFORM = Object.freeze({
  name: '@playcanvas/splat-transform', version: '3.10.2', commit: 'e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8',
});
export const CURRENT_OVERLAY_DIRECTORY = 'webp-overlay-3.10.2';
export const DERIVED_MODULE_SOURCE = '../node_modules/@playcanvas/splat-transform/dist/index.mjs';
export const HISTORICAL_WEBP = Object.freeze({
  supersplat_commit: '18eccb9742bfbbf728c67f332d6d8215ed556755',
  splat_transform_version: '3.4.2', splat_transform_commit: '0cb47cd81023cca117c20ce59a55ba584ee89177',
  wasm_sha256: 'e2c337e1afacf5c9e35f21916b5615fc6c5623074c6e110c07791bd0af071501',
});

export function verifyCurrentVendoredIdentity(index) {
  const current = index?.current_supersplat;
  assert.equal(current?.overlay_directory, CURRENT_OVERLAY_DIRECTORY, 'Current vendored overlay differs.');
  for (const [key, value] of Object.entries(CURRENT_SUPERSPLAT)) assert.equal(current?.upstream?.[key], value, `Unexpected current SuperSplat ${key}.`);
  for (const [key, value] of Object.entries(CURRENT_TRANSFORM)) assert.equal(current?.transform?.[key], value, `Unexpected current splat-transform ${key}.`);
  for (const [key, value] of Object.entries(HISTORICAL_WEBP)) assert.equal(index?.webp?.[key], value, 'Historical prebuilt WebP identity was rewritten.');
}

export function verifyCurrentSupersplatPins(upstream, base) {
  for (const [key, value] of Object.entries(CURRENT_SUPERSPLAT)) assert.equal(upstream?.[key], value, `Unexpected current SuperSplat ${key}.`);
  for (const [key, value] of Object.entries(CURRENT_TRANSFORM)) assert.equal(base?.[key], value, `Unexpected current splat-transform ${key}.`);
  assert.match(base.package_json_sha256, /^[a-f0-9]{64}$/, 'Missing exact transform publication identity.');
}

export function verifyTransformPackage(bytes, base) {
  const pkg = JSON.parse(bytes.toString('utf8'));
  assert.equal(pkg.name, CURRENT_TRANSFORM.name, 'Transform package name differs.');
  assert.equal(pkg.version, CURRENT_TRANSFORM.version, 'Transform package version differs.');
  assert.equal(sha256(bytes), base.package_json_sha256, 'Transform package publication differs.');
  return pkg;
}

export function bundledSupersplatPackages(map, moduleBytes) {
  assert(Array.isArray(map?.sources) && Array.isArray(map.sourcesContent)
    && map.sources.length === map.sourcesContent.length, 'Incomplete SuperSplat source map.');
  const matches = map.sources.flatMap((name, index) => name === DERIVED_MODULE_SOURCE ? [index] : []);
  assert.equal(matches.length, 1, 'Derived transform must occur exactly once in the source map.');
  assert.equal(typeof map.sourcesContent[matches[0]], 'string', 'Missing derived transform source.');
  assert(Buffer.from(map.sourcesContent[matches[0]]).equals(moduleBytes), 'Bundled transform differs from the reviewed derivative.');
  const roots = new Set();
  for (const source of map.sources) {
    assert.equal(typeof source, 'string', 'Malformed source-map path.');
    const match = source.match(/^(?:\.\.\/)+(node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)\//);
    if (!match) continue;
    assert(match[1].split('/').every(part => !['.', '..'].includes(part)), 'Unsafe bundled package path.');
    roots.add(match[1]);
  }
  assert(roots.has('node_modules/@playcanvas/splat-transform'), 'Bundled transform package is absent.');
  return [...roots].sort();
}

/** Current build only. Historical 3.4.2 evidence stays in its original profile. */
export async function currentSupersplatEvidenceInputs(root) {
  const integration = join(root, 'integrations/supersplat');
  const source = join(root, 'target/supersplat-source/upstream');
  const publicRoot = join(root, 'apps/desktop/public/supersplat');
  const overlayRoot = join(integration, CURRENT_OVERLAY_DIRECTORY);
  const { loadWebpOverlay, verifyWebpOverlayInstalled } = await import('../../integrations/supersplat/webp-overlay-3.10.2/overlay.mjs');
  const overlay = await loadWebpOverlay(overlayRoot);
  const upstream = JSON.parse(await readFile(join(integration, 'upstream.json'), 'utf8'));
  verifyCurrentSupersplatPins(upstream, overlay.manifest.base);
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, upstream.commit, 'SuperSplat checkout differs from the current source pin.');
  const sourcePackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.version, upstream.version, 'SuperSplat package version differs from its source pin.');
  const webpEvidence = await verifyWebpBuildEvidence(overlayRoot, overlay);
  const transformPackage = join(source, 'node_modules/@playcanvas/splat-transform');
  verifyTransformPackage(await readFile(join(transformPackage, 'package.json')), overlay.manifest.base);
  await verifyWebpOverlayInstalled(transformPackage, overlay);
  const signature = await preparationSignature(integration, upstream, await readFile(join(integration, 'metorigin-bridge.ts'), 'utf8'), overlay);
  const built = await verifyPreparedAssets(publicRoot, signature, overlay);
  for (const key of Object.keys(CURRENT_SUPERSPLAT)) assert.equal(built[key], upstream[key], `Prepared SuperSplat ${key} differs.`);
  const mapBytes = await readFile(join(publicRoot, 'index.js.map'));
  const bundledPackages = bundledSupersplatPackages(JSON.parse(mapBytes), overlay.files.get('dist/index.mjs'));
  const splatRef = `pkg:npm/${overlay.manifest.base.name.replace('@', '%40')}@${overlay.manifest.base.version}`;
  const sourceMapEvidence = { source_map_sha256: sha256(mapBytes), upstream, packages: bundledPackages,
    webp_overlay: overlayIdentity(overlay), derived_module: { source: DERIVED_MODULE_SOURCE,
      sha256: sha256(overlay.files.get('dist/index.mjs')), base: overlay.manifest.base } };
  return { integration, source, publicRoot, overlayRoot, overlay, upstream, sourcePackage, webpEvidence,
    signature, built, bundledPackages, splatRef, sourceMapEvidence };
}

async function physicalEvidence(root, name) {
  const rootInfo = await lstat(root);
  assert(!rootInfo.isSymbolicLink() && rootInfo.isDirectory(), 'Nonphysical collected editor evidence root.');
  assert(typeof name === 'string' && name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)), 'Unsafe collected editor evidence path.');
  let path = root;
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await lstat(path);
    assert(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() && info.size <= 16 * 1024 * 1024 : info.isDirectory()), 'Nonphysical collected editor evidence.');
  }
  return readFile(path);
}

/** Verify a collected current proof without rebuilding or trusting its verifier. */
export async function verifyCollectedSupersplatEvidence(root, licenses, bom, licenseIndex, readiness) {
  const { loadWebpOverlay } = await import('../../integrations/supersplat/webp-overlay-3.10.2/overlay.mjs');
  const overlay = await loadWebpOverlay(join(root, 'integrations/supersplat', CURRENT_OVERLAY_DIRECTORY));
  const read = name => physicalEvidence(licenses, name);
  const json = async name => JSON.parse(await read(name));
  assert.equal(sha256(await read('vendored/webp/manifest.json')), overlay.digest, 'Collected overlay differs from the reviewed current profile.');
  assert((await read('vendored/webp/build-evidence.json')).equals(overlay.evidenceBytes), 'Collected build evidence differs from the reviewed current profile.');
  const proof = await verifyWebpBuildEvidence(join(licenses, 'vendored/webp'), overlay);
  const identity = overlayIdentity(overlay);
  const normalized = await json('vendored/webp/evidence.json');
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.status, 'verified-derived-replacement');
  assert.deepEqual(normalized.base, overlay.manifest.base);
  assert.deepEqual(normalized.overlay, identity);
  assert.deepEqual(normalized.historical_prebuilt, { wasm_sha256: HISTORICAL_WEBP.wasm_sha256, status: 'provenance-unresolved' });
  assert.deepEqual(normalized.runtime, { linked_members: proof.linked_members, sources: proof.sources });
  const keyed = rows => {
    assert(Array.isArray(rows), 'Missing collected editor inventory.');
    const result = new Map(rows.map(row => [row.path, row]));
    assert.equal(result.size, rows.length, 'Duplicate collected editor evidence.');
    return result;
  };
  const copied = keyed(normalized.files);
  assert.equal(copied.size, proof.files.length, 'Collected editor proof is incomplete.');
  for (const record of proof.files) {
    const name = `vendored/webp/${record.path}`;
    assert.deepEqual(copied.get(name), { ...record, path: name }, 'Collected editor proof reference differs.');
  }
  const componentIndex = new Map(bom.components.map(item => [item['bom-ref'], item]));
  const splatRef = `pkg:npm/${CURRENT_TRANSFORM.name.replace('@', '%40')}@${CURRENT_TRANSFORM.version}`;
  const derived = componentIndex.get(splatRef);
  assert.equal(derived?.name, CURRENT_TRANSFORM.name, 'Current derived component missing.');
  assert.equal(derived?.version, CURRENT_TRANSFORM.version, 'Current derived component mislabeled.');
  const props = Object.fromEntries((derived.properties ?? []).map(item => [item.name, item.value]));
  assert.equal(props['metorigin:distribution-kind'], 'derived-fixed-webp-overlay');
  assert.equal(props['metorigin:webp-overlay-id'], identity.id);
  assert.equal(props['metorigin:webp-overlay-manifest-sha256'], identity.manifest_sha256);
  const owners = { 'splat-transform': splatRef, libwebp: 'pkg:generic/libwebp@1.6.0', sharpyuv: 'pkg:generic/sharpyuv@0.4.2',
    'emscripten-runtime': 'pkg:generic/emscripten-runtime@4.0.21',
    ...Object.fromEntries(['musl', 'dlmalloc', 'compiler-rt'].map(name => [name, `pkg:generic/${name}@emscripten-d6f4231`])) };
  for (const [name, ref] of Object.entries(owners)) {
    assert.equal(componentIndex.get(ref)?.name, name === 'splat-transform' ? CURRENT_TRANSFORM.name : name, 'Collected runtime component mislabeled.');
    assert.equal(componentIndex.get(ref)?.version, ref.slice(ref.lastIndexOf('@') + 1), 'Collected runtime version mislabeled.');
  }
  const wasm = overlay.manifest.files.find(file => file.path === 'lib/webp.wasm');
  assert(componentIndex.get(`webp-wasm:sha256:${wasm.sha256}`)?.hashes?.some(item => item.alg === 'SHA-256' && item.content === wasm.sha256), 'Collected WASM component binding missing.');
  const notices = keyed(normalized.notices);
  assert.equal(notices.size, proof.notices.length, 'Collected editor notices incomplete.');
  for (const { bytes: _bytes, component, ...record } of proof.notices) {
    const expected = { ...record, path: `vendored/webp/${record.path}`, component: owners[component], runtime_component: component };
    assert(componentIndex.has(expected.component), 'Collected editor notice has no component.');
    assert.deepEqual(notices.get(expected.path), expected, 'Collected editor notice ownership differs.');
    assert(licenseIndex.some(item => item.component === expected.component && item.path === expected.path && item.sha256 === expected.sha256 && item.size_bytes === expected.size_bytes), 'Collected editor notice absent from license index.');
    if (component === 'libwebp') assert(licenseIndex.some(item => item.component === owners.sharpyuv && item.path === expected.path && item.sha256 === expected.sha256), 'Shared sharpyuv notice absent.');
  }
  const built = await json('supersplat/build.json');
  verifyCurrentSupersplatPins(built, overlay.manifest.base);
  assert.deepEqual(built.webp_overlay, identity);
  assert.match(built.signature, /^[a-f0-9]{64}$/);
  const assets = keyed(built.assets);
  const statics = keyed(await json('supersplat/static-payload-inventory.json'));
  for (const name of ['webp.wasm', 'webp.mjs']) {
    const path = `static/lib/webp/${name}`;
    if (name === 'webp.mjs' && !assets.has(path) && !statics.has(path)) continue;
    const output = overlay.manifest.files.find(file => file.path === `lib/${name}`);
    for (const record of [assets.get(path), statics.get(path)]) {
      assert(record && record.sha256 === output.sha256 && record.size_bytes === output.size_bytes, 'Collected frontend codec is not the paired output.');
    }
  }
  const map = await json('supersplat/source-map-package-evidence.json');
  assert.deepEqual(map.upstream, CURRENT_SUPERSPLAT);
  assert.deepEqual(map.webp_overlay, identity);
  assert.equal(map.source_map_sha256, assets.get('index.js.map')?.sha256);
  assert.deepEqual(map.derived_module, { source: DERIVED_MODULE_SOURCE, sha256: sha256(overlay.files.get('dist/index.mjs')), base: overlay.manifest.base });
  assert(map.packages.includes('node_modules/@playcanvas/splat-transform'), 'Collected source map omits the derivative.');
  verifyCurrentVendoredIdentity(await json('build-inputs/app-vendored-evidence.json'));
  const resolutions = readiness.resolved_findings?.filter(item => item.id === 'supersplat-webp-provenance') ?? [];
  assert.equal(resolutions.length, 1, 'Current editor has no unique provenance resolution.');
  assert.equal(resolutions[0].evidence, 'vendored/webp/evidence.json');
  assert.equal(resolutions[0].resolution, 'replaced-with-fixed-source-build');
  return { profile: overlay.manifest.id, evidence_file_count: proof.files.length, notice_count: proof.notices.length };
}
