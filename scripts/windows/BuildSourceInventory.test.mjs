import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureInputs, assertUnchanged, captureOutputs } from './BuildSourceInventory.mjs';
import { repository } from './AlignmentPack.mjs';
import { themeInputs } from '../../integrations/supersplat/ui-theme/apply.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metorigin-source-proof-'));
  const write = async (name, text) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; };
  await write('Cargo.lock', 'actual locked dependencies');
  await write('apps/desktop/src/main.tsx', 'actual frontend');
  await write('crates/splat-hardware/src/locator.rs', 'actual Rust');
  await write('apps/desktop/public/supersplat/index.js', 'prepared public asset');
  await write('scripts/shared/verify-ui-sources.mjs', 'actual hook');
  await write('integrations/supersplat/prepare.mjs', 'actual preparer');
  await write('packaging/windows-x64/alignment-lock.json', '{}');
  await write('docs/unrelated.md', 'not an application build input');
  await write('apps/desktop/node_modules/private.json', 'must not enter source proof');
  await write('integrations/supersplat/.env', 'must not enter source proof');
  await write('target/private.json', 'must not enter source proof');
  await write('integrations/supersplat/evidence/run.log', 'must not enter source proof');
  const configuration = await write('target/generated/tauri.conf.json', '{"identifier":"isolated"}');
  const pack = path.join(root, 'target/pack');
  await write('target/pack/engines/brush/bin/brush-cli.exe', 'actual frozen binary bytes');
  await write('target/pack/licenses/brush/LICENSE', 'actual shipped license');
  return { root, pack, configuration, write };
}

test('inventory binds real source, prepared assets, selected resources and config without private/unrelated trees', async () => {
  const input = await fixture();
  const before = await captureInputs(input);
  assert.ok(before.files.some((file) => file.path === 'crates/splat-hardware/src/locator.rs'));
  assert.ok(before.files.some((file) => file.kind === 'resource' && file.path === 'engines/brush/bin/brush-cli.exe'));
  assert.ok(before.files.some((file) => file.path === 'apps/desktop/public/supersplat/index.js'));
  assert.ok(before.files.every((file) => !path.isAbsolute(file.path) && !file.path.includes('private') && !file.path.includes('unrelated') && !file.path.endsWith('.env') && !file.path.endsWith('.log')));
  await input.write('docs/unrelated.md', 'unrelated edit');
  await input.write('target/private.json', 'private edit');
  assertUnchanged(before, await captureInputs(input));
  await input.write('apps/desktop/src/main.tsx', 'changed during hook');
  const changed = await captureInputs(input);
  assert.throws(() => assertUnchanged(before, changed), /Build inputs changed.*main.tsx/);
  assert.throws(() => assertUnchanged(before, { ...before, schema_version: 9 }), /Invalid build source/);
  assert.throws(() => assertUnchanged({ ...before, digest: 'changed' }, before), /Invalid build source/);
  assertUnchanged(before, before);
});

test('new/deleted code and changed resource/config inputs prevent publication evidence', async () => {
  for (const change of [
    (input) => input.write('apps/desktop/src/new.ts', 'new source file'),
    (input) => fs.unlink(path.join(input.root, 'crates/splat-hardware/src/locator.rs')),
    (input) => input.write('target/pack/engines/brush/bin/brush-cli.exe', 'changed resource'),
    (input) => fs.writeFile(input.configuration, 'changed configuration'),
  ]) {
    const input = await fixture();
    const before = await captureInputs(input);
    await change(input);
    const after = await captureInputs(input);
    assert.throws(() => assertUnchanged(before, after), /Build inputs changed/);
  }
});

test('output inventory binds built frontend payload and application separately from source', async () => {
  const input = await fixture();
  await input.write('apps/desktop/dist/assets/main.js', 'actual output');
  const application = await input.write('target/build/MetOrigin Splat Alignment Candidate.exe', 'actual app');
  const output = await captureOutputs({ root: input.root, application });
  assert.deepEqual(output.files.map((file) => file.kind).sort(), ['application_output', 'frontend_output']);
  assert.ok(output.files.every((file) => !file.path.startsWith('target/')));
  const changed = structuredClone(output);
  changed.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertUnchanged(changed, output), /Invalid build source/);
});

test('missing required lock/resources/outputs fail rather than creating incomplete proof', async () => {
  const input = await fixture();
  await fs.unlink(path.join(input.root, 'Cargo.lock'));
  await assert.rejects(captureInputs(input), /Required application lock/);
  const application = await input.write('target/build/candidate.exe', 'actual app');
  await assert.rejects(captureOutputs({ root: input.root, application }), /Built frontend payload is missing/);
});

test('direct prebuild dependencies bind patches, notices, compressed overlay, curated logs and selected font files', async () => {
  const input = await fixture();
  await input.write('patches/example.patch', 'actual pnpm dependency patch');
  await input.write('apps/desktop/ui-sources.json', JSON.stringify({ sourceGroups: [{ licenseFiles: [], noticeFiles: ['src/components/ui/jan-MODIFICATIONS.md'] }] }));
  await input.write('apps/desktop/src/components/ui/jan-MODIFICATIONS.md', 'actual required notice');
  const integration = 'integrations/supersplat';
  await fs.cp(path.join(repository, integration, 'webp-overlay-3.10.2'), path.join(input.root, integration, 'webp-overlay-3.10.2'), { recursive: true });
  await fs.cp(path.join(repository, integration, 'ui-theme'), path.join(input.root, integration, 'ui-theme'), { recursive: true });
  for (const file of await themeInputs(path.join(repository, integration))) {
    if (!file.path.startsWith(`${integration}/ui-theme/`)) await input.write(file.path, await fs.readFile(path.join(repository, file.path)));
  }
  const before = await captureInputs(input);
  const selected = before.files.map((file) => file.path);
  for (const name of ['patches/example.patch', 'apps/desktop/src/components/ui/jan-MODIFICATIONS.md', `${integration}/ui-theme/README.md`,
    'apps/desktop/node_modules/@fontsource-variable/inter/LICENSE']) assert.ok(selected.includes(name), name);
  const payload = selected.find((name) => name.startsWith(`${integration}/webp-overlay-3.10.2/payload/`) && name.endsWith('.gz'));
  const log = selected.find((name) => name.startsWith(`${integration}/webp-overlay-3.10.2/evidence/`) && name.endsWith('.log'));
  assert.ok(payload && log);
  assert.ok(!selected.includes('integrations/supersplat/evidence/run.log'));
  assert.ok(!selected.includes('apps/desktop/node_modules/private.json'));
  for (const name of ['patches/example.patch', 'apps/desktop/src/components/ui/jan-MODIFICATIONS.md', `${integration}/ui-theme/README.md`,
    'apps/desktop/node_modules/@fontsource-variable/inter/LICENSE', log]) {
    const full = path.join(input.root, name);
    const bytes = await fs.readFile(full);
    await fs.appendFile(full, '\nchanged during build');
    const changed = await captureInputs(input);
    assert.throws(() => assertUnchanged(before, changed), /Build inputs changed/);
    await fs.writeFile(full, bytes);
  }
  await fs.appendFile(path.join(input.root, payload), 'tampered');
  await assert.rejects(captureInputs(input), /compressed payload hash mismatch/);
});

test('UI provenance references cannot escape the application source directory', async () => {
  const input = await fixture();
  await input.write('apps/desktop/ui-sources.json', JSON.stringify({ sourceGroups: [{ noticeFiles: ['../../private.json'] }] }));
  await assert.rejects(captureInputs(input), /reference escapes/);
});
