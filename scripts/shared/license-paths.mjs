import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from './artifact-paths.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function info(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Validate before collection invokes dependency tools or creates any output.
// A new collection cannot be placed inside a previous manifest-bound tree.
export async function resolveLicenseCollectionOutput(options = {}) {
  const repo = await realpath(options.repositoryRoot ?? repositoryRoot);
  const paths = await resolveArtifactPaths({ repositoryRoot: repo, platform: 'macos-arm64', configPath: options.configPath });
  const output = path.resolve(repo, options.requestedOutput ?? paths.licenseCurrent);
  const within = path.relative(paths.licenses, output);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('Output must be a fresh child of the configured macOS license directory.');
  }
  let parent = repo;
  const parts = path.relative(repo, output).split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    parent = path.join(parent, parts[index]);
    const stat = await info(parent);
    if (index === parts.length - 1 && stat) {
      throw new Error('Evidence already exists; select a new output directory.');
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('License output parents must be physical directories.');
    }
    if (index < parts.length - 1 && await info(path.join(parent, 'manifest.json'))) {
      throw new Error('Output cannot be nested inside an existing license collection.');
    }
  }
  return output;
}
