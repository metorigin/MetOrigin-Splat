import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nsis = path.join(root, 'apps/desktop/src-tauri/nsis');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('naming template differs from pinned official Tauri only in the documented internal identities', async () => {
  const source = JSON.parse(await fs.readFile(path.join(nsis, 'alignment-template-source.json'), 'utf8'));
  const bytes = await fs.readFile(path.join(nsis, source.modified_template));
  assert.equal(source.tauri_cli_version, '2.11.4');
  assert.equal(source.commit, '8909f221d1515955fc843808032bdc5d62209c96');
  assert.equal(sha256(bytes), source.modified_sha256);
  let restored = bytes.toString('utf8');
  for (const change of source.changes) {
    assert.equal(restored.split(change.after).length - 1, change.count);
    restored = restored.replaceAll(change.after, change.before);
  }
  assert.equal(sha256(restored), source.upstream_sha256, 'all undocumented template changes must fail review');
  assert.equal(sha256(await fs.readFile(path.join(nsis, source.license_file))), source.license_sha256);
  assert.match(restored, /!define PRODUCTNAME "\{\{product_name\}\}"/);
  assert.match(restored, /!define MAINBINARYNAME "\{\{main_binary_name\}\}"/);
});

// Exercise a real fixture uninstaller with _?= so it runs from inside INSTDIR.
// Its only actions are this guard and fixture-local files: no registry, desktop,
// installed application, or user-owned process is changed.
test('native in-place uninstall excludes only its own PID and retains the installation process guard', { skip: process.platform !== 'win32' }, async (context) => {
  const compiler = path.join(root, 'target/windows-alignment-release-build/.tauri/NSIS/Bin/makensis.exe');
  try { await fs.access(compiler); } catch { context.skip('pinned local NSIS compiler is unavailable'); return; }
  const base = await fs.mkdtemp(path.join(root, 'target/windows-process-guard-fixture-'));
  const bootstrap = path.join(base, 'guard-bootstrap.exe');
  const quote = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
  const fixture = `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Installation process guard fixture"
OutFile "${quote(bootstrap)}"
!macro CheckIfAppIsRunning executableName productName
!macroend
!include "${quote(path.join(nsis, 'alignment-installer-hooks.nsh'))}"
!macro GuardFixtureExpect register expected
  StrCmp \${register} "\${expected}" +3
  SetErrorLevel 41
  Abort
!macroend
Section
  ReadEnvStr $0 METORIGIN_PROCESS_GUARD_HOLDER_READY
  \${If} $0 != ""
    FileOpen $1 "$0" w
    FileWrite $1 "ready"
    FileClose $1
    StrCpy $2 0
    guard_hold:
      IfFileExists "$0.stop" guard_done
      Sleep 50
      IntOp $2 $2 + 1
      IntCmp $2 600 guard_done guard_hold guard_done
    guard_done:
  \${Else}
    ReadEnvStr $INSTDIR METORIGIN_PROCESS_GUARD_FIXTURE_DIR
    WriteUninstaller "$INSTDIR\\uninstall.exe"
  \${EndIf}
  SetErrorLevel 0
SectionEnd
Section "Uninstall"
  StrCpy $0 "guard-0"
  StrCpy $1 "guard-1"
  StrCpy $2 "guard-2"
  StrCpy $R8 "guard-r8"
  StrCpy $R9 "guard-r9"
  Push "guard-stack"
  !insertmacro METORIGIN_REQUIRE_STOPPED_PROCESSES
  !insertmacro GuardFixtureExpect $0 "guard-0"
  !insertmacro GuardFixtureExpect $1 "guard-1"
  !insertmacro GuardFixtureExpect $2 "guard-2"
  !insertmacro GuardFixtureExpect $R8 "guard-r8"
  !insertmacro GuardFixtureExpect $R9 "guard-r9"
  Pop $3
  !insertmacro GuardFixtureExpect $3 "guard-stack"
  ReadEnvStr $3 METORIGIN_CANDIDATE_INSTALL_DIR
  !insertmacro GuardFixtureExpect $3 ""
  ReadEnvStr $3 METORIGIN_CANDIDATE_CALLER_PID
  !insertmacro GuardFixtureExpect $3 ""
  FileOpen $4 "$INSTDIR\\guard-passed.txt" w
  FileWrite $4 "passed"
  FileClose $4
  SetErrorLevel 0
SectionEnd
`;
  const script = path.join(base, 'fixture.nsi');
  await fs.writeFile(script, fixture);
  const compiled = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compiled.status, 0, [compiled.stdout, compiled.stderr, String(compiled.error ?? '')].join('\n'));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const scenarios = [
    { name: 'in-place uninstaller restores registers, stack and clears its local environment' },
    { name: 'another application in this installation still blocks uninstall', holder: 'MetOrigin Splat.exe', blocked: true },
    { name: 'an engine in this installation still blocks uninstall', holder: 'resources/engines/brush/brush-cli.exe', blocked: true },
    { name: 'another process named uninstall.exe is not exempt', holder: 'maintenance/uninstall.exe', blocked: true },
    { name: 'an application from another installation does not block uninstall', holder: 'MetOrigin Splat.exe', elsewhere: true },
  ];
  for (const [index, scenario] of scenarios.entries()) await context.test(scenario.name, async () => {
    const directory = path.join(base, `case-${index}`);
    await fs.mkdir(directory);
    const env = { ...process.env, METORIGIN_PROCESS_GUARD_FIXTURE_DIR: directory, METORIGIN_PROCESS_GUARD_HOLDER_READY: '' };
    const created = spawnSync(bootstrap, ['/S'], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(created.status, 0, [created.stdout, created.stderr, String(created.error ?? '')].join('\n'));
    const uninstaller = path.join(directory, 'uninstall.exe');
    await fs.access(uninstaller);
    let holder, holderExit, ready;
    try {
      if (scenario.holder) {
        const holderRoot = scenario.elsewhere ? path.join(base, `other-installation-${index}`) : directory;
        const holderPath = path.join(holderRoot, scenario.holder);
        await fs.mkdir(path.dirname(holderPath), { recursive: true });
        await fs.copyFile(bootstrap, holderPath);
        ready = path.join(base, `holder-${index}.ready`);
        holder = spawn(holderPath, ['/S'], { env: { ...env, METORIGIN_PROCESS_GUARD_HOLDER_READY: ready }, windowsHide: true, stdio: 'ignore' });
        holderExit = new Promise((resolve, reject) => { holder.once('exit', resolve); holder.once('error', reject); });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await fs.access(ready).then(() => true, () => false)) break;
          assert.equal(holder.exitCode, null, 'fixture holder exited before becoming ready');
          await pause(50);
        }
        await fs.access(ready);
        const visible = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:METORIGIN_PROCESS_GUARD_HOLDER_PID) -ErrorAction Stop;if(-not $p.ExecutablePath){exit 9};[IO.Path]::GetFullPath($p.ExecutablePath)'], {
          env: { ...env, METORIGIN_PROCESS_GUARD_HOLDER_PID: String(holder.pid) }, encoding: 'utf8', windowsHide: true, timeout: 15000,
        });
        assert.equal(visible.status, 0, `fixture process must be visible through CIM: ${visible.stderr}`);
        assert.equal(visible.stdout.trim().toLowerCase(), holderPath.toLowerCase());
      }
      // An inherited, unrelated PID must not override GetCurrentProcessId().
      const run = spawnSync(uninstaller, ['/S', `_?=${directory}`], {
        env: { ...env, METORIGIN_CANDIDATE_CALLER_PID: String(holder?.pid ?? process.pid) },
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      assert.equal(run.status, scenario.blocked ? 1 : 0, [run.stdout, run.stderr, String(run.error ?? '')].join('\n'));
      const passed = path.join(directory, 'guard-passed.txt');
      if (scenario.blocked) await assert.rejects(fs.access(passed));
      else assert.equal(await fs.readFile(passed, 'utf8'), 'passed');
    } finally {
      if (holder) {
        await fs.writeFile(`${ready}.stop`, 'stop');
        const stopped = await Promise.race([holderExit.then(() => true), pause(3000).then(() => false)]);
        if (!stopped) {
          // This handle belongs only to the executable spawned by this fixture.
          holder.kill();
          await holderExit;
          assert.fail('fixture holder did not honor its fixture-local stop file');
        }
      }
    }
  });
});

test('display naming keeps the candidate identifier, maintenance keys and directory separate from the legacy product', async () => {
  const template = await fs.readFile(path.join(nsis, 'alignment-installer.nsi'), 'utf8');
  const config = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/tauri.alignment.conf.json'), 'utf8'));
  assert.equal(config.productName, 'MetOrigin Splat');
  assert.equal(config.mainBinaryName, 'MetOrigin Splat');
  assert.equal(config.identifier, 'com.metorigin.splat.alignment-candidate');
  assert.equal(config.bundle.windows.nsis.template, 'nsis/alignment-installer.nsi');
  assert.ok(template.includes('!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MetOrigin Splat Alignment Candidate"'));
  assert.ok(template.includes('!define MANUPRODUCTKEY "${MANUKEY}\\MetOrigin Splat Alignment Candidate"'));
  assert.ok(template.includes('StrCpy $INSTDIR "$LOCALAPPDATA\\MetOrigin Splat Alignment Candidate"'));
  assert.ok(template.includes('StrCmp "$R0$R1" "MetOrigin Splat Alignment Candidate${MANUFACTURER}" 0 wix_loop'));
  assert.ok(template.includes('WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"'));
  assert.ok(template.includes('ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"'));
});

// Compile only a tiny macro fixture. It never runs the application or accesses
// the real desktop/Start Menu/registry: every .lnk is in an ignored test folder.
test('native owned shortcut migration preserves other installations and honors existing-link maintenance', { skip: process.platform !== 'win32' }, async (context) => {
  const compiler = path.join(root, 'target/windows-alignment-release-build/.tauri/NSIS/Bin/makensis.exe');
  try { await fs.access(compiler); } catch { context.skip('pinned local NSIS compiler is unavailable'); return; }
  const base = await fs.mkdtemp(path.join(root, 'target/windows-naming-fixture-'));
  const executable = path.join(base, 'shortcut-fixture.exe');
  const quote = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
  const fixture = `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Owned shortcut fixture"
OutFile "${quote(executable)}"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "${quote(path.join(root, 'target/windows-alignment-release-build/release/nsis/x64/utils.nsh'))}"
!include "Win\\COM.nsh"
!include "Win\\Propkey.nsh"
!define MAINBINARYNAME "MetOrigin Splat"
!define PRODUCTNAME "MetOrigin Splat"
!define BUNDLEID "com.metorigin.splat.alignment-candidate"
!include "${quote(path.join(nsis, 'alignment-installer-hooks.nsh'))}"
Var NoShortcutMode
Var UpdateMode
Section
  ReadEnvStr $INSTDIR METORIGIN_NAMING_FIXTURE_DIR
  StrCpy $NoShortcutMode 0
  StrCpy $UpdateMode 0
  ClearErrors
  \${GetOptions} $CMDLINE "/NS" $0
  \${IfNot} \${Errors}
    StrCpy $NoShortcutMode 1
  \${EndIf}
  ClearErrors
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  !insertmacro METORIGIN_VALIDATE_SHORTCUT_RENAME "$INSTDIR\\old.lnk" "$INSTDIR\\new.lnk"
  !insertmacro METORIGIN_MIGRATE_OWNED_SHORTCUT "$INSTDIR\\old.lnk" "$INSTDIR\\new.lnk"
SectionEnd
`;
  const script = path.join(base, 'fixture.nsi');
  await fs.writeFile(script, fixture);
  const compiled = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compiled.status, 0, [compiled.stdout, compiled.stderr, String(compiled.error ?? '')].join('\n'));
  const linkCommand = '$s=$env:METORIGIN_NAMING_LINK_SPEC|ConvertFrom-Json;$w=New-Object -ComObject WScript.Shell;$l=$w.CreateShortcut($s.path);if($s.target){$l.TargetPath=$s.target;$l.IconLocation=$s.target+",0";$l.Save()};[ordered]@{target=$l.TargetPath;icon=$l.IconLocation}|ConvertTo-Json -Compress';
  const link = (file, target) => {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', linkCommand], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, METORIGIN_NAMING_LINK_SPEC: JSON.stringify({ path: file, target }) },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const scenarios = [
    { name: 'owned old', old: 'owned' },
    { name: 'foreign old', old: 'foreign' },
    { name: 'foreign new collision', old: 'owned', newer: 'foreign', fails: true },
    { name: 'fresh install preserves a foreign new-name shortcut', newer: 'foreign', fails: true },
    { name: 'owned new already exists', old: 'owned', newer: 'owned' },
    { name: 'NS absent leaves absent', flags: ['/NS'] },
    { name: 'NS preserves a foreign shortcut without creating one', newer: 'foreign', flags: ['/NS'] },
    { name: 'NS maintains an existing owned link', old: 'owned', flags: ['/NS'] },
    { name: 'UPDATE maintains an existing owned link', old: 'owned', flags: ['/UPDATE'] },
  ];
  for (const [index, scenario] of scenarios.entries()) await context.test(scenario.name, async () => {
    const directory = path.join(base, `case-${index}`);
    await fs.mkdir(directory);
    const old = path.join(directory, 'old.lnk'), newer = path.join(directory, 'new.lnk');
    const oldTarget = path.join(directory, 'MetOrigin Splat Alignment Candidate.exe');
    const target = path.join(directory, 'MetOrigin Splat.exe');
    const foreign = path.join(base, 'another-installation.exe');
    await fs.writeFile(oldTarget, 'nonexecutable fixture'); await fs.writeFile(target, 'nonexecutable fixture');
    if (scenario.old) link(old, scenario.old === 'owned' ? oldTarget : foreign);
    if (scenario.newer) link(newer, scenario.newer === 'owned' ? target : foreign);
    const oldBefore = scenario.old ? await fs.readFile(old) : null;
    const newBefore = scenario.newer ? await fs.readFile(newer) : null;
    const run = spawnSync(executable, ['/S', ...(scenario.flags ?? [])], { encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, METORIGIN_NAMING_FIXTURE_DIR: directory } });
    assert.equal(run.status, scenario.fails ? 1 : 0, [run.stdout, run.stderr, String(run.error ?? '')].join('\n'));
    if (scenario.fails || scenario.old === 'foreign') {
      if (oldBefore) assert.deepEqual(await fs.readFile(old), oldBefore);
      else await assert.rejects(fs.access(old));
      if (newBefore) assert.deepEqual(await fs.readFile(newer), newBefore);
      else await assert.rejects(fs.access(newer));
    } else if (scenario.old) {
      await assert.rejects(fs.access(old));
      const saved = link(newer);
      assert.equal(saved.target.toLowerCase(), target.toLowerCase());
      assert.equal(saved.icon.toLowerCase(), `${target},0`.toLowerCase());
    } else if (newBefore) {
      await assert.rejects(fs.access(old));
      assert.deepEqual(await fs.readFile(newer), newBefore);
    } else {
      await assert.rejects(fs.access(old)); await assert.rejects(fs.access(newer));
    }
  });
});
