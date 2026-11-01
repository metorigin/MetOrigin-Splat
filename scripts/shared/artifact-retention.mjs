import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from './artifact-paths.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const marker = 'metorigin-package-retention-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const within = (root, file) => file !== root && !path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file));
async function stat(file) { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function physical(root, file) {
  if (file !== root && !within(root, file)) throw new Error('Artifact path escapes its managed root.');
  let current = root;
  for (const part of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const value = await stat(current);
    if (!value || !value.isDirectory() || value.isSymbolicLink()) throw new Error(`Artifact parents must be physical directories: ${current}`);
  }
}
async function regular(root, file) {
  await physical(root, path.dirname(file));
  const value = await stat(file);
  if (!value?.isFile() || value.isSymbolicLink()) throw new Error(`Expected a physical artifact file: ${file}`);
  return value;
}
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
}
async function context(options) {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const platform = options.platform ?? (process.platform === 'win32' ? 'windows-x64' : 'macos-arm64');
  const paths = await resolveArtifactPaths({ repositoryRoot: root, platform });
  const config = await json(path.join(root, 'packaging/shared/artifact-paths.json'));
  const keep = config.retention?.packages ?? 1;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Package retention must keep at least one successful run.');
  await mkdir(paths.verification, { recursive: true });
  await physical(root, paths.verification);
  const indexPath = path.join(paths.verification, 'retention-index.json');
  return { root, platform, paths, keep, indexPath };
}
async function acquireLock(lock) {
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reaping = `${lock}.reaping`;
    await mkdir(reaping); // Serialize all stale-owner reclamation; unknown/stale reapers fail closed.
    try {
      const existing = await stat(lock);
      if (!existing?.isDirectory() || existing.isSymbolicLink()) throw new Error('Retention lock must be a physical directory.');
      const ownerFile = path.join(lock, 'owner.json');
      const ownerStat = await stat(ownerFile);
      if (!ownerStat?.isFile() || ownerStat.isSymbolicLink()) throw new Error('Retention lock owner must be a physical file.');
      const owner = await json(ownerFile);
      if (owner.owner !== marker || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new Error('Unknown retention lock; preserved for review.');
      try { process.kill(owner.pid, 0); throw new Error('Another retention process is active.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      const stale = `${lock}.stale-${randomUUID()}`;
      await rename(lock, stale);
      const moved = await json(path.join(stale, 'owner.json'));
      if (JSON.stringify(moved) !== JSON.stringify(owner) || (await readdir(stale)).join(',') !== 'owner.json') throw new Error('Retention lock changed; preserved.');
      await rm(path.join(stale, 'owner.json')); await rmdir(stale); await mkdir(lock);
    } finally { await rmdir(reaping); }
  }
  const token = randomUUID(); const ownerFile = path.join(lock, 'owner.json');
  await writeFile(ownerFile, JSON.stringify({ owner: marker, pid: process.pid, token }), { flag: 'wx' });
  return async () => {
    const current = await json(ownerFile);
    if (current.token !== token || current.pid !== process.pid) throw new Error('Retention lock ownership changed.');
    await rm(ownerFile); await rmdir(lock);
  };
}
async function locked(options, action) {
  const c = await context(options);
  const lock = path.join(c.paths.verification, '.retention-lock');
  const release = await acquireLock(lock);
  try {
    const exists = await stat(c.indexPath);
    if (exists && (!exists.isFile() || exists.isSymbolicLink())) throw new Error('Retention index must be a physical file.');
    c.index = exists ? await json(c.indexPath) : { schema_version: 1, owner: marker, platform: c.platform, runs: [] };
    if (c.index.schema_version !== 1 || c.index.owner !== marker || c.index.platform !== c.platform || !Array.isArray(c.index.runs)) throw new Error('Unrecognized retention index; no cleanup performed.');
    if (await stat(path.join(c.paths.verification, 'retention-pending.json'))) {
      if (!options.recoveryAllowed) throw new Error('Pending retention recovery requires --apply; dry-run preserved artifacts.');
      await recoverPending(c);
    }
    return await action(c);
  } finally { await release(); }
}

function resolveOwned(c, name, root) {
  if (typeof name !== 'string') throw new Error('Invalid retention path.');
  const result = path.resolve(c.root, name);
  if (!within(root, result)) throw new Error('Retention entry escapes the configured managed directory.');
  return result;
}
const packageMarker = '.metorigin-package-run.json';
async function directoryInventory(c, directory, excluded = packageMarker) {
  await physical(c.root, directory); const files = [];
  async function visit(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (folder === directory && entry.name === excluded) continue;
      if (entry.isSymbolicLink()) throw new Error('Linked package contents cannot be automatically pruned.');
      if (entry.isDirectory()) { files.push({ path: path.relative(directory, file), kind: 'directory' }); await visit(file); }
      else if (entry.isFile()) files.push({ path: path.relative(directory, file), kind: 'file', sha256: await hashFile(file) });
      else throw new Error('Unexpected special package entry.');
    }
  }
  await visit(directory); return files;
}
async function packageDescriptor(c, file, report) {
  if (!within(c.paths.packages, file)) throw new Error('Package is outside the configured package directory.');
  await physical(c.root, path.dirname(file)); const value = await stat(file);
  if (!value || value.isSymbolicLink()) throw new Error('Expected a physical artifact file or directory.');
  if (value.isFile()) return { path: path.relative(c.root, file), sha256: await hashFile(file), kind: 'file' };
  if (!value.isDirectory()) throw new Error('Unexpected package type.');
  const receipt = path.join(file, packageMarker); const previous = await stat(receipt);
  if (previous) {
    await regular(c.root, receipt); const owned = await json(receipt);
    if (owned.owner !== marker || owned.report !== report) throw new Error('Foreign package directory marker.');
  }
  const inventory = await directoryInventory(c, file);
  if (!inventory.some(x => x.kind === 'file')) throw new Error('Empty delivery directory cannot be registered.');
  const descriptor = { path: path.relative(c.root, file), kind: 'directory', inventory, sha256: digest(JSON.stringify(inventory)) };
  await atomic(receipt, { owner: marker, report, inventory_sha256: descriptor.sha256 });
  return descriptor;
}
async function verifyPackage(c, pkg, report) {
  const file = resolveOwned(c, pkg.path, c.paths.packages);
  if (pkg.kind === 'directory') {
    await physical(c.root, file); const receipt = path.join(file, packageMarker); await regular(c.root, receipt);
    const owned = await json(receipt);
    if (owned.owner !== marker || owned.report !== report || owned.inventory_sha256 !== pkg.sha256) throw new Error('Package directory marker changed.');
    if (digest(JSON.stringify(await directoryInventory(c, file))) !== pkg.sha256) throw new Error('Delivered package changed; no cleanup performed.');
  } else {
    await regular(c.root, file);
    if (await hashFile(file) !== pkg.sha256) throw new Error('Delivered package changed; no cleanup performed.');
  }
  return file;
}
function validatePackageBoundaries(c, runs) {
  const items = runs.flatMap(run => run.packages.map(pkg => ({ report: run.report, file: resolveOwned(c, pkg.path, c.paths.packages) })));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.file === b.file || within(a.file, b.file) || within(b.file, a.file)) throw new Error('Overlapping registered package paths; no cleanup performed.');
  }
}
async function snapshot(c, file) {
  const value = await stat(file);
  if (!value || value.isSymbolicLink()) throw new Error('Quarantine source must be physical.');
  if (value.isDirectory()) return { kind: 'directory', entries: await directoryInventory(c, file, null) };
  await regular(c.root, file); return { kind: 'file', sha256: await hashFile(file) };
}
async function checkSnapshot(c, file, expected, allowMissingEntries) {
  const actual = await snapshot(c, file);
  if (actual.kind !== expected.kind) throw new Error('Quarantined artifact changed type.');
  if (actual.kind === 'file') { if (actual.sha256 !== expected.sha256) throw new Error('Quarantined artifact changed.'); return; }
  if (!allowMissingEntries) { if (JSON.stringify(actual.entries) !== JSON.stringify(expected.entries)) throw new Error('Artifact changed before quarantine.'); return; }
  const originals = new Map(expected.entries.map(x => [x.path, JSON.stringify(x)]));
  if (actual.entries.some(x => originals.get(x.path) !== JSON.stringify(x))) throw new Error('Unknown or changed quarantine contents; preserved for review.');
}
async function quarantinePlan(c, plan) {
  if (!plan.length) return;
  const trash = path.join(c.paths.verification, '.retention-trash', randomUUID());
  await mkdir(path.dirname(trash), { recursive: true }); await physical(c.root, path.dirname(trash));
  await mkdir(trash); await physical(c.root, trash);
  const moves = [];
  for (const item of plan) for (const file of [...item.packages.map(x => path.resolve(c.root, x.path)), item.root]) {
    moves.push({ source: path.relative(c.root, file), target: path.relative(c.root, path.join(trash, String(moves.length))), snapshot: await snapshot(c, file) });
  }
  const removed = new Set(plan.map(x => x.run.report));
  const next = { ...c.index, runs: c.index.runs.filter(x => !removed.has(x.report)) };
  const intent = { owner: marker, previous_index: c.index, source_index_sha256: digest(JSON.stringify(c.index)), next_index_sha256: digest(JSON.stringify(next)), next_index: next, trash: path.relative(c.root, trash), moves };
  await atomic(path.join(c.paths.verification, 'retention-pending.json'), intent);
  await recoverPending(c);
}
async function recoverPending(c) {
  const pending = path.join(c.paths.verification, 'retention-pending.json');
  if (!await stat(pending)) return;
  await regular(c.root, pending); const intent = await json(pending);
  if (intent.owner !== marker || digest(JSON.stringify(intent.previous_index)) !== intent.source_index_sha256 || digest(JSON.stringify(intent.next_index)) !== intent.next_index_sha256) throw new Error('Invalid retention recovery intent.');
  const retained = new Set(intent.next_index.runs.map(run => run.report));
  const expired = intent.previous_index.runs.filter(run => !retained.has(run.report));
  if (expired.some(run => run.pinned) || JSON.stringify({ ...intent.previous_index, runs: intent.previous_index.runs.filter(run => retained.has(run.report)) }) !== JSON.stringify(intent.next_index)) throw new Error('Recovery changed retained registry entries.');
  const allowed = expired.flatMap(run => [...run.packages.map(pkg => pkg.path), run.root]).sort();
  if (JSON.stringify(intent.moves.map(move => move.source).sort()) !== JSON.stringify(allowed)) throw new Error('Recovery paths differ from registered expired artifacts.');
  const current = digest(JSON.stringify(c.index));
  if (![intent.source_index_sha256, intent.next_index_sha256].includes(current)) throw new Error('Retention recovery index changed; preserve quarantine for review.');
  const trash = resolveOwned(c, intent.trash, path.join(c.paths.verification, '.retention-trash'));
  if (!await stat(trash) && current === intent.next_index_sha256) {
    for (const move of intent.moves) if (await stat(path.resolve(c.root, move.source))) throw new Error('A pruned artifact path was reused; preserved.');
    await rm(pending); return;
  }
  await physical(c.root, trash);
  for (const entry of await readdir(trash)) if (!intent.moves.some(x => path.basename(x.target) === entry)) throw new Error('Unknown quarantine content.');
  for (const move of intent.moves) {
    const source = path.resolve(c.root, move.source), target = path.resolve(c.root, move.target);
    if ((!within(c.paths.packages, source) && !within(c.paths.verification, source)) || path.dirname(target) !== trash) throw new Error('Invalid recovery path boundary.');
    const a = await stat(source), b = await stat(target);
    if (a && b) throw new Error('Both retention source and quarantine exist; preserved.');
    if (current === intent.source_index_sha256) {
      if (!a && !b) throw new Error('Retention source disappeared before commit.');
      if (a) { await checkSnapshot(c, source, move.snapshot, false); await rename(source, target); }
      else await checkSnapshot(c, target, move.snapshot, false);
    } else if (a) throw new Error('A pruned artifact path was reused; preserved.');
  }
  if (current === intent.source_index_sha256) { await atomic(c.indexPath, intent.next_index); c.index = intent.next_index; }
  for (const move of intent.moves) {
    const file = path.resolve(c.root, move.target);
    if (await stat(file)) await checkSnapshot(c, file, move.snapshot, true);
  }
  for (const move of intent.moves) {
    const file = path.resolve(c.root, move.target);
    if (await stat(file)) await rm(file, { recursive: move.snapshot.kind === 'directory' });
  }
  await rmdir(trash); await rm(pending);
}
export async function recordPackageRun(options) {
  return locked({ ...options, recoveryAllowed: options.apply !== false }, async c => {
    const report = path.resolve(c.root, options.reportPath);
    const runRoot = path.dirname(report);
    if (!within(c.paths.verification, runRoot)) throw new Error('A package report needs its own verification run directory.');
    const reportStat = await regular(c.root, report);
    const packages = [];
    for (const value of options.packagePaths ?? []) {
      const file = path.resolve(c.root, value);
      packages.push(await packageDescriptor(c, file, path.relative(c.root, report)));
    }
    if (!packages.length) throw new Error('A successful package run needs at least one delivered package.');
    const run = { owner: marker, report: path.relative(c.root, report), report_sha256: digest(await readFile(report)),
      root: path.relative(c.root, runRoot), completed_at: reportStat.mtime.toISOString(), packages, pinned: false };
    if (options.licenseRoot) {
      const license = path.resolve(c.root, options.licenseRoot);
      if (!within(c.paths.licenses, license) && !within(runRoot, license)) throw new Error('License evidence is outside its platform directory or current run.');
      await regular(c.root, path.join(license, 'manifest.json'));
      run.license = { root: path.relative(c.root, license), manifest_sha256: digest(await readFile(path.join(license, 'manifest.json'))) };
    }
    const receipt = path.join(runRoot, 'retention-run.json');
    const old = await stat(receipt);
    if (old) {
      await regular(c.root, receipt);
      const previous = await json(receipt);
      if (previous.owner !== marker || previous.report !== run.report) throw new Error('Foreign run marker; refusing to replace it.');
      run.pinned = previous.pinned === true;
    }
    run.inventory = await directoryInventory(c, runRoot, 'retention-run.json');
    run.inventory_sha256 = digest(JSON.stringify(run.inventory));
    validatePackageBoundaries(c, [...c.index.runs.filter(x => x.report !== run.report), run]);
    await atomic(receipt, run);
    c.index.runs = c.index.runs.filter(x => x.report !== run.report);
    c.index.runs.push(run);
    await atomic(c.indexPath, c.index);
    return prune(c, options.apply !== false);
  });
}
async function prune(c, apply) {
  const all = [...c.index.runs].sort((a, b) => b.completed_at.localeCompare(a.completed_at));
  const selected = new Set(all.slice(0, c.keep).map(x => x.report));
  const selectors = [];
  for (const entry of await readdir(c.paths.verification, { withFileTypes: true })) {
    if (entry.isFile() && /^latest.*\.json$/.test(entry.name)) {
      const values = []; const visit = value => { if (typeof value === 'string') values.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
      visit(await json(path.join(c.paths.verification, entry.name))); selectors.push(...values);
    }
  }
  for (const run of all) {
    const references = [run.report, ...run.packages.map(x => x.path)];
    if (selectors.some(value => references.some(ref => path.resolve(c.root, value) === path.resolve(c.root, ref))
      || run.packages.some(pkg => pkg.kind === 'directory' && within(path.resolve(c.root, pkg.path), path.resolve(c.root, value))))) selected.add(run.report);
  }
  const roots = all.map(run => resolveOwned(c, run.root, c.paths.verification));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (roots[i] === roots[j] || within(roots[i], roots[j]) || within(roots[j], roots[i])) throw new Error('Overlapping registered package runs; no cleanup performed.');
  }
  validatePackageBoundaries(c, all);
  for (const run of all) if (run.pinned) selected.add(run.report);
  // Resolve and validate the entire plan before deleting a single package.
  const plan = [], retainedPackages = new Set(all.filter(x => selected.has(x.report)).flatMap(x => x.packages.map(p => p.path)));
  for (const run of all) {
    const report = resolveOwned(c, run.report, c.paths.verification);
    const root = resolveOwned(c, run.root, c.paths.verification);
    if (path.dirname(report) !== root || run.owner !== marker) throw new Error('Invalid package run ownership.');
    await regular(c.root, report);
    if (digest(await readFile(report)) !== run.report_sha256) throw new Error('Package receipt changed; no cleanup performed.');
    const receipt = path.join(root, 'retention-run.json');
    await regular(c.root, receipt);
    const owned = await json(receipt);
    if (JSON.stringify(owned) !== JSON.stringify(run)) throw new Error('Package run marker changed.');
    if (digest(JSON.stringify(await directoryInventory(c, root, 'retention-run.json'))) !== run.inventory_sha256) throw new Error('Package report contents changed; no cleanup performed.');
    for (const pkg of run.packages) {
      await verifyPackage(c, pkg, run.report);
    }
    if (!selected.has(run.report)) plan.push({ run, report, root, packages: run.packages.filter(p => !retainedPackages.has(p.path)) });
  }
  const result = { schema_version: 1, dry_run: !apply, keep: c.keep, retained_runs: all.filter(x => selected.has(x.report)).map(x => x.report),
    remove: plan.map(x => ({ report: x.run.report, packages: x.packages.map(p => p.path) })),
    license_policy: 'Preserve current, historical manifest-bound evidence and every retained package dependency; ordinary package pruning never deletes license evidence.' };
  if (apply) {
    await quarantinePlan(c, plan);
    await atomic(path.join(c.paths.verification, 'retention-last.json'), { ...result, completed_at: new Date().toISOString() });
  }
  return result;
}
export async function pruneArtifacts(options = {}) { return locked({ ...options, recoveryAllowed: options.apply === true }, c => prune(c, options.apply === true)); }
export async function pinPackageRun(options) {
  return locked(options, async c => {
    const report = path.relative(c.root, path.resolve(c.root, options.reportPath));
    const run = c.index.runs.find(x => x.report === report);
    if (!run) throw new Error('Only registered package runs can be pinned.');
    const dir = resolveOwned(c, run.root, c.paths.verification);
    await physical(c.root, dir);
    const owned = await json(path.join(dir, 'retention-run.json'));
    if (JSON.stringify(owned) !== JSON.stringify(run)) throw new Error('Package run marker changed.');
    run.pinned = options.pinned !== false;
    await atomic(path.join(dir, 'retention-run.json'), run);
    await atomic(c.indexPath, c.index);
    return { report, pinned: run.pinned };
  });
}
async function main(args) {
  const command = args.shift(); const options = { packagePaths: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') { options.apply = true; continue; }
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    if (key === '--platform') options.platform = value;
    else if (key === '--repo-root') options.repositoryRoot = value;
    else if (key === '--report') options.reportPath = value;
    else if (key === '--package') options.packagePaths.push(value);
    else if (key === '--license-root') options.licenseRoot = value;
    else throw new Error(`Unknown option ${key}.`);
  }
  let result;
  if (command === 'record') result = await recordPackageRun(options);
  else if (command === 'apply') result = await pruneArtifacts(options);
  else if (command === 'pin' || command === 'unpin') result = await pinPackageRun({ ...options, pinned: command === 'pin' });
  else throw new Error('Usage: artifact-retention.mjs record|apply|pin|unpin [--platform PLATFORM] [--report FILE] [--package FILE] [--license-root DIR] [--apply]');
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error(`Artifact retention: ${e.message}`); process.exitCode = 1; });
