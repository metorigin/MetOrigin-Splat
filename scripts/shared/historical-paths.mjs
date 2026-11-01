import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from './artifact-paths.mjs';
import { resolveEngineLayout } from './engine-paths.mjs';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function optional(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const inside = (root, file) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
// Recorded checkout paths may come from another OS or drive. Interpret both
// recorded values with their original path flavor, rather than the host cwd.
function recordedRelative(originalRoot, input) {
  if (typeof originalRoot !== 'string' || typeof input !== 'string') return undefined;
  const flavor = /^[a-z]:[\\/]|^\\\\/i.test(originalRoot) ? path.win32
    : path.posix.isAbsolute(originalRoot) ? path.posix : undefined;
  if (!flavor || !flavor.isAbsolute(input)) return undefined;
  const relative = flavor.relative(originalRoot, input);
  if (relative === '..' || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)) return undefined;
  return relative ? relative.split(flavor.sep) : [];
}
export async function resolveHistoricalPath(input, options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const artifacts = await resolveArtifactPaths({ repositoryRoot: root, platform: 'macos-arm64' });
  const map = await optional(path.join(path.dirname(artifacts.verification), 'history-paths.json'));
  const entries = [...(map?.entries ?? [])];
  const licenseMap = await optional(path.join(artifacts.licenses, 'migration-map.json'));
  entries.push(...(licenseMap?.entries ?? []).map(x => ({ old: x.old, new: x.new })));
  const engineConfig = await optional(path.join(root, 'packaging/shared/engine-paths.json'));
  if (engineConfig) for (const platform of Object.keys(engineConfig.platforms)) {
    const layout = await resolveEngineLayout({ repositoryRoot: root, platform });
    entries.push(...layout.legacyMappings.map(x => ({ old: path.relative(root, x.legacy), new: path.relative(root, x.target) })));
  }
  let candidate = path.resolve(root, input);
  const recorded = recordedRelative(map?.original_repository_root, input);
  if (recorded !== undefined) candidate = path.join(root, ...recorded);
  const matches = [];
  for (const entry of entries) {
    const old = path.resolve(root, entry.old), next = path.resolve(root, entry.new);
    if (!inside(root, old) || !inside(root, next) || old === root || next === root) throw new Error('Invalid historical migration boundary.');
    if (inside(old, candidate)) matches.push({ length: old.length, file: path.join(next, path.relative(old, candidate)) });
  }
  const file = matches.sort((a, b) => b.length - a.length)[0]?.file ?? candidate;
  let exists; try { await lstat(file); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
  return { original: input, path: file, migrated: file !== path.resolve(root, input), exists };
}
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await realpath(fileURLToPath(import.meta.url))) === '') {
  if (process.argv.length !== 3) { console.error('Usage: historical-paths.mjs OLD_PATH'); process.exitCode = 1; }
  else resolveHistoricalPath(process.argv[2]).then(x => console.log(JSON.stringify(x)), e => { console.error(e.message); process.exitCode = 1; });
}
