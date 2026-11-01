import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(await realpath(fileURLToPath(import.meta.url))), '../..');
const platforms = new Set(['macos-arm64', 'windows-x64']);
const kinds = ['packages', 'verification', 'licenses'];

function relativeDirectory(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || /[\\\0\r\n:]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a repository-relative directory without traversal.`);
  }
  return value;
}

// Shared destination layout. Reading it never creates or moves files; engine
// packs and Cargo output keep their existing paths.
export async function resolveArtifactPaths(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  if (!platforms.has(options.platform)) {
    throw new Error(`Unsupported artifact platform: ${options.platform}`);
  }
  const configPath = options.configPath ?? path.join(root, 'packaging/shared/artifact-paths.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config?.schema_version !== 1) {
    throw new Error('Unsupported artifact path schema; expected schema_version 1.');
  }
  const artifactRoot = path.join(root, relativeDirectory(config.root, 'root'));
  const result = { root: artifactRoot };
  for (const kind of kinds) {
    result[kind] = path.join(artifactRoot,
      relativeDirectory(config.directories?.[kind], `directories.${kind}`), options.platform);
  }
  result.licenseCurrent = path.join(result.licenses, 'current');
  result.licenseArchive = path.join(result.licenses, 'archive');
  return result;
}

async function main(args) {
  let platform;
  let kind;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--platform' || option === '--kind') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
      if (option === '--platform') platform = value;
      else kind = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  const aliases = { 'license-current': 'licenseCurrent', 'license-archive': 'licenseArchive' };
  if (kind !== undefined && kind !== 'root' && !kinds.includes(kind) && !Object.hasOwn(aliases, kind)) {
    throw new Error(`Unknown artifact kind: ${kind}`);
  }
  const paths = await resolveArtifactPaths({ platform });
  process.stdout.write(`${kind === undefined ? JSON.stringify(paths) : paths[aliases[kind] ?? kind]}\n`);
}

// Node resolves import.meta.url through symlinks, while argv can retain /var
// instead of /private/var on macOS (or a symlinked checkout directory).
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await realpath(fileURLToPath(import.meta.url))) === '') {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Artifact paths: ${error.message}`);
    process.exitCode = 1;
  });
}
