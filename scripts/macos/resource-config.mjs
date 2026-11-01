import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from '../shared/artifact-paths.mjs';
import { resolveEnginePaths } from '../shared/engine-paths.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const licenseTarget = 'resources/app-licenses';

export async function resolveMacosResourceConfig(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const tauriRoot = path.join(root, 'apps/desktop/src-tauri');
  const template = options.configPath ?? path.join(tauriRoot, 'tauri.macos.full.conf.json');
  const config = JSON.parse(await readFile(template, 'utf8'));
  const resources = config.bundle?.resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error('The full macOS resource configuration must contain a resource mapping.');
  }
  const { licenseCurrent } = await resolveArtifactPaths({ repositoryRoot: root, platform: 'macos-arm64' });
  const engines = await resolveEnginePaths({ repositoryRoot: root });
  const managed = {
    [licenseTarget]: licenseCurrent,
    'resources/engines': engines.distributionEngines,
    'resources/release-status.json': engines.releaseStatus,
  };
  let licenseEntries = 0;
  const required = new Map(Object.keys(managed).map(target => [target, 0]));
  const resolved = {};
  for (const [source, destination] of Object.entries(resources)) {
    if (typeof destination !== 'string') throw new Error('Invalid macOS resource destination.');
    const license = destination.replace(/\/+$/, '') === licenseTarget;
    const target = destination.replace(/\/+$/, '');
    if (required.has(target)) required.set(target, required.get(target) + 1);
    if (license) licenseEntries += 1;
    const directory = /[\\/]$/.test(source) || license;
    const absolute = managed[destination.replace(/\/+$/, '')] ?? path.resolve(tauriRoot, source);
    resolved[absolute + (directory ? '/' : '')] = destination;
  }
  if (licenseEntries !== 1) {
    throw new Error('The full macOS resource mapping must contain exactly one app-license destination.');
  }
  if ([...required.values()].some(count => count !== 1)) {
    throw new Error('The full macOS resource mapping must contain exactly one engines and release-status destination.');
  }
  config.bundle.resources = resolved;
  return config;
}

async function main(args) {
  if (args.length) throw new Error('Usage: node scripts/macos/resource-config.mjs');
  process.stdout.write(JSON.stringify(await resolveMacosResourceConfig()) + '\n');
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`macOS resource configuration: ${error.message}`);
    process.exitCode = 1;
  });
}
