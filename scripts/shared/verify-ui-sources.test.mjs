import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyUiSources } from './verify-ui-sources.mjs';

test('UI source verification publishes evidence but removes copied temporary source data', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-ui-output-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await verifyUiSources({ reportRoot: join(root, 'reports'), temporaryRoot: root, keep: false });
  assert.ok(result.evidence.components.length);
  assert.equal(existsSync(result.temporaryDirectory), false);
  assert.equal(existsSync(join(result.reportDirectory, 'source-evidence.json')), true);
  assert.equal(existsSync(join(result.reportDirectory, 'debug')), false);
});

test('invalid UI source retains failure evidence in the failure slot', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-ui-invalid-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  writeFileSync(join(root, 'packaging/shared/artifact-paths.json'), JSON.stringify({ schema_version: 1, root: 'artifacts',
    directories: { packages: 'packages', verification: 'verification', licenses: 'licenses' } }));
  mkdirSync(join(root, 'apps/desktop'), { recursive: true });
  writeFileSync(join(root, 'apps/desktop/ui-sources.json'), '{"components":[]}');
  await assert.rejects(verifyUiSources({ repositoryRoot: root, temporaryRoot: root, platform: 'macos-arm64', keep: false }), /empty/);
  const failed = join(root, 'artifacts/verification/macos-arm64/tests/ui-sources/failed');
  assert.equal(JSON.parse(readFileSync(join(failed, 'failure.json'))).status, 'FAIL');
  assert.equal(existsSync(join(failed, 'debug')), true);
});
