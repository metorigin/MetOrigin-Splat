import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bundledSupersplatPackages, CURRENT_OVERLAY_DIRECTORY, CURRENT_SUPERSPLAT, CURRENT_TRANSFORM, DERIVED_MODULE_SOURCE,
  HISTORICAL_WEBP, verifyCollectedSupersplatEvidence, verifyCurrentSupersplatPins, verifyCurrentVendoredIdentity, verifyTransformPackage } from './supersplat-evidence.mjs';
import { overlayIdentity } from '../../integrations/supersplat/prepared-assets.mjs';
import { verifyWebpBuildEvidence } from '../../integrations/supersplat/webp-evidence.mjs';

const publication = Buffer.from(JSON.stringify({ name: CURRENT_TRANSFORM.name, version: CURRENT_TRANSFORM.version }));
const base = { ...CURRENT_TRANSFORM, package_json_sha256: createHash('sha256').update(publication).digest('hex') };

test('current source and derivative identities cannot select an unreviewed or historical profile', () => {
  verifyCurrentSupersplatPins(CURRENT_SUPERSPLAT, base);
  for (const key of ['repository', 'version', 'commit']) {
    assert.throws(() => verifyCurrentSupersplatPins({ ...CURRENT_SUPERSPLAT, [key]: 'unreviewed' }, base), /Unexpected current SuperSplat/);
  }
  for (const key of ['name', 'version', 'commit']) {
    assert.throws(() => verifyCurrentSupersplatPins(CURRENT_SUPERSPLAT, { ...base, [key]: 'unreviewed' }), /Unexpected current splat-transform/);
  }
});

test('installed transform publication must match the exact reviewed package bytes', () => {
  assert.equal(verifyTransformPackage(publication, base).version, '3.10.2');
  assert.throws(() => verifyTransformPackage(Buffer.concat([publication, Buffer.from('\n')]), base), /publication differs/);
  assert.throws(() => verifyTransformPackage(Buffer.from(JSON.stringify({ name: base.name, version: '3.4.2' })), base), /version differs/);
});

test('current vendored binding cannot relabel or replace the historical prebuilt audit', () => {
  const index = { current_supersplat: { upstream: CURRENT_SUPERSPLAT, transform: CURRENT_TRANSFORM, overlay_directory: CURRENT_OVERLAY_DIRECTORY }, webp: HISTORICAL_WEBP };
  verifyCurrentVendoredIdentity(index);
  assert.throws(() => verifyCurrentVendoredIdentity({ ...index, current_supersplat: undefined }), /vendored overlay differs/);
  assert.throws(() => verifyCurrentVendoredIdentity({ ...index, webp: { ...HISTORICAL_WEBP, supersplat_commit: CURRENT_SUPERSPLAT.commit } }), /Historical prebuilt/);
  assert.throws(() => verifyCurrentVendoredIdentity({ ...index, current_supersplat: { ...index.current_supersplat, transform: { ...CURRENT_TRANSFORM, version: '3.4.2' } } }), /Unexpected current/);
});

test('source-map roots identify the actual paired derivative and reject replacement or duplicate modules', () => {
  const bytes = Buffer.from('reviewed derivative');
  const map = { sources: [DERIVED_MODULE_SOURCE, '../node_modules/playcanvas/build/playcanvas.mjs', '../src/main.ts'],
    sourcesContent: [bytes.toString(), 'engine', 'app'] };
  assert.deepEqual(bundledSupersplatPackages(map, bytes), ['node_modules/@playcanvas/splat-transform', 'node_modules/playcanvas']);
  assert.throws(() => bundledSupersplatPackages({ ...map, sourcesContent: ['replacement', 'engine', 'app'] }, bytes), /differs from the reviewed derivative/);
  assert.throws(() => bundledSupersplatPackages({ sources: [DERIVED_MODULE_SOURCE, DERIVED_MODULE_SOURCE], sourcesContent: [bytes.toString(), bytes.toString()] }, bytes), /exactly once/);
  assert.throws(() => bundledSupersplatPackages({ sources: ['../src/main.ts'], sourcesContent: ['app'] }, bytes), /exactly once/);
  assert.throws(() => bundledSupersplatPackages({ sources: [DERIVED_MODULE_SOURCE, '../node_modules/../outside.ts'], sourcesContent: [bytes.toString(), 'outside'] }, bytes), /Unsafe bundled package path/);
});

test('collected current editor evidence retains the complete checked closure and ownership', async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = await mkdtemp(join(tmpdir(), 'supersplat-collected-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const overlayRoot = join(root, 'integrations/supersplat', CURRENT_OVERLAY_DIRECTORY);
  const { loadWebpOverlay } = await import('../../integrations/supersplat/webp-overlay-3.10.2/overlay.mjs');
  const overlay = await loadWebpOverlay(overlayRoot);
  const proof = await verifyWebpBuildEvidence(overlayRoot, overlay);
  const identity = overlayIdentity(overlay);
  const write = async (name, value) => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
  };
  const copies = proof.files.map(record => ({ ...record, path: `vendored/webp/${record.path}` }));
  for (const record of [...proof.files, { path: 'manifest.json' }, { path: 'build-evidence.json' }]) {
    const destination = join(directory, 'vendored/webp', record.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(overlayRoot, record.path), destination);
  }
  const splatRef = 'pkg:npm/%40playcanvas/splat-transform@3.10.2';
  const owners = { 'splat-transform': splatRef, libwebp: 'pkg:generic/libwebp@1.6.0', sharpyuv: 'pkg:generic/sharpyuv@0.4.2',
    'emscripten-runtime': 'pkg:generic/emscripten-runtime@4.0.21',
    ...Object.fromEntries(['musl', 'dlmalloc', 'compiler-rt'].map(name => [name, `pkg:generic/${name}@emscripten-d6f4231`])) };
  const notices = proof.notices.map(({ bytes: _bytes, component, ...record }) => ({ ...record,
    path: `vendored/webp/${record.path}`, component: owners[component], runtime_component: component }));
  const licenseIndex = [...notices, ...notices.filter(item => item.runtime_component === 'libwebp').map(item => ({ ...item, component: owners.sharpyuv }))];
  const bom = { components: Object.entries(owners).map(([name, ref]) => ({ name: name === 'splat-transform' ? CURRENT_TRANSFORM.name : name,
    version: ref.split('@').at(-1), 'bom-ref': ref, properties: name === 'splat-transform' ? [
      { name: 'metorigin:distribution-kind', value: 'derived-fixed-webp-overlay' },
      { name: 'metorigin:webp-overlay-id', value: identity.id },
      { name: 'metorigin:webp-overlay-manifest-sha256', value: identity.manifest_sha256 },
    ] : [] })) };
  await write('vendored/webp/evidence.json', { schema_version: 1, status: 'verified-derived-replacement', base: overlay.manifest.base,
    overlay: identity, files: copies, notices, runtime: { linked_members: proof.linked_members, sources: proof.sources },
    historical_prebuilt: { wasm_sha256: HISTORICAL_WEBP.wasm_sha256, status: 'provenance-unresolved' } });
  const wasm = overlay.manifest.files.find(item => item.path === 'lib/webp.wasm');
  bom.components.push({ 'bom-ref': `webp-wasm:sha256:${wasm.sha256}`, name: 'SuperSplat derived WebP WASM', hashes: [{ alg: 'SHA-256', content: wasm.sha256 }] });
  const assets = [{ path: 'static/lib/webp/webp.wasm', sha256: wasm.sha256, size_bytes: wasm.size_bytes }, { path: 'index.js.map', sha256: 'a'.repeat(64), size_bytes: 100 }];
  await write('supersplat/build.json', { ...CURRENT_SUPERSPLAT, signature: 'f'.repeat(64), webp_overlay: identity, assets });
  await write('supersplat/static-payload-inventory.json', [assets[0]]);
  const map = { upstream: CURRENT_SUPERSPLAT, webp_overlay: identity, source_map_sha256: assets[1].sha256,
    packages: ['node_modules/@playcanvas/splat-transform'], derived_module: { source: DERIVED_MODULE_SOURCE,
      sha256: overlay.manifest.files.find(item => item.path === 'dist/index.mjs').sha256, base: overlay.manifest.base } };
  await write('supersplat/source-map-package-evidence.json', map);
  await write('build-inputs/app-vendored-evidence.json', JSON.parse(await readFile(join(root, 'packaging/macos-arm64/licenses/app-vendored-evidence.json'))));
  const readiness = { resolved_findings: [{ id: 'supersplat-webp-provenance', evidence: 'vendored/webp/evidence.json', resolution: 'replaced-with-fixed-source-build' }] };
  const verify = index => verifyCollectedSupersplatEvidence(root, directory, bom, index ?? licenseIndex, readiness);
  await t.test('accepts the actual copied current source closure', async () => assert.equal((await verify()).evidence_file_count, 87));
  await t.test('rejects a substituted source-map derivative', async () => {
    await write('supersplat/source-map-package-evidence.json', { ...map, derived_module: { ...map.derived_module, sha256: 'b'.repeat(64) } });
    await assert.rejects(verify(), /deep-equal/);
    await write('supersplat/source-map-package-evidence.json', map);
  });
  await t.test('rejects omitted runtime notice ownership', async () => assert.rejects(verify(licenseIndex.filter(item => item.component !== splatRef)), /notice absent/));
  await t.test('rejects a collected evidence root symlink', async () => {
    const link = `${directory}-link`;
    await symlink(directory, link, 'dir');
    t.after(() => rm(link, { force: true }));
    await assert.rejects(verifyCollectedSupersplatEvidence(root, link, bom, licenseIndex, readiness), /Nonphysical/);
  });
  await t.test('rejects a copied proof symlink even when it points to identical bytes', async () => {
    const selected = proof.files[0];
    const path = join(directory, 'vendored/webp', selected.path);
    await rm(path);
    await symlink(join(overlayRoot, selected.path), path);
    await assert.rejects(verify(), /Nonphysical/);
  });
});
