import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { applyWebpOverlay, loadWebpOverlay, verifyWebpOverlayInstalled } from './webp-overlay.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['lib/webp.mjs', 'lib/webp.wasm', 'dist/index.mjs', 'dist/index.mjs.map',
  'dist/index.cjs', 'dist/index.cjs.map', 'dist/worker.mjs', 'dist/worker.mjs.map',
  'dist/cli.mjs', 'dist/cli.mjs.map'];
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'metorigin-webp-overlay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'overlay'), packageDirectory = join(root, 'package');
  const packageBytes = Buffer.from(JSON.stringify({ name: '@playcanvas/splat-transform', version: '3.4.2' }) + '\n');
  const evidenceBytes = Buffer.from(JSON.stringify({ kind: 'test-only-build-receipt' }) + '\n');
  await put(join(packageDirectory, 'package.json'), packageBytes);
  await put(join(directory, 'build-evidence.json'), evidenceBytes);
  const manifest = { schema_version: 1, id: 'test-webp-build', base: {
    name: '@playcanvas/splat-transform', version: '3.4.2', commit: 'a'.repeat(40), package_json_sha256: hash(packageBytes),
  }, build_evidence_sha256: hash(evidenceBytes), files: [] };
  const originals = new Map();
  for (const path of required) {
    const before = Buffer.from(`npm original ${path}\n`), after = Buffer.from(`derived ${path}\n`);
    const compressed = gzipSync(after), payload = `payloads/${path}.gz`;
    await put(join(packageDirectory, path), before); originals.set(path, before);
    await put(join(directory, payload), compressed);
    manifest.files.push({ path, payload, compressed_sha256: hash(compressed), sha256: hash(after), size_bytes: after.length, base_sha256: hash(before) });
  }
  const save = () => put(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await save();
  return { root, directory, packageDirectory, manifest, originals, save };
}

async function assertOriginals(f) {
  for (const [path, bytes] of f.originals) assert.deepEqual(await readFile(join(f.packageDirectory, path)), bytes);
}

test('loads, applies, verifies, is idempotent, and reapplies after npm restores original bytes', async t => {
  const f = await fixture(t);
  const overlay = await loadWebpOverlay(f.directory);
  assert(overlay.files instanceof Map);
  assert.equal(overlay.digest, hash(await readFile(join(f.directory, 'manifest.json'))));
  assert.equal(hash(overlay.evidenceBytes), f.manifest.build_evidence_sha256);
  assert.deepEqual(overlay.evidence, { kind: 'test-only-build-receipt' });
  await assert.rejects(verifyWebpOverlayInstalled(f.packageDirectory, overlay), /installed output mismatch/);
  const identity = await applyWebpOverlay(f.packageDirectory, overlay);
  assert.deepEqual(identity, { id: f.manifest.id, manifest_sha256: overlay.digest, build_evidence_sha256: f.manifest.build_evidence_sha256 });
  assert.deepEqual(await verifyWebpOverlayInstalled(f.packageDirectory, overlay), identity);
  assert.deepEqual(await applyWebpOverlay(f.packageDirectory, overlay), identity);
  for (const [path, bytes] of f.originals) await put(join(f.packageDirectory, path), bytes);
  await applyWebpOverlay(f.packageDirectory, overlay);
  await verifyWebpOverlayInstalled(f.packageDirectory, overlay);
});

test('rejects a mismatched wasm before changing any earlier target', async t => {
  const f = await fixture(t);
  const overlay = await loadWebpOverlay(f.directory);
  const wrong = Buffer.from('other wasm build');
  await put(join(f.packageDirectory, 'lib/webp.wasm'), wrong);
  await assert.rejects(applyWebpOverlay(f.packageDirectory, overlay), /unexpected installed content: lib\/webp.wasm/);
  assert.deepEqual(await readFile(join(f.packageDirectory, 'lib/webp.mjs')), f.originals.get('lib/webp.mjs'));
  assert.deepEqual(await readFile(join(f.packageDirectory, 'dist/index.mjs')), f.originals.get('dist/index.mjs'));
  assert.deepEqual(await readFile(join(f.packageDirectory, 'lib/webp.wasm')), wrong);
});

test('rejects late target tampering without partially applying earlier files', async t => {
  const f = await fixture(t);
  const overlay = await loadWebpOverlay(f.directory);
  await put(join(f.packageDirectory, 'dist/index.mjs'), 'unexpected dist');
  await assert.rejects(applyWebpOverlay(f.packageDirectory, overlay), /unexpected installed content/);
  for (const path of required.slice(0, 2)) assert.deepEqual(await readFile(join(f.packageDirectory, path)), f.originals.get(path));
});

test('only permits missing targets when base_sha256 is null', async t => {
  const f = await fixture(t);
  const added = f.manifest.files.at(-1); added.base_sha256 = null;
  await rm(join(f.packageDirectory, added.path)); await f.save();
  const overlay = await loadWebpOverlay(f.directory);
  await applyWebpOverlay(f.packageDirectory, overlay); await verifyWebpOverlayInstalled(f.packageDirectory, overlay);
  await rm(join(f.packageDirectory, 'lib/webp.wasm'));
  await assert.rejects(applyWebpOverlay(f.packageDirectory, overlay), /unexpected installed content/);
});

test('checks exact package.json bytes as well as name and version', async t => {
  const f = await fixture(t), overlay = await loadWebpOverlay(f.directory);
  await put(join(f.packageDirectory, 'package.json'), JSON.stringify({ name: '@playcanvas/splat-transform', version: '3.4.2' }));
  await assert.rejects(applyWebpOverlay(f.packageDirectory, overlay), /package.json identity mismatch/);
  await assertOriginals(f);
  const wrong = Buffer.from(JSON.stringify({ name: 'wrong-package', version: '3.4.2' }));
  await put(join(f.packageDirectory, 'package.json'), wrong);
  f.manifest.base.package_json_sha256 = hash(wrong); await f.save();
  await assert.rejects(applyWebpOverlay(f.packageDirectory, await loadWebpOverlay(f.directory)), /package.json identity mismatch/);
});

test('rejects traversal, Windows paths, duplicate paths/payloads and unsupported outputs', async t => {
  for (const mutation of [
    m => { m.files[0].payload = '../escape.gz'; },
    m => { m.files[0].payload = 'C:\\escape.gz'; },
    m => { m.files[0].payload = '/escape.gz'; },
    m => { m.files[0].payload = 'payloads//file.gz'; },
    m => { m.files[0].payload = 'CON/file.gz'; },
    m => { m.files[1].path = m.files[0].path; },
    m => { m.files[1].payload = m.files[0].payload; },
    m => { m.files[0].path = 'package.json'; },
  ]) {
    const f = await fixture(t); mutation(f.manifest); await f.save();
    await assert.rejects(loadWebpOverlay(f.directory), /WebP overlay:/);
    await assertOriginals(f);
  }
});

test('requires all ten companion files, including worker, CLI, CJS and every source map', async t => {
  for (const path of required) {
    const f = await fixture(t); f.manifest.files = f.manifest.files.filter(file => file.path !== path); await f.save();
    await assert.rejects(loadWebpOverlay(f.directory), /invalid file set/);
  }
});

test('rejects missing, modified compressed, wrong expanded hash and wrong size payloads', async t => {
  for (const kind of ['missing', 'compressed', 'hash', 'size', 'gzip']) {
    const f = await fixture(t), file = f.manifest.files[0];
    if (kind === 'missing') await rm(join(f.directory, file.payload));
    if (kind === 'compressed') await put(join(f.directory, file.payload), Buffer.from('modified compressed bytes'));
    if (kind === 'hash') file.sha256 = '0'.repeat(64);
    if (kind === 'size') file.size_bytes += 1;
    if (kind === 'gzip') { const bytes = Buffer.from('not gzip'); await put(join(f.directory, file.payload), bytes); file.compressed_sha256 = hash(bytes); }
    await f.save(); await assert.rejects(loadWebpOverlay(f.directory)); await assertOriginals(f);
  }
});

test('rejects decompression beyond declared bounds and excessive declared sizes', async t => {
  const f = await fixture(t), file = f.manifest.files[0];
  const inflated = Buffer.alloc(1024 * 1024, 65), compressed = gzipSync(inflated);
  await put(join(f.directory, file.payload), compressed); file.compressed_sha256 = hash(compressed); file.sha256 = hash(inflated); file.size_bytes = 16;
  await f.save(); await assert.rejects(loadWebpOverlay(f.directory), /expanded size limit/);
  file.size_bytes = 32 * 1024 * 1024 + 1; await f.save();
  await assert.rejects(loadWebpOverlay(f.directory), /invalid file identity or size/);
  for (const item of f.manifest.files) item.size_bytes = 10 * 1024 * 1024;
  await f.save(); await assert.rejects(loadWebpOverlay(f.directory), /total payload exceeds/);
});

test('requires byte-bound, valid JSON build evidence', async t => {
  for (const kind of ['missing', 'changed', 'invalid-json']) {
    const f = await fixture(t), path = join(f.directory, 'build-evidence.json');
    if (kind === 'missing') await rm(path);
    else { const bytes = Buffer.from(kind === 'changed' ? '{}' : '{'); await put(path, bytes);
      if (kind === 'invalid-json') { f.manifest.build_evidence_sha256 = hash(bytes); await f.save(); } }
    await assert.rejects(loadWebpOverlay(f.directory));
  }
});

test('rejects root, metadata, payload and installed-target symlinks', async t => {
  for (const kind of ['root', 'manifest', 'evidence', 'payload', 'payload-parent', 'package', 'package-json', 'target', 'target-parent']) {
    const f = await fixture(t);
    let overlay;
    if (kind.startsWith('package') || kind.startsWith('target')) overlay = await loadWebpOverlay(f.directory);
    const original = kind === 'root' ? f.directory : kind === 'manifest' ? join(f.directory, 'manifest.json')
      : kind === 'evidence' ? join(f.directory, 'build-evidence.json') : kind === 'payload' ? join(f.directory, f.manifest.files[0].payload)
        : kind === 'payload-parent' ? join(f.directory, 'payloads') : kind === 'package' ? f.packageDirectory
          : kind === 'package-json' ? join(f.packageDirectory, 'package.json') : kind === 'target' ? join(f.packageDirectory, 'lib/webp.wasm') : join(f.packageDirectory, 'lib');
    const link = join(f.root, `link-${kind}`);
    const directoryLink = ['root', 'payload-parent', 'package', 'target-parent'].includes(kind);
    if (kind === 'root' || kind === 'package') {
      await symlink(original, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(kind === 'root' ? loadWebpOverlay(link) : applyWebpOverlay(link, overlay), /physical directory/);
    } else {
      const { rename } = await import('node:fs/promises'); await rename(original, link);
      await symlink(link, original, directoryLink ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      await assert.rejects(overlay ? applyWebpOverlay(f.packageDirectory, overlay) : loadWebpOverlay(f.directory), /symlink/);
    }
  }
});

test('detects mutations of returned payload buffers before applying', async t => {
  const f = await fixture(t), overlay = await loadWebpOverlay(f.directory);
  overlay.files.get('lib/webp.wasm')[0] ^= 1;
  await assert.rejects(applyWebpOverlay(f.packageDirectory, overlay), /loaded payload changed/);
  await assertOriginals(f);
});
