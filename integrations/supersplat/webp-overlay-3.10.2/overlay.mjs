// New 3.10.2 profile. The legacy 3.4.2 loader and payloads remain unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const REQUIRED = ['lib/webp.mjs', 'lib/webp.wasm', 'dist/index.mjs', 'dist/index.mjs.map',
  'dist/index.cjs', 'dist/index.cjs.map', 'dist/worker.mjs', 'dist/worker.mjs.map',
  'dist/cli.mjs', 'dist/cli.mjs.map'];
const ALLOWED = new Set(REQUIRED);
const loadedOverlays = new WeakSet();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`WebP overlay: ${message}`); };
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function keys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(`invalid ${label} fields`);
}

function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240) fail('invalid relative path');
  const parts = value.split('/');
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..'
    || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail(`unsafe relative path: ${value}`);
  }
  return parts;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function physicalDirectory(directory) {
  const path = resolve(directory);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`not a physical directory: ${path}`);
  return realpath(path);
}

// Only traverse physical directories beneath the caller-selected root.
async function filePath(root, relative, allowMissing = false) {
  const parts = portablePath(relative);
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    let info;
    try { info = await lstat(path); } catch (error) {
      if (allowMissing && i === parts.length - 1 && error.code === 'ENOENT') return { path, info: null };
      throw error;
    }
    if (info.isSymbolicLink()) fail(`symlink is not allowed: ${relative}`);
    if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail(`not a regular file path: ${relative}`);
    if (i === parts.length - 1) return { path, info };
  }
}

async function readFileBounded(root, relative, limit, allowMissing = false) {
  const target = await filePath(root, relative, allowMissing);
  if (!target.info) return { ...target, bytes: null };
  const handle = await open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) fail(`file exceeds size limit or is not regular: ${relative}`);
    const chunks = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - length + 1));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) fail(`file exceeds size limit: ${relative}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { ...target, bytes: Buffer.concat(chunks, length) };
  } finally { await handle.close(); }
}

function validateManifest(manifest) {
  keys(manifest, ['schema_version', 'id', 'base', 'build_evidence_sha256', 'files'], 'manifest');
  if (manifest.schema_version !== 1 || typeof manifest.id !== 'string' || !manifest.id.trim()
    || manifest.id.length > 160 || /[\x00-\x1f\x7f]/.test(manifest.id)
    || !isDigest(manifest.build_evidence_sha256)) fail('invalid manifest identity');
  keys(manifest.base, ['name', 'version', 'commit', 'package_json_sha256'], 'base');
  if (manifest.base.name !== '@playcanvas/splat-transform' || manifest.base.version !== '3.10.2'
    || manifest.base.commit !== 'e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8'
    || manifest.base.package_json_sha256 !== 'c65ef9c4e9e84512638391a9b7ca2a2c064dc8a291f80073039174b01e87e1aa') fail('invalid base identity');
  if (!Array.isArray(manifest.files) || manifest.files.length !== REQUIRED.length) fail('invalid file set: expected exactly ten companion payloads');
  const paths = new Set(), payloads = new Set();
  let total = 0;
  for (const file of manifest.files) {
    keys(file, ['path', 'payload', 'compressed_sha256', 'sha256', 'size_bytes', 'base_sha256'], 'file');
    portablePath(file.path); portablePath(file.payload);
    if (!ALLOWED.has(file.path) || !file.payload.endsWith('.gz')) fail(`unsupported file: ${file.path}`);
    if (paths.has(file.path.toLowerCase()) || payloads.has(file.payload.toLowerCase())) fail('duplicate path or payload');
    paths.add(file.path.toLowerCase()); payloads.add(file.payload.toLowerCase());
    if (!isDigest(file.compressed_sha256) || !isDigest(file.sha256)
      || (file.base_sha256 !== null && !isDigest(file.base_sha256))
      || !Number.isSafeInteger(file.size_bytes) || file.size_bytes <= 0 || file.size_bytes > MAX_FILE_BYTES) fail(`invalid file identity or size: ${file.path}`);
    total += file.size_bytes;
  }
  if (total > MAX_TOTAL_BYTES) fail('total payload exceeds size limit');
  if (REQUIRED.some(path => !paths.has(path))) fail('missing companion payload');
}

function checkedOverlay(overlay) {
  if (!loadedOverlays.has(overlay)) fail('use an overlay returned by loadWebpOverlay');
  if (overlay.files.size !== overlay.manifest.files.length) fail('loaded payload set changed');
  for (const file of overlay.manifest.files) {
    const bytes = overlay.files.get(file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.size_bytes || hash(bytes) !== file.sha256) fail(`loaded payload changed: ${file.path}`);
  }
  if (hash(overlay.evidenceBytes) !== overlay.manifest.build_evidence_sha256) fail('loaded build evidence changed');
  return overlay;
}

function identity(overlay) {
  return { id: overlay.manifest.id, manifest_sha256: overlay.digest,
    build_evidence_sha256: overlay.manifest.build_evidence_sha256 };
}

/** Validate a fixed overlay without a compiler or SDK. files is Map<path, Buffer>.
 * build-evidence.json is byte-bound and parsed; its provenance semantics belong
 * to the collector/verifier. Limits: 32 MiB/file, 96 MiB total, 4 MiB evidence.
 */
export async function loadWebpOverlay(directory) {
  const root = await physicalDirectory(directory);
  const { bytes: manifestBytes } = await readFileBounded(root, 'manifest.json', MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(manifest);
  const { bytes: evidenceBytes } = await readFileBounded(root, 'build-evidence.json', MAX_EVIDENCE_BYTES);
  if (hash(evidenceBytes) !== manifest.build_evidence_sha256) fail('build evidence hash mismatch');
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const files = new Map();
  for (const file of manifest.files) {
    const { bytes: compressed } = await readFileBounded(root, file.payload, MAX_FILE_BYTES);
    if (hash(compressed) !== file.compressed_sha256) fail(`compressed payload hash mismatch: ${file.path}`);
    let bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: file.size_bytes }); }
    catch (error) { fail(`invalid gzip or expanded size limit: ${file.path}: ${error.message}`); }
    if (bytes.length !== file.size_bytes || hash(bytes) !== file.sha256) fail(`expanded payload hash/size mismatch: ${file.path}`);
    files.set(file.path, bytes);
  }
  const overlay = Object.freeze({ manifest: freeze(manifest), digest: hash(manifestBytes), files,
    evidenceBytes, evidence: freeze(evidence) });
  loadedOverlays.add(overlay);
  return overlay;
}

async function checkedPackage(packageDirectory, overlay) {
  checkedOverlay(overlay);
  const root = await physicalDirectory(packageDirectory);
  const { bytes } = await readFileBounded(root, 'package.json', MAX_MANIFEST_BYTES);
  const pkg = JSON.parse(bytes.toString('utf8'));
  const base = overlay.manifest.base;
  if (hash(bytes) !== base.package_json_sha256 || pkg.name !== base.name || pkg.version !== base.version) fail('package.json identity mismatch');
  return root;
}

/** Preflight every target before writing. Existing files must be the pinned npm
 * base or this overlay's output. A write/OS failure is not a transactional rollback;
 * a subsequent call can safely finish a mixture of accepted base/output files.
 */
export async function applyWebpOverlay(packageDirectory, overlay) {
  const root = await checkedPackage(packageDirectory, overlay);
  const changes = [];
  for (const file of overlay.manifest.files) {
    const target = await readFileBounded(root, file.path, MAX_FILE_BYTES, true);
    const current = target.bytes === null ? null : hash(target.bytes);
    if (current !== file.base_sha256 && current !== file.sha256) fail(`unexpected installed content: ${file.path}`);
    if (current !== file.sha256) changes.push({ file, target });
  }
  for (const { file, target } of changes) {
    // Replace the directory entry instead of truncating an existing hard link.
    await filePath(root, file.path, true);
    const temporary = join(dirname(target.path), `.webp-overlay-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, overlay.files.get(file.path), { flag: 'wx', mode: target.info ? target.info.mode & 0o777 : 0o644 });
      await rename(temporary, target.path);
    } finally { await rm(temporary, { force: true }); }
  }
  return identity(overlay);
}

export async function verifyWebpOverlayInstalled(packageDirectory, overlay) {
  const root = await checkedPackage(packageDirectory, overlay);
  for (const file of overlay.manifest.files) {
    const { bytes } = await readFileBounded(root, file.path, MAX_FILE_BYTES);
    if (bytes.length !== file.size_bytes || hash(bytes) !== file.sha256) fail(`installed output mismatch: ${file.path}`);
  }
  return identity(overlay);
}
