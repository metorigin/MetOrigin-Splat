import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineLayout } from '../shared/engine-paths.mjs';
import { resolveArtifactPaths } from '../shared/artifact-paths.mjs';

const repository = path.resolve(path.dirname(await fs.realpath(fileURLToPath(import.meta.url))), '../..');
const present = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const hash = async file => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); };

async function physicalAncestors(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Migration path must remain within this checkout.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!(await present(current))) break;
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Migration refuses linked or non-directory ancestors: ${current}`);
  }
}

async function inventory(root, base = root) {
  const entries = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, item.name), info = await fs.lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Migration refuses non-regular entries: ${filename}`);
    if (info.isDirectory()) { entries.push({ path: path.relative(base, filename).split(path.sep).join('/'), kind: 'directory' }); entries.push(...await inventory(filename, base)); }
    else entries.push({ kind: 'file', path: path.relative(base, filename).split(path.sep).join('/'), size: info.size, sha256: await hash(filename) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function verifyPack(root, files) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'engines/engine-manifest.json'), 'utf8'));
  if (manifest.schema_version !== 1 || manifest.platform !== 'windows-x64'
      || !manifest.pack_version || Object.keys(manifest.engines ?? {}).sort().join(',') !== 'brush,colmap,ffmpeg') throw new Error('Legacy pack has an invalid Windows manifest.');
  const actual = new Map(files.map(file => [file.path, file]));
  for (const [name, engine] of Object.entries(manifest.engines)) {
    const declared = new Set();
    if (!Array.isArray(engine.files) || !engine.files.length) throw new Error(`Missing ${name} inventory.`);
    for (const entry of engine.files) {
      if (typeof entry.path !== 'string' || !entry.path.startsWith(`${name}/`) || /[\\:]/.test(entry.path)
          || entry.path.split('/').some(part => !part || part === '.' || part === '..') || declared.has(entry.path.toLowerCase())) throw new Error('Unsafe or duplicate legacy manifest entry.');
      declared.add(entry.path.toLowerCase());
      const file = actual.get(`engines/${entry.path}`);
      if (!file || file.sha256 !== entry.sha256?.toLowerCase() || file.size !== entry.size_bytes) throw new Error(`Legacy pack integrity failure: ${entry.path}`);
    }
    for (const file of files.filter(item => item.kind === 'file' && item.path.startsWith(`engines/${name}/`))) {
      if (!declared.has(file.path.slice('engines/'.length).toLowerCase())) throw new Error(`Undeclared legacy engine file: ${file.path}`);
    }
    const required = name === 'ffmpeg' ? ['ffmpeg', 'ffprobe'] : [name];
    if (required.some(key => typeof engine.executables?.[key] !== 'string')) throw new Error(`Incomplete ${name} executable map.`);
    for (const executable of Object.values(engine.executables ?? {})) {
      if (!declared.has(String(executable).toLowerCase())) throw new Error('Legacy executable is outside the manifest inventory.');
    }
  }
}

async function verifyDownloads(repo, files) {
  const lock = JSON.parse(await fs.readFile(path.join(repo, 'packaging/windows-x64/engine-lock.json'), 'utf8'));
  const known = new Map(Object.values(lock.components).map(entry => [entry.archive_filename, entry]));
  known.set('brush-v0.3.0-source.zip', { sha256: '510698af9e6fdace4b3d0bbe8695e5549f2f969ad0260a32b4b49694bcc51c0a' });
  for (const file of files) {
    const entry = known.get(file.path);
    if (!entry || file.sha256 !== entry.sha256.toLowerCase() || entry.size_bytes !== undefined && file.size !== entry.size_bytes) throw new Error(`Unrecognized or changed legacy archive: ${file.path}`);
  }
}

async function migrationReceipt(root, moves) {
  const packKeys = ['distributionRoot', 'alignmentRoot'];
  if (!moves.some(move => packKeys.includes(move.key))) return { record: async () => {}, release: async () => {} };
  const { verification } = await resolveArtifactPaths({ repositoryRoot: root, platform: 'windows-x64' });
  await physicalAncestors(root, verification);
  await fs.mkdir(verification, { recursive: true });
  await physicalAncestors(root, verification);
  const receipt = path.join(verification, 'engine-layout-migrations.json');
  const lock = `${receipt}.lock`;
  await fs.mkdir(lock); // Refuse concurrent or stale ownership before moving data.
  const read = async () => {
    if (!(await present(receipt))) return { schema_version: 1, entries: [] };
    const info = await fs.lstat(receipt);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Migration receipt must be a regular file.');
    const value = JSON.parse(await fs.readFile(receipt, 'utf8'));
    if (value.schema_version !== 1 || !Array.isArray(value.entries) || value.entries.some(entry =>
      entry?.platform !== 'windows-x64' || entry.status !== 'verified' || !/^[a-f\d]{64}$/.test(entry.manifest_sha256)
      || [entry.legacy, entry.target].some(name => typeof name !== 'string' || /[\\:]/.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')))) throw new Error('Unrecognized migration receipt; source data was preserved.');
    return value;
  };
  try { await read(); } catch (error) { await fs.rmdir(lock); throw error; }
  return {
    release: () => fs.rmdir(lock),
    record: async move => {
      if (!packKeys.includes(move.key)) return;
      const value = await read();
      const entry = { legacy: path.relative(root, move.legacy).split(path.sep).join('/'),
        target: path.relative(root, move.target).split(path.sep).join('/'),
        manifest_sha256: move.files.find(file => file.path === 'engines/engine-manifest.json').sha256,
        platform: 'windows-x64', status: 'verified' };
      value.entries = value.entries.filter(old => old.legacy !== entry.legacy || old.target !== entry.target);
      value.entries.push(entry);
      const temporary = `${receipt}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        await fs.rename(temporary, receipt);
      } finally { if (await present(temporary)) await fs.unlink(temporary); }
    },
  };
}

export async function migrateWindowsLayout(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repository);
  const layout = await resolveEngineLayout({ repositoryRoot: root, platform: 'windows-x64' });
  const selected = options.keys ? new Set(options.keys) : undefined;
  if (selected) for (const key of selected) if (!Object.hasOwn(layout.paths, key)) throw new Error(`Unknown migration key: ${key}`);
  const moves = [];
  // Preflight every selected source before moving any directory.
  for (const mapping of layout.legacyMappings) {
    if (selected && !selected.has(mapping.key) || !(await present(mapping.legacy))) continue;
    await physicalAncestors(root, mapping.legacy);
    await physicalAncestors(root, mapping.target);
    const files = await inventory(mapping.legacy);
    if (['distributionRoot', 'alignmentRoot'].includes(mapping.key)) await verifyPack(mapping.legacy, files);
    if (mapping.key === 'engineDownloads') await verifyDownloads(root, files);
    if (await present(mapping.target)) {
      const targetFiles = await inventory(mapping.target);
      if (JSON.stringify(files) !== JSON.stringify(targetFiles)) throw new Error(`New layout already contains different data; preserved both directories: ${mapping.target}`);
    }
    moves.push({ ...mapping, files });
  }
  const results = [];
  const proof = await migrationReceipt(root, moves);
  try {
    for (const move of moves) {
      await physicalAncestors(root, move.legacy);
      await physicalAncestors(root, move.target);
      if (JSON.stringify(await inventory(move.legacy)) !== JSON.stringify(move.files)) throw new Error('Legacy data changed during migration; source was preserved.');
      if (await present(move.target)) {
        if (JSON.stringify(await inventory(move.target)) !== JSON.stringify(move.files)) throw new Error('Destination changed during migration; source was preserved.');
        await proof.record(move);
        await fs.rm(move.legacy, { recursive: true });
        results.push({ key: move.key, source: move.legacy, target: move.target, status: 'identical-destination', file_count: move.files.filter(entry => entry.kind === 'file').length });
        continue;
      }
      await fs.mkdir(path.dirname(move.target), { recursive: true });
      try {
        await fs.rename(move.legacy, move.target);
        if (JSON.stringify(await inventory(move.target)) !== JSON.stringify(move.files)) throw new Error('Moved data changed identity.');
        await proof.record(move);
      } catch (error) {
        if (error.code !== 'EXDEV') {
          if (!(await present(move.legacy)) && await present(move.target)) await fs.rename(move.target, move.legacy);
          throw error;
        }
        const stage = `${move.target}.migration-${process.pid}`;
        if (await present(stage)) throw new Error(`Migration staging directory already exists: ${stage}`);
        try {
          await fs.cp(move.legacy, stage, { recursive: true, errorOnExist: true, force: false });
          if (JSON.stringify(await inventory(stage)) !== JSON.stringify(move.files)) throw new Error('Copied data changed identity; source was preserved.');
          if (await present(move.target)) throw new Error('Destination appeared during migration; source was preserved.');
          await fs.rename(stage, move.target);
          if (JSON.stringify(await inventory(move.legacy)) !== JSON.stringify(move.files)) throw new Error('Source changed during copying; both copies were preserved.');
          await proof.record(move);
          await fs.rm(move.legacy, { recursive: true });
        } finally { if (await present(stage)) await fs.rm(stage, { recursive: true }); }
      }
      results.push({ key: move.key, source: move.legacy, target: move.target, status: 'moved', file_count: move.files.filter(entry => entry.kind === 'file').length });
    }
  } finally { await proof.release(); }
  if (results.length) {
    const legacyParent = path.join(root, 'target/distribution');
    try { await physicalAncestors(root, legacyParent); await fs.rmdir(legacyParent); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
  return results;
}

const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await fs.realpath(fileURLToPath(import.meta.url))) === '') {
  try {
    const args = process.argv.slice(2), keys = [];
    while (args.length) { if (args.shift() !== '--key' || !args.length) throw new Error('Usage: MigrateLocalLayout.mjs [--key KEY]...'); keys.push(args.shift()); }
    const result = await migrateWindowsLayout({ keys: keys.length ? keys : undefined });
    if (result.length) process.stdout.write(`${JSON.stringify({ migrations: result })}\n`);
  } catch (error) { console.error(`Windows layout migration: ${error.message}`); process.exitCode = 1; }
}
