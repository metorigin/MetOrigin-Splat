import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'design/app-icon/metorigin-splat-icon-v4.png');
const windowsSource = path.join(root, 'design/app-icon/windows/metorigin-splat-shared-v4.png');
const cropReport = path.join(root, 'design/app-icon/windows/metorigin-splat-shared-v4.metadata.json');
const generated = path.join(root, 'target/windows-icon-shared-v4');
const destination = path.join(root, 'apps/desktop/src-tauri/icons/windows');
const manifestPath = path.join(destination, 'manifest.json');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

function icoEntries(bytes) {
  if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error('Expected ICO container');
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, index) => {
    const header = Buffer.from(bytes.subarray(6 + index * 16, 22 + index * 16));
    const offset = header.readUInt32LE(12), length = header.readUInt32LE(8);
    if (offset < 6 + bytes.readUInt16LE(4) * 16 || offset + length > bytes.length) throw new Error('Invalid ICO payload bounds');
    return { header, width: header[0] || 256, height: header[1] || 256,
      payload: bytes.subarray(offset, offset + length), offset };
  });
}

// Preserve the CLI's original payload region verbatim. Only directory entries and
// offsets change; a missing 128 entry uses the CLI's existing 128 PNG unchanged.
function windowIco(original, png128) {
  const entries = icoEntries(original), oldHeaderSize = 6 + entries.length * 16;
  const missing128 = !entries.some((entry) => entry.width === 128 && entry.height === 128);
  const newHeaderSize = oldHeaderSize + (missing128 ? 16 : 0);
  for (const entry of entries) entry.header.writeUInt32LE(entry.offset + newHeaderSize - oldHeaderSize, 12);
  if (missing128) {
    const header = Buffer.alloc(16);
    header[0] = header[1] = 128;
    header.writeUInt16LE(1, 4); header.writeUInt16LE(32, 6);
    header.writeUInt32LE(png128.length, 8);
    header.writeUInt32LE(original.length + newHeaderSize - oldHeaderSize, 12);
    entries.push({ header, width: 128, height: 128, payload: png128 });
  }
  entries.sort((a, b) => (a.width === 256 ? -1 : b.width === 256 ? 1 : a.width - b.width));
  const header = Buffer.alloc(newHeaderSize);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  entries.forEach((entry, index) => entry.header.copy(header, 6 + index * 16));
  const result = Buffer.concat([header, original.subarray(oldHeaderSize), ...(missing128 ? [png128] : [])]);
  const resultEntries = icoEntries(result);
  for (const entry of icoEntries(original)) {
    const after = resultEntries.find((item) => item.width === entry.width && item.height === entry.height);
    if (!after || !after.payload.equals(entry.payload)) throw new Error('ICO conversion changed an original payload');
  }
  return { result, added128FromCliPng: missing128 };
}

// Read-only PNG measurements; this function never transforms image pixels.
function pngMetrics(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Expected PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) throw new Error('Expected noninterlaced RGBA8 PNG');
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const data = inflateSync(Buffer.concat(compressed)), stride = width * 4;
  if (data.length !== (stride + 1) * height) throw new Error('Unexpected PNG scanline length');
  let previous = Buffer.alloc(stride), minX = width, minY = height, maxX = -1, maxY = -1, solid = 0;
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1), filter = data[offset], row = Buffer.from(data.subarray(offset + 1, offset + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = previous[i], c = i >= 4 ? previous[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : NaN;
      if (!Number.isFinite(predictor)) throw new Error('Unsupported PNG filter');
      row[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) if (row[x * 4 + 3] >= 128) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); solid++;
    }
    previous = row;
  }
  return { width, height, alpha_threshold_inclusive: 128,
    solid_bbox: maxX >= 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
    solid_width_fraction: maxX >= 0 ? (maxX - minX + 1) / width : 0,
    solid_height_fraction: maxY >= 0 ? (maxY - minY + 1) / height : 0,
    solid_area_fraction: solid / (width * height) };
}

function prepareSharedMaster(verifyOnly) {
  const args = [path.join(root, 'scripts/windows/prepare_shared_icon_master.py'),
    '--source', source, '--output', windowsSource, '--report', cropReport,
    ...(verifyOnly ? ['--verify'] : [])];
  const result = spawnSync('python', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Shared icon master verification failed: ${result.stderr || result.stdout}`);
}

async function sourceIdentity() {
  const [sourceBytes, windowsBytes, reportBytes, macManifestBytes] = await Promise.all([
    fs.readFile(source), fs.readFile(windowsSource), fs.readFile(cropReport),
    fs.readFile(path.join(root, 'apps/desktop/src-tauri/icons/macos/manifest.json')),
  ]);
  const mac = JSON.parse(macManifestBytes.toString('utf8'));
  const masterHash = sha256(sourceBytes);
  if (mac.inputs[relative(source)] !== masterHash) throw new Error('Windows and Mac must use the same approved icon master');
  const crop = JSON.parse(reportBytes.toString('utf8'));
  if (crop.source.sha256 !== masterHash || crop.output.sha256 !== sha256(windowsBytes)
    || crop.method !== 'exact_rgba_crop' || crop.resampled !== false || crop.rgba_pixels_preserved !== true) {
    throw new Error('Windows icon normalization does not match the shared master');
  }
  return {
    master: { path: relative(source), sha256: masterHash, ...pngMetrics(sourceBytes) },
    mac_manifest_input_matches: true,
    windows_source: { path: relative(windowsSource), sha256: sha256(windowsBytes), ...pngMetrics(windowsBytes) },
    normalization_report: { path: relative(cropReport), sha256: sha256(reportBytes), ...crop },
  };
}

async function verify() {
  prepareSharedMaster(true);
  const identity = await sourceIdentity();
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || JSON.stringify(manifest.source) !== JSON.stringify(identity)) {
    throw new Error('Windows icon outputs do not match their shared-master recipe; regenerate the icons');
  }
  const resourceNames = (await fs.readdir(destination)).filter((name) => /\.(png|ico)$/.test(name)).sort();
  if (JSON.stringify(resourceNames) !== JSON.stringify(Object.keys(manifest.outputs).sort())) throw new Error('Windows icon resource set differs from its manifest');
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    if (sha256(await fs.readFile(path.join(destination, name))) !== expected) throw new Error(`Windows icon output changed: ${name}`);
  }
  const bytes = await fs.readFile(path.join(destination, 'icon.ico')), entries = icoEntries(bytes);
  if (entries[0]?.width !== 256 || entries[0]?.height !== 256) throw new Error('Tauri codegen requires 256 ICO entry first');
  if (entries.length !== sizes.length || !sizes.every((size) => entries.some((entry) => entry.width === size && entry.height === size))) throw new Error('ICO size set differs from 16/24/32/48/64/128/256');
  const expected = ['icons/windows/32x32.png', 'icons/windows/128x128.png', 'icons/windows/128x128@2x.png', 'icons/windows/icon.ico'];
  const configs = [];
  for (const name of ['tauri.windows.conf.json', 'tauri.alignment.conf.json']) {
    const file = path.join(root, 'apps/desktop/src-tauri', name), contents = await fs.readFile(file);
    const config = JSON.parse(contents.toString('utf8'));
    if (JSON.stringify(config.bundle.icon) !== JSON.stringify(expected)) throw new Error(`${name} must use the shared Windows icon family`);
    if (config.bundle.windows?.nsis?.installerIcon !== 'icons/windows/icon.ico' || config.bundle.windows?.nsis?.uninstallerIcon !== 'icons/windows/icon.ico') throw new Error(`${name} must use the shared Windows installer icons`);
    configs.push({ path: relative(file), sha256: sha256(contents) });
  }
  return { schema_version: 1, configs, source: identity, manifest: { path: relative(manifestPath), sha256: sha256(await fs.readFile(manifestPath)) },
    ico: { path: relative(path.join(destination, 'icon.ico')), sha256: sha256(bytes), first_entry: [entries[0].width, entries[0].height],
      entries: entries.map((entry) => ({ size: [entry.width, entry.height], payload_sha256: sha256(entry.payload), ...pngMetrics(entry.payload) })) } };
}

const mode = process.argv[2];
if (!['prepare', 'verify'].includes(mode)) throw new Error('Usage: node scripts/windows/Prepare-WindowsIcons.mjs prepare|verify');
let added128FromCliPng = false;
if (mode === 'prepare') {
  if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Use Node 26 for the pinned Tauri CLI');
  prepareSharedMaster(false);
  await fs.mkdir(generated, { recursive: true });
  const cli = path.join(root, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
  const run = spawnSync(process.execPath, [cli, 'icon', windowsSource, '--output', generated], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Tauri icon exited ${run.status}`);
  const adjusted = windowIco(await fs.readFile(path.join(generated, 'icon.ico')), await fs.readFile(path.join(generated, '128x128.png')));
  added128FromCliPng = adjusted.added128FromCliPng;
  await fs.mkdir(destination, { recursive: true });
  const outputs = {};
  for (const entry of await fs.readdir(generated, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.png')) {
      const bytes = await fs.readFile(path.join(generated, entry.name));
      await fs.writeFile(path.join(destination, entry.name), bytes);
      outputs[entry.name] = sha256(bytes);
    }
  }
  await fs.writeFile(path.join(destination, 'icon.ico'), adjusted.result);
  outputs['icon.ico'] = sha256(adjusted.result);
  const cliPackage = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/node_modules/@tauri-apps/cli/package.json'), 'utf8'));
  await fs.writeFile(manifestPath, `${JSON.stringify({ schema_version: 1,
    source: await sourceIdentity(), generator: { node: process.versions.node, tauri_cli: cliPackage.version }, outputs,
  }, null, 2)}\n`);
}
const report = { ...await verify(), mode, added_128_from_cli_png: added128FromCliPng };
if (mode === 'prepare') await fs.writeFile(path.join(generated, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
