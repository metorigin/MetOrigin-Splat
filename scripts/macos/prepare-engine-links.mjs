import { lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineLayout } from '../shared/engine-paths.mjs';
import { migrateEngineSettings } from '../shared/migrate-engine-settings.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function info(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function physicalDirectory(root, directory, create = false) {
  const inside = path.relative(root, directory);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error('Engine compatibility directories must remain inside the checkout.');
  }
  let current = root;
  for (const part of inside ? inside.split(path.sep) : []) {
    current = path.join(current, part);
    let stat = await info(current);
    if (!stat && create) {
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await info(current);
    }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Engine compatibility directories must be physical directories: ${current}`);
    }
  }
  return true;
}

async function expectedLink(legacy, target) {
  const stat = await info(legacy);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    const actual = path.resolve(path.dirname(legacy), await readlink(legacy));
    const same = process.platform === 'win32'
      ? path.toNamespacedPath(actual).toLowerCase() === path.toNamespacedPath(target).toLowerCase()
      : actual === target;
    if (same) return true;
  }
  throw new Error(`Engine compatibility path already exists and is not the expected link: ${legacy}. Preserve it and complete the engine migration before retrying.`);
}

// The native CLI supplies the real host platform. The explicit API options let
// portable tests exercise the filesystem contract in temporary checkouts.
export async function prepareEngineLinks(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin' || (options.arch ?? process.arch) !== 'arm64') {
    return { skipped: true, links: [] };
  }
  const root = await realpath(options.repositoryRoot ?? repositoryRoot);
  const { legacyMappings } = await resolveEngineLayout({
    repositoryRoot: root, platform: 'macos-arm64', configPath: options.configPath,
  });
  const entries = legacyMappings.filter(entry => entry.compatibilityLink);
  const plans = [];
  // Check every selected entry before creating any directories or links. A
  // conflict must never overwrite a user's directory or a foreign link.
  for (const entry of entries) {
    const targetExists = await physicalDirectory(root, entry.target);
    if (!targetExists) {
      plans.push({ ...entry, status: 'missing-target' });
      continue;
    }
    await physicalDirectory(root, path.dirname(entry.legacy));
    plans.push({ ...entry, status: await expectedLink(entry.legacy, entry.target) ? 'unchanged' : 'create' });
  }
  const links = [];
  for (const plan of plans) {
    let status = plan.status;
    if (status === 'create') {
      await physicalDirectory(root, path.dirname(plan.legacy), true);
      // symlink never replaces an existing entry. Recheck a race against a
      // concurrent successful invocation, accepting only the exact same link.
      try {
        const target = process.platform === 'win32' ? plan.target : path.relative(path.dirname(plan.legacy), plan.target);
        await symlink(target, plan.legacy, process.platform === 'win32' ? 'junction' : 'dir');
        status = 'created';
      } catch (error) {
        if (error.code !== 'EEXIST' || !await expectedLink(plan.legacy, plan.target)) throw error;
        status = 'unchanged';
      }
    }
    links.push({ legacy: plan.legacy, target: plan.target, key: plan.key, status });
  }
  return { skipped: false, links };
}

async function main(args) {
  if (args.length) throw new Error('Usage: node scripts/macos/prepare-engine-links.mjs');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const migration = await migrateEngineSettings({ apply: true });
    if (migration.changed) console.log(`Migrated ${migration.changes.length} saved engine paths to the stable layout.`);
  }
  const result = await prepareEngineLinks();
  const created = result.links.filter(entry => entry.status === 'created').length;
  if (created) console.log(`Prepared ${created} macOS engine compatibility entries.`);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Engine compatibility: ${error.message}`);
    process.exitCode = 1;
  });
}
