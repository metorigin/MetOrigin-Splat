import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineLayout } from './engine-paths.mjs';
import { resolveArtifactPaths } from './artifact-paths.mjs';
const repositoryRoot = path.resolve(path.dirname(await realpath(fileURLToPath(import.meta.url))), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
async function info(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function fileHash(file) { const value = await info(file); if (!value?.isFile() || value.isSymbolicLink()) throw new Error(`Expected a regular engine file: ${file}`); return sha(await readFile(file)); }
async function validateDestination(candidate, targetRoot, platform) {
  const engineRoot = (await info(path.join(targetRoot, 'engines/engine-manifest.json'))) ? path.join(targetRoot, 'engines') : targetRoot;
  const manifestPath = path.join(engineRoot, 'engine-manifest.json');
  const manifestHash = await fileHash(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.platform !== platform) throw new Error('Migrated engine manifest has an unexpected platform/schema.');
  const entries = Object.values(manifest.engines ?? {}).flatMap(engine => engine.files ?? []);
  if (!entries.length) throw new Error('Migrated engine manifest is empty.');
  const value = await info(candidate); if (!value || value.isSymbolicLink()) throw new Error('Migrated setting target must exist as a physical file/directory.');
  const needed = value.isFile() ? entries.filter(x => path.resolve(engineRoot, x.path) === candidate) : entries;
  if (!needed.length) throw new Error('Migrated executable is not declared by the engine manifest.');
  for (const entry of needed) {
    if (typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)) throw new Error('Migrated engine SHA-256 is invalid.');
    const file = path.resolve(engineRoot, entry.path);
    if (!inside(engineRoot, file) || file === engineRoot || await fileHash(file) !== entry.sha256.toLowerCase()) throw new Error('Migrated engine integrity check failed.');
  }
  return manifestHash;
}
export function defaultSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/com.metorigin.splat/settings.json');
  if (platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'com.metorigin.splat/settings.json');
  return undefined;
}
export async function migrateEngineSettings(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const platform = options.platform ?? (process.platform === 'win32' ? 'windows-x64' : 'macos-arm64');
  const settings = options.settingsPath ?? defaultSettingsPath();
  if (!settings || !await info(settings)) return { changed: false, changes: [] };
  const value = await info(settings); if (!value.isFile() || value.isSymbolicLink()) throw new Error('Settings must be a physical regular file.');
  const before = await readFile(settings); const data = JSON.parse(before);
  const { legacyMappings } = await resolveEngineLayout({ repositoryRoot: root, platform });
  const artifacts = await resolveArtifactPaths({ repositoryRoot: root, platform });
  let proof; try { proof = JSON.parse(await readFile(path.join(artifacts.verification, 'engine-layout-migrations.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const mappings = legacyMappings.filter(x => ['distributionRoot', 'alignmentRoot'].includes(x.key)).sort((a, b) => b.legacy.length - a.legacy.length);
  const changes = [];
  async function translate(container, key, label) {
    if (typeof container?.[key] !== 'string' || !container[key]) return;
    const old = path.resolve(container[key]); const mapping = mappings.find(x => inside(x.legacy, old));
    if (!mapping) return;
    const target = path.join(mapping.target, path.relative(mapping.legacy, old));
    if (!await info(target)) return; // Asset migration/acquisition happens before settings migration.
    const manifestHash = await validateDestination(target, mapping.target, platform);
    const original = await info(old);
    if (original?.isFile() && await fileHash(old) !== await fileHash(target)) throw new Error('Old and new engine executables differ; setting preserved.');
    if (original?.isDirectory()) {
      const oldManifest = await info(path.join(old, 'engine-manifest.json')) ? path.join(old, 'engine-manifest.json') : path.join(old, 'engines/engine-manifest.json');
      if (await fileHash(oldManifest) !== manifestHash) throw new Error('Old and new engine packs differ; setting preserved.');
    }
    if (!original) {
      const match = proof?.entries?.some(entry => entry.status === 'verified' && entry.platform === platform && path.resolve(root, entry.legacy) === mapping.legacy && path.resolve(root, entry.target) === mapping.target && entry.manifest_sha256 === manifestHash);
      if (!match) throw new Error('Old engine path is absent and matching migration identity proof is unavailable; setting preserved.');
    }
    changes.push({ key: label, previous: container[key], current: target }); container[key] = target;
  }
  await translate(data, 'engine_directory', 'engine_directory');
  for (const key of Object.keys(data.engine_executables ?? {})) await translate(data.engine_executables, key, `engine_executables.${key}`);
  if (changes.length && options.apply === true) {
    if (!(await readFile(settings)).equals(before)) throw new Error('Settings changed during migration; retry without overwriting concurrent changes.');
    const temporary = `${settings}.layout-${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: value.mode & 0o777, flag: 'wx' });
    try {
      const latest = await info(settings);
      if (!latest || latest.ino !== value.ino || latest.dev !== value.dev || !(await readFile(settings)).equals(before)) throw new Error('Settings changed before commit; preserved the original file.');
      await rename(temporary, settings);
    } finally { await rm(temporary, { force: true }); }
  }
  return { changed: changes.length > 0, applied: options.apply === true, changes };
}
async function main(args) {
  const options = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (key === '--apply') { options.apply = true; continue; }
    const value = args[++i]; if (!value) throw new Error(`Missing ${key}.`);
    if (key === '--settings') options.settingsPath = value; else if (key === '--repo-root') options.repositoryRoot = value; else if (key === '--platform') options.platform = value; else throw new Error(`Unknown ${key}.`);
  }
  console.log(JSON.stringify(await migrateEngineSettings(options)));
}
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await realpath(fileURLToPath(import.meta.url))) === '') main(process.argv.slice(2)).catch(e => { console.error(`Engine settings migration: ${e.message}`); process.exitCode = 1; });
