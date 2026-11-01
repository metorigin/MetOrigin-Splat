import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveHistoricalPath } from './historical-paths.mjs';
test('historical receipt paths resolve by longest prefix without symlinks or rewriting the receipt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'history paths ')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packaging/shared'), { recursive: true }); await writeFile(path.join(root, 'packaging/shared/artifact-paths.json'), JSON.stringify({ schema_version: 1, root: 'artifacts', directories: { packages: 'packages', verification: 'verification', licenses: 'licenses' } }));
  await mkdir(path.join(root, 'artifacts/verification/archive/narrow'), { recursive: true }); await writeFile(path.join(root, 'artifacts/verification/archive/narrow/receipt.json'), '{"original":".test-results/run/receipt.json"}');
  await writeFile(path.join(root, 'artifacts/verification/history-paths.json'), JSON.stringify({ original_repository_root: '/old/checkout', entries: [{ old: '.test-results', new: 'artifacts/verification/archive' }, { old: '.test-results/run', new: 'artifacts/verification/archive/narrow' }] }));
  const value = await resolveHistoricalPath('/old/checkout/.test-results/run/receipt.json', { repositoryRoot: root }); assert.equal(value.path, path.join(root, 'artifacts/verification/archive/narrow/receipt.json')); assert(value.exists); assert(value.migrated);
  const foreign = await resolveHistoricalPath('/another/checkouts/.test-results/a', { repositoryRoot: root }); assert.equal(foreign.path, path.resolve(root, '/another/checkouts/.test-results/a')); assert.equal(foreign.migrated, false);
  assert.equal(await readFile(value.path, 'utf8'), '{"original":".test-results/run/receipt.json"}');
  await writeFile(path.join(root, 'artifacts/verification/history-paths.json'), JSON.stringify({ entries: [{ old: '.test-results', new: '../outside' }] })); await assert.rejects(resolveHistoricalPath('.test-results/a', { repositoryRoot: root }), /boundary/);
});

test('recorded Windows paths map independently of the host drive and reject foreign or escaping prefixes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cross-drive history ')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packaging/shared'), { recursive: true });
  await writeFile(path.join(root, 'packaging/shared/artifact-paths.json'), JSON.stringify({ schema_version: 1, root: 'artifacts', directories: { packages: 'packages', verification: 'verification', licenses: 'licenses' } }));
  const target = path.join(root, 'artifacts/verification/archive'); await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'receipt.json'), 'original receipt');
  await writeFile(path.join(root, 'artifacts/verification/history-paths.json'), JSON.stringify({ original_repository_root: 'Z:\\old\\checkout', entries: [{ old: '.test-results', new: 'artifacts/verification/archive' }] }));
  const value = await resolveHistoricalPath('z:\\OLD\\checkout\\.test-results\\receipt.json', { repositoryRoot: root });
  assert.equal(value.path, path.join(target, 'receipt.json')); assert(value.exists); assert(value.migrated);
  for (const input of ['Y:\\old\\checkout\\.test-results\\receipt.json', 'Z:\\old\\checkout-extra\\.test-results\\receipt.json', 'Z:\\old\\checkout\\..\\..\\.test-results\\receipt.json']) {
    const foreign = await resolveHistoricalPath(input, { repositoryRoot: root }); assert.equal(foreign.migrated, false);
  }
  assert.equal(await readFile(value.path, 'utf8'), 'original receipt');
});
