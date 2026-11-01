import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTestingOutput, parseTestingOutputArguments } from './testing-output.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metorigin-output-tests-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  writeFileSync(join(root, 'packaging/shared/artifact-paths.json'), JSON.stringify({ schema_version: 1,
    root: 'artifacts', directories: { packages: 'packages', verification: 'verification', licenses: 'licenses' } }));
  return { root, options: { repositoryRoot: root, temporaryRoot: root, platform: 'macos-arm64', tool: 'fixture', keep: false } };
}

test('success publishes only a stable report and removes its disposable fixture', async t => {
  const f = fixture(t);
  const output = await createTestingOutput(f.options);
  const foreign = join(f.root, 'user-project');
  mkdirSync(foreign); writeFileSync(join(foreign, 'model.ply'), 'user bytes');
  writeFileSync(join(output.workDirectory, 'temporary-model.ply'), 'temporary');
  writeFileSync(join(output.reportDirectory, 'report.json'), '{"status":"PASS"}');
  const result = output.finish();
  assert.equal(result.reportDirectory, join(f.root, 'artifacts/verification/macos-arm64/tests/fixture/current'));
  assert.equal(existsSync(output.temporaryDirectory), false);
  assert.equal(existsSync(join(result.reportDirectory, 'debug')), false);
  assert.equal(readFileSync(join(foreign, 'model.ply'), 'utf8'), 'user bytes');
  assert.deepEqual(output.finish(), result);
});

test('latest failure and debug survive a later success, with one directory for each result', async t => {
  const f = fixture(t);
  const failed = await createTestingOutput(f.options);
  writeFileSync(join(failed.workDirectory, 'broken.ply'), 'failure diagnostic');
  writeFileSync(join(failed.reportDirectory, 'failure.json'), '{"status":"FAIL"}');
  const failure = failed.finish({ success: false });
  const success = await createTestingOutput(f.options);
  success.finish();
  assert.equal(readFileSync(join(failure.debugDirectory, 'broken.ply'), 'utf8'), 'failure diagnostic');
  const retry = await createTestingOutput(f.options);
  writeFileSync(join(retry.reportDirectory, 'new-report.txt'), 'latest');
  const latest = retry.finish();
  assert.equal(readFileSync(join(latest.reportDirectory, 'new-report.txt'), 'utf8'), 'latest');
  assert.equal(existsSync(join(failure.reportDirectory, 'failure.json')), true);
  assert.equal(existsSync(failed.temporaryDirectory), false);
});

test('explicit keep retains owned debug and copies symlinks without following them', async t => {
  const f = fixture(t);
  const output = await createTestingOutput({ ...f.options, keep: true });
  const foreign = join(f.root, 'source.ply'); writeFileSync(foreign, 'source');
  writeFileSync(join(output.workDirectory, 'owned.ply'), 'owned');
  symlinkSync(foreign, join(output.workDirectory, 'external.ply'));
  const kept = output.finish();
  assert.equal(readFileSync(join(kept.debugDirectory, 'owned.ply'), 'utf8'), 'owned');
  const next = await createTestingOutput(f.options); next.finish();
  assert.equal(readFileSync(foreign, 'utf8'), 'source');
});

test('refuses an unowned current directory and symlinked output ancestors', async t => {
  const f = fixture(t);
  const target = join(f.root, 'explicit/current'); mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'user.txt'), 'keep');
  await assert.rejects(createTestingOutput({ ...f.options, reportRoot: join(f.root, 'explicit') }), /unowned/);
  assert.equal(readFileSync(join(target, 'user.txt'), 'utf8'), 'keep');
  symlinkSync(join(f.root, 'explicit'), join(f.root, 'alias'));
  await assert.rejects(createTestingOutput({ ...f.options, reportRoot: join(f.root, 'alias/tool') }), /physical/);
});

test('explicit report overrides cannot recreate retired repository output roots', async t => {
  const f = fixture(t);
  for (const name of ['.test-results', '.artifacts', 'target/ui-source-evidence']) {
    await assert.rejects(createTestingOutput({ ...f.options, reportRoot: join(f.root, name, 'new-run') }), /retired/);
    assert.equal(existsSync(join(f.root, name)), false);
  }
});

test('refuses to clean a swapped temporary root and preserves both trees', async t => {
  const f = fixture(t);
  const output = await createTestingOutput(f.options);
  const retained = `${output.temporaryDirectory}-retained`;
  renameSync(output.temporaryDirectory, retained);
  mkdirSync(output.temporaryDirectory);
  writeFileSync(join(output.temporaryDirectory, 'user.txt'), 'keep');
  assert.throws(() => output.finish(), /unowned/);
  assert.equal(readFileSync(join(output.temporaryDirectory, 'user.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(retained), true);
});

test('publication refuses late unowned output without deleting the input or debug workspace', async t => {
  const f = fixture(t);
  const output = await createTestingOutput(f.options);
  writeFileSync(join(output.workDirectory, 'diagnostic.txt'), 'retain');
  const foreign = output.finalDirectory(); mkdirSync(foreign);
  writeFileSync(join(foreign, 'user.txt'), 'foreign');
  assert.throws(() => output.finish(), /unowned/);
  assert.equal(readFileSync(join(foreign, 'user.txt'), 'utf8'), 'foreign');
  assert.equal(readFileSync(join(output.workDirectory, 'diagnostic.txt'), 'utf8'), 'retain');
});

test('parses retention and explicit report flags without consuming fixture arguments', () => {
  const reports = join(tmpdir(), 'reports');
  assert.deepEqual(parseTestingOutputArguments(['project path', '--keep', '--report', reports], {}),
    { keep: true, reportRoot: resolve(reports), arguments: ['project path'] });
  assert.equal(parseTestingOutputArguments([], { METORIGIN_KEEP_TEST_OUTPUT: '1' }).keep, true);
  assert.equal(parseTestingOutputArguments([], { METORIGIN_KEEP_TEST_OUTPUT: '0' }).keep, false);
  assert.throws(() => parseTestingOutputArguments(['--report'], {}), /Missing/);
});

for (const [script, tool] of [['Validate-GaussianPreview.mjs', 'gaussian-preview'], ['Validate-ModelEditor.mjs', 'model-editor']]) {
  test(`${tool} bootstrap failure retains only owned fixtures without connecting to the app`, t => {
    const f = fixture(t);
    const source = join(f.root, 'user-input'); mkdirSync(source);
    const original = '{"id":"original-input","name":"read-only source"}';
    writeFileSync(join(source, 'project.json'), original);
    const reportRoot = join(f.root, 'explicit-reports');
    const runner = fileURLToPath(new URL(`../windows/${script}`, import.meta.url));
    // Missing scene.ply stops in fixture setup, before CDP, training or edits.
    const result = spawnSync(process.execPath, [runner, source, '--report', reportRoot], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(join(source, 'project.json'), 'utf8'), original);
    assert.equal(JSON.parse(readFileSync(join(reportRoot, 'failed/runner-failure.json'))).status, 'FAIL');
    assert.equal(existsSync(join(reportRoot, 'failed/debug')), true);
    assert.equal(JSON.parse(readFileSync(join(reportRoot, 'failed/output-lifecycle.json'))).tool, tool);
  });
}
