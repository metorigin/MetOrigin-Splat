import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { preparePack, verifyPack, digest, repository, run, child, publishDirectory, bundleConfiguration } from './AlignmentPack.mjs';

const candidate = JSON.parse(await fs.readFile(path.join(repository, 'packaging/windows-x64/alignment-lock.json'), 'utf8'));
const capabilities = {
  schema_version: 1, engine: 'brush', engine_version: candidate.brush_version,
  source_commit: '1388f74c6fe0236f68ee4915564bf00e9d2e3747', build_id: 'metorigin-windows.1',
  cli_profile: 'metorigin_1', target: candidate.target,
  live_protocol: 'ply_request_ack_v1', resume_mode: 'ply_warm_start_optimizer_reset',
  supported_features: ['compute_probe', 'ply_checkpoint', 'ply_warm_start', 'loader_thread_limit', 'atomic_checkpoint', 'explicit_cli_overrides', 'live_preview', 'backend_device_selection'],
};

async function fixture(machineOverrides = {}, colmapVersion = '4.1.0') {
  await fs.mkdir(path.join(repository, 'target/distribution'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repository, 'target/distribution/alignment-test-'));
  const source = JSON.parse(await fs.readFile(path.join(repository, candidate.brush_source_lock), 'utf8'));
  const machine = { ...capabilities, ...machineOverrides };
  const nativeSource = path.join(root, 'fixture.rs');
  await fs.writeFile(nativeSource, `
fn main() {
  if std::env::args().any(|arg| arg == "--hold") { std::thread::sleep(std::time::Duration::from_secs(90)); return; }
  let exe = std::env::current_exe().unwrap();
  let name = exe.file_name().unwrap().to_str().unwrap();
  let argument = std::env::args().nth(1).unwrap_or_default();
  match name {
    "ffmpeg.exe" => println!("ffmpeg version 8.1.2"),
    "ffprobe.exe" => println!("ffprobe version 8.1.2"),
    "colmap.exe" => println!("COLMAP ${colmapVersion} (native fixture)"),
    "brush-cli.exe" => if argument == "--version" { println!("brush-cli ${candidate.brush_version}"); }
      else { println!("{}", r#"${JSON.stringify(machine)}"#); },
    _ => std::process::exit(1)
  }
}`);
  const native = path.join(root, 'native.exe');
  run('rustc', ['--edition=2021', '--crate-name=alignment_fixture', nativeSource, '-o', native]);
  const extraction = path.join(root, 'extracted');
  for (const id of ['ffmpeg', 'colmap']) {
    await fs.mkdir(path.join(extraction, id, 'bin'), { recursive: true });
    await fs.copyFile(native, path.join(extraction, id, 'bin', `${id}.exe`));
  }
  await fs.copyFile(native, path.join(extraction, 'ffmpeg/bin/ffprobe.exe'));
  await fs.writeFile(path.join(extraction, 'ffmpeg/LICENSE'), 'fixture license');
  await fs.writeFile(path.join(extraction, 'colmap/bin/runtime.dll'), 'fixture dependency closure');
  const brush = path.join(root, 'runtime');
  await fs.mkdir(path.join(brush, 'bin'), { recursive: true });
  await fs.copyFile(native, path.join(brush, 'bin/brush-cli.exe'));
  await fs.writeFile(path.join(brush, 'BRUSH-LICENSE'), 'fixture license');
  await fs.writeFile(path.join(brush, 'capabilities.json'), JSON.stringify(machine));
  const buildFiles = { 'bin/brush-cli.exe': await digest(native) };
  await fs.writeFile(path.join(brush, 'Cargo.lock'), 'fixture locked dependencies');
  source.cargo_lock_sha256 = await digest(path.join(brush, 'Cargo.lock'));
  buildFiles['Cargo.lock'] = source.cargo_lock_sha256;
  for (const [relative, record] of Object.entries(source.dxc.files)) {
    await fs.mkdir(path.dirname(path.join(brush, relative)), { recursive: true });
    await fs.writeFile(path.join(brush, relative), `fixture ${relative}`);
    record.sha256 = await digest(path.join(brush, relative));
    buildFiles[relative] = record.sha256;
  }
  await fs.writeFile(path.join(brush, 'BUILD-INFO.json'), JSON.stringify({
    inputs: { lock: source }, files: buildFiles, binary_sha256: await digest(native),
  }));
  const cache = path.join(root, 'cache');
  await fs.mkdir(cache);
  const components = {};
  for (const id of ['ffmpeg', 'colmap', 'vcredist']) {
    const name = `${id}.zip`;
    const file = path.join(cache, name);
    await fs.writeFile(file, `locked ${id} archive`);
    components[id] = { version: id === 'ffmpeg' ? '8.1.2' : '4.1.0', archive_filename: name,
      size_bytes: (await fs.stat(file)).size, sha256: await digest(file), source_url: 'https://example.invalid/pinned' };
  }
  return {
    root, output: path.join(root, 'published'), cache, brush, offline: true,
    recipe: { candidate, archives: { components }, source },
    expand: async (_archive, target, id) => fs.cp(path.join(extraction, id), target, { recursive: true }),
  };
}

test('candidate preparation executes native identities, reuses verified cache, and rejects corruption without replacing it', { skip: process.platform !== 'win32' }, async () => {
  const options = await fixture();
  await preparePack(options);
  const verified = await verifyPack(options.output, { expected: options.recipe });
  assert.equal(verified.manifest.engines.brush.executables.brush, 'brush/bin/brush-cli.exe');
  const legacyConfig = path.join(repository, 'apps/desktop/src-tauri/tauri.full.conf.json');
  const legacyHash = await digest(legacyConfig);
  const generated = path.join(options.root, 'candidate-config/tauri.conf.json');
  await bundleConfiguration(options.output, generated, { expected: options.recipe });
  const bundle = JSON.parse(await fs.readFile(generated, 'utf8'));
  assert.equal(bundle.identifier, 'com.metorigin.splat.alignment-candidate');
  assert.equal(bundle.productName, 'MetOrigin Splat');
  assert.equal(bundle.mainBinaryName, 'MetOrigin Splat');
  assert.equal(bundle.app.windows[0].title, 'MetOrigin Splat');
  assert.equal(bundle.bundle.windows.nsis.template, 'nsis/alignment-installer.nsi');
  assert.deepEqual(Object.values(bundle.bundle.resources), ['resources/engines/', 'resources/licenses/', 'resources/installer/', 'resources/licenses/tauri/NSIS-LICENSE-MIT.txt']);
  for (const input of Object.keys(bundle.bundle.resources)) {
    assert.ok(!path.isAbsolute(input));
    const resource = await fs.stat(path.resolve(repository, 'apps/desktop/src-tauri', input));
    assert.ok(resource.isDirectory() || input === 'nsis/LICENSE.tauri-mit.txt' && resource.isFile());
  }
  assert.equal(await digest(legacyConfig), legacyHash);
  const manifestPath = path.join(options.output, 'engines/engine-manifest.json');
  const original = await digest(manifestPath);
  await preparePack(options);
  assert.equal(await digest(manifestPath), original);
  const bad = path.join(options.output, 'engines/ffmpeg/bin/ffprobe.exe');
  await fs.appendFile(bad, 'corruption');
  const damaged = await digest(bad);
  await assert.rejects(preparePack(options), /integrity failure/);
  assert.equal(await digest(bad), damaged);
});

test('offline missing archive and concurrent owner cannot expose a partial pack', { skip: process.platform !== 'win32' }, async () => {
  const options = await fixture();
  await fs.unlink(path.join(options.cache, 'ffmpeg.zip'));
  await assert.rejects(preparePack(options), /Offline archive missing/);
  await assert.rejects(fs.stat(options.output), { code: 'ENOENT' });
  const owner = JSON.stringify({ pid: 12345, started: '2026-10-30T00:00:00Z' });
  await fs.writeFile(`${options.output}.prepare.lock`, owner);
  await assert.rejects(preparePack(options), /already locked \(PID 12345/);
  assert.equal(await fs.readFile(`${options.output}.prepare.lock`, 'utf8'), owner);
});

test('missing DLL and unsafe manifest paths fail closed', { skip: process.platform !== 'win32' }, async () => {
  const options = await fixture();
  await preparePack(options);
  const dll = path.join(options.output, 'engines/colmap/bin/runtime.dll');
  await fs.unlink(dll);
  await assert.rejects(verifyPack(options.output, { runtime: false }), /file count mismatch/);
  const manifestPath = path.join(options.output, 'engines/engine-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.engines.brush.files[0].path = '../escaped';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  // COLMAP is checked first; restore its declared DLL so the traversal check is reached.
  await fs.writeFile(dll, 'fixture dependency closure');
  await assert.rejects(verifyPack(options.output, { runtime: false }), /Unsafe relative path/);
  assert.throws(() => child(options.output, 'C:/escape'), /Unsafe/);
});

test('actual wrong platform and incompatible COLMAP identities cannot publish a candidate', { skip: process.platform !== 'win32' }, async () => {
  for (const options of [await fixture({ target: 'aarch64-apple-darwin' }), await fixture({}, '4.3.0')]) {
    await assert.rejects(preparePack(options), /Wrong Brush machine identity|Incompatible actual COLMAP/);
    await assert.rejects(fs.stat(options.output), { code: 'ENOENT' });
  }
});

function storedZip(name, content) {
  const filename = Buffer.from(name);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('actual ZIP extraction rejects traversal before writing outside staging', { skip: process.platform !== 'win32' }, async () => {
  const options = await fixture();
  const archive = path.join(options.root, 'hostile.zip');
  await fs.writeFile(archive, storedZip('../escaped.txt', 'must not escape'));
  assert.throws(() => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(repository, 'scripts/windows/Expand-AlignmentArchive.ps1'), '-Archive', archive,
    '-Destination', path.join(options.root, 'extract')]), /Unsafe archive entry/);
  await assert.rejects(fs.stat(path.join(options.root, 'escaped.txt')), { code: 'ENOENT' });
});

test('publish retries transient NTFS sharing failures and preserves competing output', async () => {
  await fs.mkdir(path.join(repository, 'target/distribution'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repository, 'target/distribution/alignment-publish-'));
  const stage = path.join(root, 'stage');
  const output = path.join(root, 'published');
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'complete'), 'verified bytes');
  let attempts = 0;
  await publishDirectory(stage, output, async (from, to) => {
    if (++attempts === 1) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    await fs.rename(from, to);
  });
  assert.equal(attempts, 2);
  assert.equal(await fs.readFile(path.join(output, 'complete'), 'utf8'), 'verified bytes');
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'complete'), 'different candidate');
  await assert.rejects(publishDirectory(stage, output), /output appeared/);
  assert.equal(await fs.readFile(path.join(output, 'complete'), 'utf8'), 'verified bytes');
  assert.equal(await fs.readFile(path.join(stage, 'complete'), 'utf8'), 'different candidate');
});

test('candidate installer process guard observes only the selected directory and never stops a process', { skip: process.platform !== 'win32' }, async (context) => {
  const options = await fixture();
  const hook = await fs.readFile(path.join(repository, 'apps/desktop/src-tauri/nsis/alignment-installer-hooks.nsh'), 'utf8');
  const command = hook.match(/-Command "(try \{[^\r\n]+)"'/)?.[1].replaceAll('$$', '$');
  assert.ok(command, 'the installer must contain its constant process-check command');
  const native = path.join(options.root, 'native.exe');
  const child = spawn(native, ['--hold'], { windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    const check = (directory) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, METORIGIN_CANDIDATE_INSTALL_DIR: directory, METORIGIN_CANDIDATE_CALLER_PID: String(process.pid) },
    });
    const own = check(options.root);
    if (own.status === 21) { context.skip('host does not permit Win32_Process observation'); return; }
    assert.equal(own.status, 20, own.stderr);
    assert.equal(check(`${options.root}-other`).status, 0);
    assert.equal(check(path.join(options.root, "unused 中文 ' folder")).status, 0);
    assert.equal(child.exitCode, null, 'a process check must not terminate any process');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
});
