import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, repository } from './AlignmentPack.mjs';
import { loadWebpOverlay } from '../../integrations/supersplat/webp-overlay-3.10.2/overlay.mjs';
import { webpBuildEvidenceFiles } from '../../integrations/supersplat/webp-evidence.mjs';
import { themeInputs } from '../../integrations/supersplat/ui-theme/apply.mjs';
import { CURRENT_OVERLAY_DIRECTORY } from '../shared/supersplat-evidence.mjs';

const extensions = new Set(['.rs', '.toml', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.wasm', '.glsl', '.wgsl', '.patch', '.svg', '.png', '.ico', '.icns', '.woff', '.woff2', '.txt', '.sh', '.ps1', '.py', '.nsh', '.nsi', '.yml', '.yaml']);
const rootFiles = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', '.nvmrc', 'LICENSE-MIT', 'LICENSE-APACHE'];
const scriptFiles = ['Build-AlignmentCandidate.ps1', 'Build-FullInstaller.ps1', 'Build-WindowsRelease.ps1', 'AlignmentPack.mjs', 'BuildSourceInventory.mjs', 'BundleIdentity.mjs', 'BuildBundlerReceipt.mjs', 'Packaging.Common.ps1', 'Prepare-AlignmentEnginePack.ps1', 'Test-AlignmentEnginePack.ps1', 'Test-AlignmentDefaultRuntime.ps1', 'Start-Development.ps1', 'Expand-AlignmentArchive.ps1', 'Build-BrushRuntime.ps1', 'build_brush_runtime.py'];
const skipDirectories = new Set(['node_modules', 'target', 'dist', '.git', '.cache', '__pycache__']);
const normalize = (value) => value.split(path.sep).join('/');
const present = async (file) => fs.lstat(file).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function entries(root, filter = () => true, sourceTree = true) {
  if (!(await present(root))) return [];
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`Build inventory refuses directory links: ${path.basename(root)}`);
  const result = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (sourceTree && (item.name.startsWith('.env') || item.name.endsWith('.log'))) continue;
    const full = path.join(root, item.name);
    if (item.isDirectory()) {
      if (!sourceTree || !skipDirectories.has(item.name)) result.push(...await entries(full, filter, sourceTree));
    } else if (filter(full)) {
      const info = await fs.lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Build inventory requires regular files: ${item.name}`);
      result.push(full);
    }
  }
  return result;
}

async function record(kind, label, full) {
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Build input is not a regular file: ${label}`);
  return { kind, path: normalize(label), size_bytes: stat.size, sha256: await digest(full) };
}

function inventory(files) {
  files.sort((a, b) => `${a.kind}/${a.path}`.localeCompare(`${b.kind}/${b.path}`));
  const body = { schema_version: 1, files };
  return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

export async function captureInputs({ root = repository, pack, configuration }) {
  if (!(await present(path.join(root, 'Cargo.lock'))) || !(await present(path.join(pack, 'engines')))) throw new Error('Required application lock or selected engine resources are missing');
  const selected = new Set();
  const addFile = async (relative) => { const file = path.join(root, relative); if (await present(file)) selected.add(file); };
  for (const file of rootFiles) await addFile(file);
  // These are actual prebuild dependencies selected by their owning modules,
  // not a general exception for private node_modules or runtime log trees.
  for (const file of await entries(path.join(root, 'patches'), () => true, false)) selected.add(file);
  const uiSources = path.join(root, 'apps/desktop/ui-sources.json');
  if (await present(uiSources)) {
    const sources = JSON.parse(await fs.readFile(uiSources, 'utf8'));
    for (const group of sources.sourceGroups ?? []) {
      for (const relative of [...(group.licenseFiles ?? []), ...(group.noticeFiles ?? [])]) {
        const file = path.resolve(root, 'apps/desktop', relative);
        if (!file.startsWith(path.resolve(root, 'apps/desktop') + path.sep)) throw new Error('UI provenance reference escapes application sources');
        selected.add(file);
      }
    }
  }
  const integration = path.join(root, 'integrations/supersplat');
  const overlayRoot = path.join(integration, CURRENT_OVERLAY_DIRECTORY);
  if (await present(overlayRoot)) {
    const overlay = await loadWebpOverlay(overlayRoot);
    for (const file of overlay.manifest.files) selected.add(path.join(overlayRoot, file.payload));
    for (const file of webpBuildEvidenceFiles(overlay.evidence)) selected.add(path.join(overlayRoot, file.path));
  }
  if (await present(path.join(integration, 'ui-theme'))) {
    for (const file of await themeInputs(integration)) selected.add(path.join(root, file.path));
  }
  const sourceFilter = (file) => extensions.has(path.extname(file).toLowerCase()) || /^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(path.basename(file));
  for (const folder of ['crates', 'presets', 'schemas', 'integrations/jan', 'integrations/supersplat', 'integrations/spark', 'integrations/three', 'integrations/brush-windows', 'scripts/shared']) {
    for (const file of await entries(path.join(root, folder), sourceFilter)) selected.add(file);
  }
  for (const file of await entries(path.join(root, 'apps/desktop/src'), sourceFilter)) selected.add(file);
  for (const file of await entries(path.join(root, 'apps/desktop/public'), () => true, false)) selected.add(file);
  for (const file of await entries(path.join(root, 'apps/desktop/src-tauri/src'), sourceFilter)) selected.add(file);
  for (const folder of ['icons', 'capabilities', 'nsis']) {
    for (const file of await entries(path.join(root, 'apps/desktop/src-tauri', folder))) selected.add(file);
  }
  for (const folder of ['apps/desktop', 'apps/desktop/src-tauri']) {
    if (!(await present(path.join(root, folder)))) continue;
    for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (folder.endsWith('src-tauri')) {
        if (['Cargo.toml', 'build.rs', 'tauri.conf.json', 'tauri.alignment.conf.json', 'tauri.windows.conf.json'].includes(entry.name)) await addFile(`${folder}/${entry.name}`);
      } else if (sourceFilter(entry.name)) await addFile(`${folder}/${entry.name}`);
    }
  }
  for (const file of scriptFiles) await addFile(`scripts/windows/${file}`);
  for (const file of ['alignment-lock.json', 'engine-lock.json', 'THIRD_PARTY_NOTICES.template.md']) await addFile(`packaging/windows-x64/${file}`);
  for (const file of await entries(path.join(root, 'packaging/windows-x64/licenses'))) selected.add(file);
  await addFile('integrations/brush-macos/patches/metorigin-macos.6.patch');
  const records = [];
  for (const file of selected) records.push(await record('source', path.relative(root, file), file));
  for (const folder of ['engines', 'licenses', 'installer']) {
    const base = path.join(pack, folder);
    for (const file of await entries(base, () => true, false)) records.push(await record('resource', path.relative(pack, file), file));
  }
  records.push(await record('configuration', 'tauri.conf.json', configuration));
  return inventory(records);
}

export function assertUnchanged(before, after) {
  for (const proof of [before, after]) {
    if (proof.schema_version !== 1 || !Array.isArray(proof.files) || proof.digest !== inventory(proof.files).digest) throw new Error('Invalid build source inventory');
  }
  if (before.digest !== after.digest) {
    const old = new Map(before.files.map((file) => [`${file.kind}/${file.path}`, file.sha256]));
    const current = new Map(after.files.map((file) => [`${file.kind}/${file.path}`, file.sha256]));
    const changed = [...new Set([...old.keys(), ...current.keys()])].filter((key) => old.get(key) !== current.get(key));
    throw new Error(`Build inputs changed; refusing to publish: ${changed.slice(0, 12).join(', ')}`);
  }
}

export async function captureOutputs({ root = repository, application }) {
  const records = [];
  for (const file of await entries(path.join(root, 'apps/desktop/dist'), () => true, false)) records.push(await record('frontend_output', path.relative(root, file), file));
  if (records.length === 0) throw new Error('Built frontend payload is missing');
  records.push(await record('application_output', path.basename(application), application));
  return inventory(records);
}

async function main(args) {
  const operation = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--pack', '--config', '--inventory', '--outputs', '--application'].includes(key)) throw new Error(`Unknown inventory option ${key}`);
    options[key.slice(2)] = path.resolve(repository, args.shift());
  }
  const current = await captureInputs({ pack: options.pack, configuration: options.config });
  if (operation === 'capture') await fs.writeFile(options.inventory, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
  else if (operation === 'verify') {
    assertUnchanged(JSON.parse(await fs.readFile(options.inventory, 'utf8')), current);
    if (options.outputs) await fs.writeFile(options.outputs, `${JSON.stringify(await captureOutputs({ application: options.application }), null, 2)}\n`, { flag: 'wx' });
  } else throw new Error('Expected capture or verify');
  console.log(JSON.stringify({ source_inventory_digest: current.digest, files: current.files.length, status: operation === 'verify' ? 'unchanged' : 'captured' }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
