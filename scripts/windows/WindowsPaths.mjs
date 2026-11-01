import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnginePaths } from '../shared/engine-paths.mjs';
import { resolveArtifactPaths } from '../shared/artifact-paths.mjs';

// One bridge for Node and Windows PowerShell 5.1. Resolving paths is read-only.
export async function resolveWindowsPaths(options = {}) {
  const engine = await resolveEnginePaths({ ...options, platform: 'windows-x64' });
  const artifact = await resolveArtifactPaths({ repositoryRoot: options.repositoryRoot, platform: 'windows-x64' });
  return { ...engine, packages: artifact.packages, verification: artifact.verification,
    licenses: artifact.licenses, alignmentEngines: path.join(engine.alignmentRoot, 'engines') };
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--key')) throw new Error('Usage: WindowsPaths.mjs [--key NAME]');
    const paths = await resolveWindowsPaths();
    if (args.length && !Object.hasOwn(paths, args[1])) throw new Error(`Unknown Windows path: ${args[1]}`);
    process.stdout.write(`${args.length ? paths[args[1]] : JSON.stringify(paths)}\n`);
  } catch (error) { console.error(`Windows paths: ${error.message}`); process.exitCode = 1; }
}
