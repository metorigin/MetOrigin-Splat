import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureBundlerInputs, assertBundlerUnchanged, captureBundlerOutputs } from './BuildBundlerReceipt.mjs';

test('bundler receipt binds cached tools and offline runtime, and detects real input mutation', async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'metorigin-bundler-'));
  const write = async (name, value) => { const file = path.join(target, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); return file; };
  await write('.tauri/NSIS/Bin/makensis.exe', 'tool bytes');
  await write('.tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll', 'plugin bytes');
  const webview = await write('.tauri/x64/d6179690-e992-460b-ae64-476693dd6a91/MicrosoftEdgeWebView2RuntimeInstallerX64.exe', 'offline runtime bytes');
  const node = await write('tool/node.exe', 'actual tool');
  const input = { target, tools: [{ label: 'node.exe', file: node }] };
  const before = await captureBundlerInputs(input);
  assert.ok(before.files.every((file) => !path.isAbsolute(file.path) && !file.path.includes(target)));
  assertBundlerUnchanged(before, await captureBundlerInputs(input));
  await fs.writeFile(webview, 'changed offline runtime');
  assert.throws(() => assertBundlerUnchanged(before, { ...before, digest: '0'.repeat(64) }), /Invalid bundler receipt/);
  const changed = await captureBundlerInputs(input);
  assert.throws(() => assertBundlerUnchanged(before, changed), /changed/);
  await write('release/nsis/x64/installer.nsi', 'generated install instructions');
  const output = await captureBundlerOutputs(target);
  assert.equal(output.files[0].path, 'generated-nsis/installer.nsi');
  await fs.unlink(webview);
  await assert.rejects(captureBundlerInputs(input), /ENOENT/);
  await fs.rm(target, { recursive: true, force: true });
});
