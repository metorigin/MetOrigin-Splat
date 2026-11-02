import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { captureBuildToolInputs, captureBundlerInputs, assertBundlerUnchanged, captureBundlerOutputs } from './BuildBundlerReceipt.mjs';

const oldGuid = 'd6179690-e992-460b-ae64-476693dd6a91';
const newGuid = 'd5cc3c1c-bb59-4158-aedc-db0035e44466';
const filename = 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe';
const nsisLiteral = value => value.replace(/["$`\n\t\r]/g, char => ({ '"': '$\\"', $: '$$', '`': '$\\`', '\n': '$\\n', '\t': '$\\t', '\r': '$\\r' })[char]);

async function fixture(context) {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'metorigin-bundler-'));
  context.after(() => fs.rm(target, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(target, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  await write('.tauri/NSIS/Bin/makensis.exe', 'tool bytes');
  await write('.tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll', 'plugin bytes');
  await fs.mkdir(path.join(target, '.tauri/x64'), { recursive: true });
  const node = await write('tool/node.exe', 'actual tool');
  const runtime = (guid, value = `runtime ${guid}`) => write(`.tauri/x64/${guid}/${filename}`, value);
  const script = async selected => write('release/nsis/x64/installer.nsi', [
    '\uFEFF!define INSTALLWEBVIEW2MODE "offlineInstaller"',
    `!define WEBVIEW2INSTALLERPATH "${nsisLiteral(selected)}"`,
    'File "/oname=$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"',
    '',
  ].join('\n'));
  return { target, write, runtime, script, input: { target, tools: [{ label: 'node.exe', file: node }] } };
}

test('a new Evergreen GUID works without the historical runtime and binds the actual NSIS selection', async context => {
  const { target, runtime, script, input } = await fixture(context);
  const selected = await runtime(newGuid);
  const before = await captureBundlerInputs(input);
  assert.ok(before.files.some(file => file.path === `webview2/${newGuid}/${filename}`));
  assert.ok(before.files.every(file => !path.isAbsolute(file.path) && !file.path.includes(target)));
  assertBundlerUnchanged(before, await captureBundlerInputs(input));
  await script(selected);
  const output = await captureBundlerOutputs(target, before);
  assert.equal(output.files[0].path, 'generated-nsis/installer.nsi');
});

test('every cached GUID is frozen and changing the selected newer runtime is detected', async context => {
  const { target, runtime, script, input } = await fixture(context);
  await runtime(oldGuid);
  const selected = await runtime(newGuid);
  const before = await captureBundlerInputs(input);
  assert.equal(before.files.filter(file => file.path.startsWith('webview2/')).length, 2);
  await script(selected);
  await captureBundlerOutputs(target, before);
  await fs.writeFile(selected, 'changed newer offline runtime');
  assert.throws(() => assertBundlerUnchanged(before, { ...before, digest: '0'.repeat(64) }), /Invalid bundler receipt/);
  const changed = await captureBundlerInputs(input);
  assert.throws(() => assertBundlerUnchanged(before, changed), /Bundler inputs changed/);
  await assert.rejects(captureBundlerOutputs(target, before), /differs from its frozen input/);
});

test('newly downloaded and deleted runtimes change the frozen input set', async context => {
  const { runtime, input } = await fixture(context);
  const old = await runtime(oldGuid);
  const before = await captureBundlerInputs(input);
  const added = await runtime(newGuid);
  const withNewRuntime = await captureBundlerInputs(input);
  assert.throws(() => assertBundlerUnchanged(before, withNewRuntime), /Bundler inputs changed/);
  await fs.unlink(old);
  const deleted = await captureBundlerInputs(input);
  assert.throws(() => assertBundlerUnchanged(withNewRuntime, deleted), /Bundler inputs changed/);
  await fs.unlink(added);
  await assert.rejects(captureBundlerInputs(input), /Offline WebView2 runtime cache is missing/);
});

test('an empty runtime cache fails instead of freezing incomplete inputs', async context => {
  const { input } = await fixture(context);
  await assert.rejects(captureBundlerInputs(input), /Offline WebView2 runtime cache is missing/);
});

test('application build tools can be frozen with no runtime cache and later tool changes are rejected', async context => {
  const { input } = await fixture(context);
  const before = await captureBuildToolInputs(input.tools);
  assert.deepEqual(before.files.map(file => file.path), ['tools/node.exe']);
  await fs.writeFile(input.tools[0].file, 'different compiler or launcher during build');
  const after = await captureBuildToolInputs(input.tools);
  assert.throws(() => assertBundlerUnchanged(before, after), /Bundler inputs changed/);
});

test('generated NSIS cannot select an unfrozen runtime or a path outside the tool cache', async context => {
  const { target, runtime, script, input, write } = await fixture(context);
  await runtime(oldGuid);
  const before = await captureBundlerInputs(input);
  const selected = await runtime(newGuid);
  await script(selected);
  await assert.rejects(captureBundlerOutputs(target, before), /unfrozen WebView2 runtime/);
  await script(await write(`outside/${filename}`, 'unrelated runtime'));
  await assert.rejects(captureBundlerOutputs(target, before), /outside the frozen runtime cache/);
});

test('generated NSIS must actually embed its selected runtime with the pinned template contract', async context => {
  const { target, runtime, script, input } = await fixture(context);
  const selected = await runtime(newGuid);
  const before = await captureBundlerInputs(input);
  const generated = await script(selected);
  const original = await fs.readFile(generated, 'utf8');
  for (const invalid of [original.replace(/^File .*$/m, '; no embedded runtime'),
    original.replace('"offlineInstaller"', '"skip"'),
    `${original}!define WEBVIEW2INSTALLERPATH "${nsisLiteral(selected)}"\n`]) {
    await fs.writeFile(generated, invalid);
    await assert.rejects(captureBundlerOutputs(target, before), /must embed exactly one/);
  }
});

test('NSIS escaped dollar signs, backticks, Unicode and spaces preserve the actual runtime path', async context => {
  const { target, runtime, script, input } = await fixture(context);
  const selected = await runtime(newGuid);
  const parent = path.join(target, '中文 $ cache ` with spaces');
  await fs.mkdir(parent);
  const relocated = path.join(parent, 'build');
  await fs.mkdir(relocated);
  await fs.rename(path.join(target, '.tauri'), path.join(relocated, '.tauri'));
  const before = await captureBundlerInputs({ target: relocated, tools: input.tools });
  const current = path.join(relocated, path.relative(target, selected));
  const generated = await script(current);
  await fs.mkdir(path.join(relocated, 'release/nsis/x64'), { recursive: true });
  await fs.copyFile(generated, path.join(relocated, 'release/nsis/x64/installer.nsi'));
  await captureBundlerOutputs(relocated, before);
});

test('cold candidate orchestration prepares tools before freezing, builds once and refuses unverified publication', { skip: process.platform !== 'win32' }, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metorigin-cold-bundler-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, text) => { const full = path.join(root, name); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, text); return full; };
  const builder = await write('scripts/windows/Build-AlignmentCandidate.ps1', await fs.readFile(new URL('./Build-AlignmentCandidate.ps1', import.meta.url), 'utf8'));
  await write('package.json', '{"version":"0.1.0"}');
  await write('apps/desktop/package.json', '{"version":"0.1.0"}');
  await write('scripts/windows/Packaging.Common.ps1', String.raw`
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:fixtureRoot = $env:METORIGIN_BUNDLER_FIXTURE
function Get-MetOriginRepositoryRoot { return $script:fixtureRoot }
function Get-MetOriginWindowsPath { param($Key); return Join-Path $script:fixtureRoot $Key }
function Get-MetOriginWindowsDefaultPath { param($Key); return Join-Path $script:fixtureRoot $Key }
function Resolve-MetOriginPath { param($Path); if ([IO.Path]::IsPathRooted($Path)) { return $Path }; return Join-Path $script:fixtureRoot $Path }
function Assert-MetOriginChildPath { param($Path,$Parent); if (-not $Path.StartsWith($Parent + [IO.Path]::DirectorySeparatorChar)) { throw 'escaped fixture' }; return $Path }
function Get-Command { [CmdletBinding()]param($Name); if ($Name -eq 'node.exe') { return @{Source=(Join-Path $script:fixtureRoot 'fake-node.ps1')} }; if ($Name -eq 'pnpm.cmd') { return @{Source=(Join-Path $script:fixtureRoot 'fake-pnpm.ps1')} }; throw 'unexpected tool' }
function rustc { $global:LASTEXITCODE=0; if ($args[0] -eq '--version') { return 'rustc 1.97.0 (fixture)' }; return (Join-Path $script:fixtureRoot 'compiler') }
`);
  await write('scripts/windows/Test-AlignmentEnginePack.ps1', String.raw`Add-Content -LiteralPath $env:METORIGIN_BUNDLER_EVENTS -Value 'verify-pack' -Encoding UTF8; $global:LASTEXITCODE=0`);
  await write('fake-node.ps1', String.raw`
$global:LASTEXITCODE=0
function Event($Name) { Add-Content -LiteralPath $env:METORIGIN_BUNDLER_EVENTS -Value $Name -Encoding UTF8 }
if ($args[0] -eq '--version') { Write-Output 'v26.13.0'; return }
switch (Split-Path -Leaf $args[0]) {
 'AlignmentPack.mjs' { $file=$args[[Array]::IndexOf($args,'--config')+1]; New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null; Set-Content -LiteralPath $file -Value '{"version":"0.1.0","mainBinaryName":"MetOrigin Splat"}' -Encoding UTF8 }
 'BuildSourceInventory.mjs' { if ($args[1] -eq 'capture') { Event 'freeze-source' } else { Event 'verify-source' } }
 'BundleIdentity.mjs' { Event 'bind-application' }
 'BuildBundlerReceipt.mjs' {
  switch ($args[1]) {
   'capture-tools' { Event 'freeze-build-tools' }
   'verify-tools' { Event 'verify-build-tools' }
   'capture' { if (-not (Test-Path -LiteralPath (Join-Path $env:CARGO_TARGET_DIR '.tauri/ready'))) { throw 'attempted cold capture' }; Event 'freeze-tools' }
   'verify' { Event 'verify-tools'; $global:LASTEXITCODE=17 }
  }
 }
 default { throw 'unexpected node script' }
}
`);
  await write('fake-pnpm.ps1', String.raw`
$global:LASTEXITCODE=0
function Event($Name) { Add-Content -LiteralPath $env:METORIGIN_BUNDLER_EVENTS -Value $Name -Encoding UTF8 }
if ($args[0] -eq '--version') { Write-Output '11.12.0'; return }
if ($args[0] -eq 'prepare:supersplat') { Event 'prepare-assets'; return }
if ($args -contains 'build') {
 Event 'compile'; $dir=Join-Path $env:CARGO_TARGET_DIR 'release'; New-Item -ItemType Directory -Path $dir -Force | Out-Null; Set-Content -LiteralPath (Join-Path $dir 'MetOrigin Splat.exe') -Value 'fixture'
 if ($env:METORIGIN_BUNDLER_LINK_PHASE -eq 'after-compile') {
  $out=Join-Path $dir 'bundle/nsis'; New-Item -ItemType Directory -Path (Split-Path -Parent $out) -Force | Out-Null
  New-Item -ItemType Junction -Path $out -Target $env:METORIGIN_BUNDLER_EXTERNAL | Out-Null
 }; return
}
if ($args -contains 'bundle') {
 $prior=@(Get-Content -LiteralPath $env:METORIGIN_BUNDLER_EVENTS | Where-Object { $_ -eq 'bundle' }).Count; Event 'bundle'
 if ($env:METORIGIN_BUNDLER_FAIL_PREPARE -eq '1') { $global:LASTEXITCODE=18; return }
 $tools=Join-Path $env:CARGO_TARGET_DIR '.tauri'; New-Item -ItemType Directory -Path $tools -Force | Out-Null; Set-Content -LiteralPath (Join-Path $tools 'ready') -Value 'tools'
 $out=Join-Path $env:CARGO_TARGET_DIR 'release/bundle/nsis'
 if ($prior -eq 0 -and $env:METORIGIN_BUNDLER_LINK_PHASE -eq 'after-prepare') {
  New-Item -ItemType Directory -Path (Split-Path -Parent $out) -Force | Out-Null
  New-Item -ItemType Junction -Path $out -Target $env:METORIGIN_BUNDLER_EXTERNAL | Out-Null
 } else { New-Item -ItemType Directory -Path $out -Force | Out-Null }
 if ($prior -eq 0) { Set-Content -LiteralPath (Join-Path $out 'preparation.exe') -Value 'unpublished' } else {
  if (Test-Path -LiteralPath (Join-Path $out 'preparation.exe')) { throw 'unpublished preparation installer was not removed' }; Set-Content -LiteralPath (Join-Path $out 'final.exe') -Value 'final'
 }; return
}
throw 'unexpected pnpm command'
`);
  for (const failPreparation of [false, true]) {
    const events = path.join(root, failPreparation ? 'prepare-failure.txt' : 'proof-failure.txt');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', builder, '-SkipAcquire'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, METORIGIN_BUNDLER_FIXTURE: root, METORIGIN_BUNDLER_EVENTS: events, METORIGIN_BUNDLER_FAIL_PREPARE: failPreparation ? '1' : '0' },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.error, undefined, String(result.error));
    const observed = (await fs.readFile(events, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.deepEqual(observed, failPreparation
      ? ['verify-pack', 'prepare-assets', 'freeze-source', 'freeze-build-tools', 'compile', 'verify-source', 'bundle']
      : ['verify-pack', 'prepare-assets', 'freeze-source', 'freeze-build-tools', 'compile', 'verify-source', 'bundle', 'verify-source', 'freeze-tools', 'bundle', 'verify-source', 'bind-application', 'verify-build-tools', 'verify-tools']);
    await assert.rejects(fs.access(path.join(root, 'packages')), /ENOENT/);
  }
  for (const phase of ['target', 'release', 'bundle', 'nsis', 'after-compile', 'after-prepare']) await context.test(`rejects ${phase} output junction without deleting external installers`, async () => {
    const external = path.join(root, `external-${phase}`);
    await fs.mkdir(external);
    const preserved = path.join(external, 'existing-user-installer.exe');
    await fs.writeFile(preserved, 'preserve external bytes');
    const target = path.join(root, `target-${phase}`);
    if (!phase.startsWith('after-')) {
      const relative = { target: '', release: 'release', bundle: 'release/bundle', nsis: 'release/bundle/nsis' }[phase];
      const linked = path.join(target, relative);
      await fs.mkdir(path.dirname(linked), { recursive: true });
      await fs.symlink(external, linked, 'junction');
    }
    const events = path.join(root, `junction-${phase}.txt`);
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', builder, '-SkipAcquire', '-CargoTargetDirectory', target], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, METORIGIN_BUNDLER_FIXTURE: root, METORIGIN_BUNDLER_EVENTS: events,
        METORIGIN_BUNDLER_FAIL_PREPARE: '0', METORIGIN_BUNDLER_LINK_PHASE: phase, METORIGIN_BUNDLER_EXTERNAL: external },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /physical bundler output directories/);
    assert.equal(await fs.readFile(preserved, 'utf8'), 'preserve external bytes');
    const observed = (await fs.readFile(events, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.equal(observed.filter(event => event === 'bundle').length, phase === 'after-prepare' ? 1 : 0);
    await assert.rejects(fs.access(path.join(root, 'packages')), /ENOENT/);
  });
});
