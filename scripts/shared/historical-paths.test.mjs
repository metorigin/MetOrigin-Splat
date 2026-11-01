import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const foreign = await resolveHistoricalPath('/another/checkouts/.test-results/a', { repositoryRoot: root }); assert.equal(foreign.path, '/another/checkouts/.test-results/a'); assert.equal(foreign.migrated, false);
  await writeFile(path.join(root, 'artifacts/verification/history-paths.json'), JSON.stringify({ entries: [{ old: '.test-results', new: '../outside' }] })); await assert.rejects(resolveHistoricalPath('.test-results/a', { repositoryRoot: root }), /boundary/);
});
