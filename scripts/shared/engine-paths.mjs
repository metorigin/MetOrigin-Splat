import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from './artifact-paths.mjs';
import { resolveCachePaths } from './cache-paths.mjs';

const repositoryRoot = path.resolve(path.dirname(await realpath(fileURLToPath(import.meta.url))), '../..');

function relativeDirectory(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || /[\\\0\r\n:]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a repository-relative directory without traversal.`);
  }
  return value;
}

export async function resolveEngineLayout(options = {}) {
  const repo = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const platform = options.platform ?? 'macos-arm64';
  const config = JSON.parse(await readFile(options.configPath ?? path.join(repo, 'packaging/shared/engine-paths.json'), 'utf8'));
  if (config?.schema_version !== 1) throw new Error('Unsupported engine path schema; expected schema_version 1.');
  if (!Object.hasOwn(config.platforms ?? {}, platform)) throw new Error(`Unsupported engine platform: ${platform}`);
  const definition = config.platforms[platform];
  if (!definition.paths || typeof definition.paths !== 'object' || Array.isArray(definition.paths)) {
    throw new Error('Missing engine path definitions.');
  }
  const bases = {
    engines: path.join(repo, relativeDirectory(config.engines_root, 'engines_root')),
    cache: resolveCachePaths({ repositoryRoot: repo }).root,
    verification: (await resolveArtifactPaths({ repositoryRoot: repo, platform })).verification,
  };
  const paths = {};
  for (const [key, entry] of Object.entries(definition.paths)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || !Object.hasOwn(bases, entry?.base)) {
      throw new Error(`Invalid engine path definition: ${key}`);
    }
    paths[key] = path.join(bases[entry.base], relativeDirectory(entry.path, `paths.${key}`));
  }
  for (const key of ['developmentRoot', 'distributionRoot']) {
    if (!paths[key] || definition.paths[key].base !== 'engines') throw new Error(`Missing or non-engine runtime path: ${key}`);
  }
  paths.distributionEngines = path.join(paths.distributionRoot, 'engines');
  paths.releaseStatus = path.join(paths.distributionRoot, 'release-status.json');
  const legacyMappings = [];
  for (const [old, entry] of Object.entries(definition.legacy_mappings ?? {})) {
    const legacy = path.join(repo, relativeDirectory(old, 'legacy_mappings'));
    if (!Object.hasOwn(paths, entry?.key) || (entry.compatibility_link !== undefined && typeof entry.compatibility_link !== 'boolean')) {
      throw new Error(`Invalid engine migration entry: ${old}`);
    }
    const target = paths[entry.key];
    if (entry.compatibility_link) {
      const within = path.relative(legacy, target);
      if (!old.startsWith('target/') || !within || (!within.startsWith(`..${path.sep}`) && within !== '..' && !path.isAbsolute(within))) {
        throw new Error(`Unsafe engine compatibility entry: ${old}`);
      }
    }
    legacyMappings.push({ legacy, target, key: entry.key, compatibilityLink: entry.compatibility_link === true });
  }
  const flatCompatibility = Object.entries(definition.flat_compatibility ?? {}).map(([name, key]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !Object.hasOwn(paths, key)) throw new Error(`Invalid flat engine entry: ${name}`);
    return { legacy: path.join(bases.engines, name), target: paths[key], key };
  });
  return { paths, legacyMappings, flatCompatibility };
}

export async function resolveEnginePaths(options = {}) {
  return (await resolveEngineLayout(options)).paths;
}

async function main(args) {
  const options = {};
  let key;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--repo-root') options.repositoryRoot = value;
    else if (flag === '--platform') options.platform = value;
    else if (flag === '--key') key = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  const paths = await resolveEnginePaths(options);
  if (key !== undefined && !Object.hasOwn(paths, key)) throw new Error(`Unknown engine path: ${key}`);
  process.stdout.write(`${key === undefined ? JSON.stringify(paths) : paths[key]}\n`);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await realpath(fileURLToPath(import.meta.url))) === '') {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Engine paths: ${error.message}`);
    process.exitCode = 1;
  });
}
