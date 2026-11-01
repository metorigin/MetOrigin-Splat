import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(realpathSync.native(fileURLToPath(import.meta.url))), '../..');

function relativeDirectory(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || /[\\\0\r\n:]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a repository-relative directory without traversal.`);
  }
  return value;
}

// Resolving destinations is read-only. Source preparation separately verifies
// physical ancestors before it creates or repairs the disposable checkout.
export function resolveCachePaths(options = {}) {
  const repo = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const configPath = options.configPath ?? path.join(repo, 'packaging/shared/cache-paths.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config?.schema_version !== 1) {
    throw new Error('Unsupported cache path schema; expected schema_version 1.');
  }
  const root = path.join(repo, relativeDirectory(config.root, 'root'));
  const supersplatSourceRoot = path.join(root,
    relativeDirectory(config.directories?.supersplatSource, 'directories.supersplatSource'));
  return {
    root,
    supersplatSourceRoot,
    supersplatSource: path.join(supersplatSourceRoot, 'upstream'),
    supersplatNpm: path.join(root,
      relativeDirectory(config.directories?.supersplatNpm, 'directories.supersplatNpm')),
  };
}

function main(args) {
  const keys = { root: 'root', 'source-root': 'supersplatSourceRoot', source: 'supersplatSource', npm: 'supersplatNpm' };
  let kind;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--kind' || !Object.hasOwn(keys, args[1])) {
      throw new Error('Usage: node scripts/shared/cache-paths.mjs [--kind root|source-root|source|npm]');
    }
    kind = args[1];
  }
  const paths = resolveCachePaths();
  process.stdout.write(`${kind === undefined ? JSON.stringify(paths) : paths[keys[kind]]}\n`);
}

let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync.native(process.argv[1]); } catch { /* Imported without a file entry point. */ }
if (invokedPath && path.relative(invokedPath, realpathSync.native(fileURLToPath(import.meta.url))) === '') {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Cache paths: ${error.message}`);
    process.exitCode = 1;
  }
}
