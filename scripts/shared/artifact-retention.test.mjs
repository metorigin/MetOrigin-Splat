import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordPackageRun, pruneArtifacts, pinPackageRun } from './artifact-retention.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact retention 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packaging/shared'), { recursive: true });
  await writeFile(path.join(root, 'packaging/shared/artifact-paths.json'), JSON.stringify({ schema_version: 1, root: 'artifacts', directories: { packages: 'packages', verification: 'verification', licenses: 'licenses' }, retention: { packages: 2 } }));
  const options = { repositoryRoot: root, platform: 'macos-arm64' };
  const verification = path.join(root, 'artifacts/verification/macos-arm64');
  const packages = path.join(root, 'artifacts/packages/macos-arm64');
  const run = async (id, apply = false) => {
    const reportPath = path.join(verification, `build.${id}`, 'final.json');
    const pkg = path.join(packages, `${id}.dmg`);
    await mkdir(path.dirname(reportPath), { recursive: true }); await mkdir(packages, { recursive: true });
    await writeFile(reportPath, JSON.stringify({ dmg: { path: pkg } })); await writeFile(pkg, `verified ${id}`);
    const time = new Date(1700000000000 + id * 10000); await utimes(reportPath, time, time);
    await recordPackageRun({ ...options, reportPath, packagePaths: [pkg], apply });
    return { reportPath, pkg };
  };
  return { root, options, verification, packages, run };
}
const exists = file => lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
test('repository default and omitted retention keep only the latest package with its matching report', async t => {
  const policy = JSON.parse(await readFile(new URL('../../packaging/shared/artifact-paths.json', import.meta.url), 'utf8'));
  assert.equal(policy.retention.packages, 1);
  for (const useRepositoryPolicy of [true, false]) await t.test(useRepositoryPolicy ? 'configured policy' : 'omitted policy fallback', async t => {
    const f = await fixture(t);
    const configPath = path.join(f.root, 'packaging/shared/artifact-paths.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (useRepositoryPolicy) config.retention = policy.retention;
    else delete config.retention;
    await writeFile(configPath, JSON.stringify(config));
    const previous = await f.run(1);
    const current = await f.run(2, true);
    assert.equal(await exists(previous.pkg), false);
    assert.equal(await exists(previous.reportPath), false);
    assert(await exists(current.pkg));
    assert(await exists(current.reportPath));
    assert.equal((await pruneArtifacts(f.options)).keep, 1);
  });
});
test('dry run changes no packages; apply keeps two matching reports and releases its lock', async t => {
  const f = await fixture(t); const a = await f.run(1); await f.run(2); await f.run(3);
  const plan = await pruneArtifacts(f.options); assert.equal(plan.remove.length, 1); assert(await exists(a.pkg));
  await pruneArtifacts({ ...f.options, apply: true }); assert.equal(await exists(a.pkg), false); assert.equal(await exists(a.reportPath), false);
  assert.equal((await pruneArtifacts(f.options)).remove.length, 0);
});
test('automatic record prunes old packages but preserves latest-selector and pinned runs', async t => {
  const f = await fixture(t); const a = await f.run(1); await pinPackageRun({ ...f.options, reportPath: a.reportPath });
  const b = await f.run(2); await writeFile(path.join(f.verification, 'latest-full.json'), JSON.stringify({ package: b.pkg }));
  await f.run(3); await f.run(4, true); assert(await exists(a.pkg)); assert(await exists(b.pkg));
  await pinPackageRun({ ...f.options, reportPath: a.reportPath, pinned: false }); await pruneArtifacts({ ...f.options, apply: true }); assert.equal(await exists(a.pkg), false); assert(await exists(b.pkg));
});
test('changed delivery or receipt blocks the entire plan before any deletion', async t => {
  const f = await fixture(t); const a = await f.run(1); const b = await f.run(2); await f.run(3);
  await writeFile(b.pkg, 'user changed bytes'); await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /package changed/); assert(await exists(a.pkg)); assert(await exists(a.reportPath));
});
test('foreign markers are not deleted', async t => {
  const f = await fixture(t); const a = await f.run(1); await f.run(2); await f.run(3);
  await writeFile(path.join(path.dirname(a.reportPath), 'retention-run.json'), '{"owner":"foreign"}');
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /marker changed/); assert(await exists(a.pkg));
});

test('symlinked package files are not deleted', async t => {
  const f = await fixture(t); const a = await f.run(1); await rm(a.pkg); const external = path.join(f.root, 'user-file'); await writeFile(external, 'keep');
  try { await symlink(external, a.pkg); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Windows file symlinks require Developer Mode or symbolic-link privileges.');
    return;
  }
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /physical artifact file/); assert.equal(await readFile(external, 'utf8'), 'keep');
});
test('license current and run-local license evidence are accepted; standalone evidence survives pruning', async t => {
  const f = await fixture(t); const a = await f.run(1); const current = path.join(f.root, 'artifacts/licenses/macos-arm64/current');
  await mkdir(current, { recursive: true }); await writeFile(path.join(current, 'manifest.json'), '{}');
  await recordPackageRun({ ...f.options, reportPath: a.reportPath, packagePaths: [a.pkg], licenseRoot: current, apply: false });
  const b = await f.run(2); const embedded = path.join(path.dirname(b.reportPath), 'metadata/licenses'); await mkdir(embedded, { recursive: true }); await writeFile(path.join(embedded, 'manifest.json'), '{}');
  await recordPackageRun({ ...f.options, reportPath: b.reportPath, packagePaths: [b.pkg], licenseRoot: embedded, apply: false }); await f.run(3, true);
  assert(await exists(path.join(current, 'manifest.json'))); assert(await exists(path.join(embedded, 'manifest.json')));
});
test('unregistered files stay intact and escaped index paths cannot be pruned', async t => {
  const f = await fixture(t); const a = await f.run(1); const user = path.join(f.packages, 'notes.txt'); await writeFile(user, 'keep');
  const index = path.join(f.verification, 'retention-index.json'); const data = JSON.parse(await readFile(index)); data.runs[0].root = '../outside'; await writeFile(index, JSON.stringify(data));
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /escapes/); assert(await exists(a.pkg)); assert.equal(await readFile(user, 'utf8'), 'keep');
});
test('owned delivery directories prune portable content and reject unrecorded additions', async t => {
  const f = await fixture(t); const a = await f.run(1); const dir = path.join(f.packages, 'build.1'); await mkdir(path.join(dir, 'portable'), { recursive: true });
  await writeFile(path.join(dir, 'portable/app.exe'), 'verified app'); await writeFile(path.join(dir, 'checksums.json'), '{}');
  await recordPackageRun({ ...f.options, reportPath: a.reportPath, packagePaths: [dir], apply: false }); await f.run(2); await f.run(3);
  await writeFile(path.join(dir, 'user-note'), 'keep until reviewed'); await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /package changed/); assert(await exists(a.reportPath));
  await rm(path.join(dir, 'user-note')); await pruneArtifacts({ ...f.options, apply: true }); assert.equal(await exists(dir), false); assert.equal(await exists(a.reportPath), false);
});
test('registry cannot inject an unregistered package or override the authoritative run marker', async t => {
  const f = await fixture(t); const a = await f.run(1); await f.run(2); await f.run(3); const user = path.join(f.packages, 'user.dmg'); await writeFile(user, 'user bytes');
  const index = path.join(f.verification, 'retention-index.json'); const data = JSON.parse(await readFile(index));
  data.runs[0].packages[0].path = path.relative(f.root, user); data.runs[0].packages[0].sha256 = (await import('node:crypto')).createHash('sha256').update('user bytes').digest('hex'); await writeFile(index, JSON.stringify(data));
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /marker changed/); assert(await exists(a.pkg)); assert(await exists(user));
});
test('unregistered report additions block cleanup and overlapping delivery directories are rejected', async t => {
  const f = await fixture(t); const a = await f.run(1); await f.run(2); await f.run(3); await writeFile(path.join(path.dirname(a.reportPath), 'user-note'), 'preserve');
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /report contents changed/); assert(await exists(a.pkg));
  const f2 = await fixture(t); const one = await f2.run(1); const nested = path.join(f2.packages, 'parent/child'); await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, 'app.exe'), 'app');
  await recordPackageRun({ ...f2.options, reportPath: one.reportPath, packagePaths: [nested], apply: false }); const two = await f2.run(2);
  await assert.rejects(recordPackageRun({ ...f2.options, reportPath: two.reportPath, packagePaths: [path.dirname(nested)], apply: false }), /Overlapping/); assert(await exists(path.join(nested, 'app.exe')));
});
test('interrupted quarantine resumes and commits only the registered expired run', async t => {
  const f = await fixture(t); const a = await f.run(1); await f.run(2); await f.run(3);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const indexPath = path.join(f.verification, 'retention-index.json'); const previous = JSON.parse(await readFile(indexPath)); const expired = previous.runs.find(x => x.report === path.relative(f.root, a.reportPath));
  const next = { ...previous, runs: previous.runs.filter(x => x !== expired) }; const trash = path.join(f.verification, '.retention-trash/interrupted'); await mkdir(trash, { recursive: true });
  const entries = [];
  for (const name of ['final.json', 'retention-run.json']) entries.push({ path: name, kind: 'file', sha256: hash(await readFile(path.join(path.dirname(a.reportPath), name))) });
  const moves = [{ source: path.relative(f.root, a.pkg), target: path.relative(f.root, path.join(trash, '0')), snapshot: { kind: 'file', sha256: hash(await readFile(a.pkg)) } }, { source: expired.root, target: path.relative(f.root, path.join(trash, '1')), snapshot: { kind: 'directory', entries } }];
  await (await import('node:fs/promises')).rename(a.pkg, path.join(trash, '0'));
  await writeFile(path.join(f.verification, 'retention-pending.json'), JSON.stringify({ owner: previous.owner, previous_index: previous, source_index_sha256: hash(JSON.stringify(previous)), next_index_sha256: hash(JSON.stringify(next)), next_index: next, trash: path.relative(f.root, trash), moves }));
  const lock = path.join(f.verification, '.retention-lock'); await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ owner: previous.owner, pid: 99999999, token: 'dead-process-fixture' }));
  await assert.rejects(pruneArtifacts(f.options), /requires --apply/); assert(await exists(path.join(trash, '0'))); assert(await exists(a.reportPath));
  await pruneArtifacts({ ...f.options, apply: true }); assert.equal(await exists(a.pkg), false); assert.equal(await exists(a.reportPath), false); assert.equal(await exists(trash), false); assert.equal(await exists(path.join(f.verification, 'retention-pending.json')), false);
  assert.equal(JSON.parse(await readFile(indexPath)).runs.length, 2);
  // A crash after deleting trash but before removing the intent is an idempotent terminal state.
  await writeFile(path.join(f.verification, 'retention-pending.json'), JSON.stringify({ owner: previous.owner, previous_index: previous, source_index_sha256: hash(JSON.stringify(previous)), next_index_sha256: hash(JSON.stringify(next)), next_index: next, trash: path.relative(f.root, trash), moves }));
  await pruneArtifacts({ ...f.options, apply: true }); assert.equal(await exists(path.join(f.verification, 'retention-pending.json')), false);
});
test('a linked retention lock is never followed or removed', async t => {
  const f = await fixture(t); await f.run(1); const foreign = path.join(f.root, 'foreign'); await mkdir(foreign);
  const owner = JSON.stringify({ owner: 'metorigin-package-retention-v1', pid: 99999999, token: 'foreign' }); await writeFile(path.join(foreign, 'owner.json'), owner);
  await symlink(foreign, path.join(f.verification, '.retention-lock'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pruneArtifacts({ ...f.options, apply: true }), /physical directory/); assert.equal(await readFile(path.join(foreign, 'owner.json'), 'utf8'), owner);
});
