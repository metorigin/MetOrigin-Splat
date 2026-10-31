import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absolute = (value) => path.resolve(repository, value);
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const exists = async (file) => fs.lstat(file).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });

export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function child(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\')
    && !relative.includes(':') && !relative.split('/').some((part) => !part || part === '.' || part === '..')
    && !path.isAbsolute(relative), `Unsafe relative path: ${relative}`);
  const result = path.resolve(root, relative);
  invariant(result.startsWith(`${path.resolve(root)}${path.sep}`), `Path escapes pack: ${relative}`);
  return result;
}

async function files(root, base = root) {
  const rootStat = await fs.lstat(root);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `Pack directory links are not accepted: ${root}`);
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const stat = await fs.lstat(full);
    invariant(!stat.isSymbolicLink(), `Pack links are not accepted: ${full}`);
    if (stat.isDirectory()) result.push(...await files(full, base));
    else {
      invariant(stat.isFile(), `Pack entry is not a regular file: ${full}`);
      result.push({ path: path.relative(base, full).split(path.sep).join('/'), sha256: await digest(full), size_bytes: stat.size });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function validateSource(source, candidate) {
  invariant(source.source_commit === '1388f74c6fe0236f68ee4915564bf00e9d2e3747'
    && source.engine_version === candidate.brush_version && source.target === candidate.target
    && source.rust_version === '1.95.0' && source.patches?.length === 2
    && source.patches[0].path === 'integrations/brush-macos/patches/metorigin-macos.6.patch'
    && source.patches[0].sha256 === '1e342de3d80fc9ae3ac38873814b17b9bc6d8ce067159ad3eae02ef3148353d2'
    && source.patches[1].path === 'integrations/brush-windows/patches/metorigin-windows.1.patch'
    && /^[a-f\d]{64}$/i.test(source.patches[1].sha256), 'Invalid Brush source chain');
  invariant(source.dxc?.sha256 === '70b1913a1bfce4a3e1a5311d16246f4ecdf3a3e613abec8aa529e57668426f85'
    && source.dxc.files['bin/dxcompiler.dll'] && source.dxc.files['bin/dxil.dll'], 'Missing frozen DXC dependency closure');
}

export function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
  invariant(!result.error && result.status === 0, `${path.basename(executable)} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

export async function publishDirectory(stage, output, rename = fs.rename) {
  // Windows DLL scanning may retain a transient handle just after version
  // commands exit. Never replace an output that appeared while waiting.
  for (const delay of [0, 100, 250, 500, 1000, 2000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    invariant(!(await exists(output)), 'Candidate output appeared during preparation');
    try { await rename(stage, output); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || delay === 2000) throw error;
    }
  }
}

async function locks() {
  const candidate = await readJson(absolute('packaging/windows-x64/alignment-lock.json'));
  const archiveLock = await readJson(absolute(candidate.archive_lock));
  const archives = { schema_version: archiveLock.schema_version, platform: archiveLock.platform,
    components: Object.fromEntries(['ffmpeg', 'colmap', 'vcredist'].map((id) => [id, archiveLock.components[id]])) };
  const source = await readJson(absolute(candidate.brush_source_lock));
  invariant(candidate.schema_version === 1 && candidate.platform === 'windows-x64'
    && candidate.target === 'x86_64-pc-windows-msvc', 'Invalid Windows candidate lock');
  invariant(archives.schema_version === 1 && archives.platform === candidate.platform, 'Invalid archive lock');
  for (const id of ['ffmpeg', 'colmap', 'vcredist']) {
    const component = archives.components[id];
    invariant(component && /^[a-f\d]{64}$/i.test(component.sha256) && component.size_bytes > 0, `Invalid ${id} archive identity`);
    child(repository, component.archive_filename);
  }
  invariant(archives.components.colmap.version === '4.1.0', 'Candidate requires COLMAP 4.1.0');
  validateSource(source, candidate);
  for (const patch of source.patches) invariant(await digest(absolute(patch.path)) === patch.sha256, `Frozen patch changed: ${patch.path}`);
  return { candidate, archives, source };
}

export async function verifyPack(output, { runtime = true, expected } = {}) {
  const root = path.join(output, 'engines');
  const manifest = await readJson(path.join(root, 'engine-manifest.json'));
  const info = await readJson(path.join(root, 'BUILD-INFO.json'));
  const candidate = expected?.candidate ?? info.candidate;
  invariant(candidate.schema_version === 1 && candidate.platform === 'windows-x64'
    && candidate.target === 'x86_64-pc-windows-msvc' && candidate.brush_version === '1.0.0+metorigin-windows.1', 'Invalid candidate target or engine contract');
  invariant(manifest.schema_version === 1 && manifest.platform === 'windows-x64'
    && manifest.pack_version === candidate.pack_version, 'Wrong candidate manifest identity');
  invariant(Object.keys(manifest).sort().join(',') === 'engines,pack_version,platform,schema_version', 'Unknown manifest fields');
  invariant(Object.keys(manifest.engines).sort().join(',') === 'brush,colmap,ffmpeg', 'Incomplete engine set');
  invariant(JSON.stringify(info.candidate) === JSON.stringify(candidate), 'Candidate recipe changed');
  if (expected) invariant(JSON.stringify(info.archives) === JSON.stringify(expected.archives), 'Archive recipe changed');
  const expectedMappings = {
    ffmpeg: { ffmpeg: 'ffmpeg/bin/ffmpeg.exe', ffprobe: 'ffmpeg/bin/ffprobe.exe' },
    colmap: { colmap: 'colmap/bin/colmap.exe' }, brush: { brush: 'brush/bin/brush-cli.exe' },
  };
  for (const id of ['ffmpeg', 'colmap', 'brush']) {
    const engine = manifest.engines[id];
    invariant(Object.keys(engine).sort().join(',') === 'executables,files,license_files,source_sha256,source_url,version', `Unknown ${id} manifest fields`);
    invariant(JSON.stringify(engine.executables) === JSON.stringify(expectedMappings[id]), `Wrong ${id} executable mapping`);
    invariant(engine.version === (id === 'brush' ? candidate.brush_version : info.archives.components[id].version), `Wrong ${id} version`);
    const actual = await files(path.join(root, id), root);
    invariant(actual.length === engine.files.length, `${id} file count mismatch`);
    const declared = new Map();
    for (const record of engine.files) {
      child(root, record.path);
      invariant(record.path.startsWith(`${id}/`) && !declared.has(record.path.toLowerCase()), `Duplicate or misplaced ${id} file`);
      declared.set(record.path.toLowerCase(), record);
    }
    for (const file of actual) {
      const record = declared.get(file.path.toLowerCase());
      invariant(record && file.sha256.toLowerCase() === record.sha256.toLowerCase() && file.size_bytes === record.size_bytes, `${id} integrity failure: ${file.path}`);
    }
    for (const relative of [...Object.values(engine.executables), ...engine.license_files]) {
      invariant(declared.has(relative.toLowerCase()), `Required file absent from manifest: ${relative}`);
    }
    invariant(engine.license_files.length > 0, `Missing ${id} license`);
    invariant(/^[a-f\d]{64}$/i.test(engine.source_sha256), `Invalid ${id} source hash`);
    if (id !== 'brush') {
      invariant(engine.source_sha256.toLowerCase() === info.archives.components[id].sha256.toLowerCase()
        && engine.source_url === info.archives.components[id].source_url, `${id} provenance mismatch`);
    }
  }
  const sourceFile = path.join(root, 'brush/source-lock.json');
  const source = await readJson(sourceFile);
  const build = await readJson(path.join(root, 'brush/BUILD-INFO.json'));
  validateSource(source, candidate);
  invariant(manifest.engines.brush.source_sha256.toLowerCase() === await digest(sourceFile), 'Brush source lock hash mismatch');
  invariant(JSON.stringify(build.inputs.lock) === JSON.stringify(source), 'Brush build inputs differ from frozen source lock');
  if (expected) invariant(JSON.stringify(source) === JSON.stringify(expected.source), 'Brush source recipe changed');
  invariant(build.binary_sha256.toLowerCase() === await digest(path.join(root, 'brush/bin/brush-cli.exe')), 'Brush build binary mismatch');
  for (const [relative, hash] of Object.entries(build.files)) {
    invariant((await digest(child(path.join(root, 'brush'), relative))).toLowerCase() === hash.toLowerCase(), `Brush build file changed: ${relative}`);
  }
  invariant(build.files['Cargo.lock'] === source.cargo_lock_sha256, 'Brush Cargo.lock provenance mismatch');
  for (const [relative, record] of Object.entries(source.dxc.files)) {
    invariant(build.files[relative] === record.sha256
      && await digest(child(path.join(root, 'brush'), relative)) === record.sha256, `DXC dependency provenance mismatch: ${relative}`);
    if (relative.startsWith('notices/')) invariant(manifest.engines.brush.license_files.includes(`brush/${relative}`), `DXC notice absent from license closure: ${relative}`);
  }
  const sums = await readJson(path.join(output, 'checksums.json'));
  const actual = (await files(output)).filter((file) => file.path !== 'checksums.json');
  invariant(JSON.stringify(actual) === JSON.stringify(sums), 'Distribution checksum closure mismatch');
  const vc = info.archives.components.vcredist;
  invariant(await digest(path.join(output, 'installer/vc_redist.x64.exe')) === vc.sha256.toLowerCase(), 'VC runtime identity mismatch');
  if (runtime) {
    for (const name of ['ffmpeg', 'ffprobe']) {
      const text = run(child(root, expectedMappings.ffmpeg[name]), ['-version']);
      invariant(text.startsWith(`${name} version ${manifest.engines.ffmpeg.version}`), `Wrong ${name} executable identity`);
    }
    const colmapBin = path.join(root, 'colmap/bin');
    const env = { ...process.env, PATH: `${colmapBin};${path.join(root, 'colmap/lib')};${process.env.PATH}`, QT_PLUGIN_PATH: path.join(root, 'colmap/plugins') };
    invariant(/^COLMAP 4\.1\.0(?:\s|$)/m.test(run(path.join(colmapBin, 'colmap.exe'), ['-h'], { env })), 'Incompatible actual COLMAP version');
    const brush = path.join(root, 'brush/bin/brush-cli.exe');
    invariant(run(brush, ['--version']).includes(candidate.brush_version), 'Wrong actual Brush version');
    const capabilities = JSON.parse(run(brush, ['--capabilities-json']));
    invariant(capabilities.target === candidate.target && capabilities.engine_version === candidate.brush_version
      && capabilities.source_commit === source.source_commit && capabilities.build_id === source.build_id
      && capabilities.cli_profile === 'metorigin_1', 'Wrong Brush machine identity');
    invariant(capabilities.schema_version === 1 && capabilities.engine === 'brush'
      && capabilities.live_protocol === 'ply_request_ack_v1' && capabilities.resume_mode === 'ply_warm_start_optimizer_reset'
      && ['compute_probe', 'ply_checkpoint', 'ply_warm_start', 'loader_thread_limit', 'atomic_checkpoint', 'explicit_cli_overrides', 'live_preview', 'backend_device_selection']
        .every((feature) => capabilities.supported_features?.includes(feature)), 'Incomplete Brush machine protocol');
    invariant(JSON.stringify(capabilities) === JSON.stringify(await readJson(path.join(root, 'brush/capabilities.json'))), 'Brush capabilities differ from build evidence');
  }
  return { manifest, candidate, gpu_validation: 'separate_real_compute_gate', distribution_status: candidate.distribution_status };
}

export async function bundleConfiguration(output, configFile, { expected } = {}) {
  const verified = await verifyPack(output, { expected: expected ?? await locks() });
  const config = await readJson(absolute('apps/desktop/src-tauri/tauri.alignment.conf.json'));
  invariant(config.identifier === 'com.metorigin.splat.alignment-candidate'
    && config.bundle.windows.nsis.template === 'nsis/alignment-installer.nsi', 'Candidate application identity is not isolated');
  invariant(config.productName === 'MetOrigin Splat'
    && config.mainBinaryName === 'MetOrigin Splat'
    && config.app.windows[0]?.title === 'MetOrigin Splat', 'Application display names differ');
  const filename = absolute(configFile);
  invariant(filename.startsWith(`${absolute('target')}${path.sep}`), 'Generated configuration must stay under target');
  config.bundle.resources = Object.fromEntries(['engines', 'licenses', 'installer'].map((name) => [
    `${path.relative(absolute('apps/desktop/src-tauri'), path.resolve(output, name)).split(path.sep).join('/')}/`, `resources/${name}/`,
  ]));
  config.bundle.resources['nsis/LICENSE.tauri-mit.txt'] = 'resources/licenses/tauri/NSIS-LICENSE-MIT.txt';
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await writeJson(filename, config);
  return { configuration: filename, pack_version: verified.manifest.pack_version,
    source_lock_sha256: verified.manifest.engines.brush.source_sha256,
    distribution_status: verified.distribution_status };
}

async function archiveFile(component, cache, offline) {
  const destination = child(cache, component.archive_filename);
  if (await exists(destination)) {
    invariant((await fs.stat(destination)).size === component.size_bytes && await digest(destination) === component.sha256.toLowerCase(), `Corrupt cached archive: ${component.archive_filename}`);
    return destination;
  }
  invariant(!offline, `Offline archive missing: ${component.archive_filename}`);
  console.log(`Downloading locked ${component.archive_filename}`);
  const temporary = `${destination}.partial-${randomUUID()}`;
  const response = await fetch(component.source_url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  invariant(response.ok && response.body, `Download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
  invariant((await fs.stat(temporary)).size === component.size_bytes && await digest(temporary) === component.sha256.toLowerCase(), `Downloaded archive identity mismatch: ${component.archive_filename}`);
  await fs.rename(temporary, destination);
  return destination;
}

async function reuseLocalVcredist(component, cache) {
  const destination = child(cache, component.archive_filename);
  if (await exists(destination)) return;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const visualStudio = path.join(base, 'Microsoft Visual Studio/2022');
    if (!(await exists(visualStudio))) continue;
    for (const edition of await fs.readdir(visualStudio, { withFileTypes: true })) {
      if (!edition.isDirectory()) continue;
      const redist = path.join(visualStudio, edition.name, 'VC/Redist/MSVC');
      if (!(await exists(redist))) continue;
      for (const version of await fs.readdir(redist, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const candidate = path.join(redist, version.name, 'vc_redist.x64.exe');
        if (await exists(candidate) && (await fs.stat(candidate)).size === component.size_bytes
          && await digest(candidate) === component.sha256.toLowerCase()) {
          await fs.copyFile(candidate, destination);
          console.log('Reused exact locked VC++ runtime from the installed VS toolchain');
          return;
        }
      }
    }
  }
}

async function findSingle(root, name) {
  const matching = (await files(root)).filter((file) => path.basename(file.path).toLowerCase() === name.toLowerCase());
  invariant(matching.length === 1, `Expected exactly one ${name}, found ${matching.length}`);
  return child(root, matching[0].path);
}

export async function preparePack({ output, cache, brush, sourceRepository, offline = false, recipe, expand } = {}) {
  output = absolute(output ?? 'target/distribution/windows-x64-alignment');
  cache = absolute(cache ?? '.engines/downloads');
  brush = absolute(brush ?? 'target/windows-brush/runtime');
  const expected = recipe ?? await locks();
  const allowed = absolute('target/distribution');
  invariant(output.startsWith(`${allowed}${path.sep}`), 'Candidate output must be below target/distribution');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const lockFile = `${output}.prepare.lock`;
  let handle;
  try { handle = await fs.open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') {
      const owner = await readJson(lockFile).catch(() => null);
      const detail = owner && Number.isInteger(owner.pid) && owner.pid > 0
        ? `PID ${owner.pid}, started ${owner.started}` : 'owner metadata unavailable';
      throw new Error(`Preparation is already locked (${detail}): ${lockFile}; check the owner before removing a stale lock`);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    if (await exists(output)) {
      await verifyPack(output, { expected });
      console.log(`Using fully verified candidate cache: ${output}`);
      return output;
    }
    if (!(await exists(path.join(brush, 'BUILD-INFO.json')))) {
      run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', absolute('scripts/windows/Build-BrushRuntime.ps1'), '-SourceRepository', absolute(sourceRepository ?? '../brush'), '-OutputDirectory', brush, ...(offline ? ['-Offline'] : [])], { timeout: 60 * 60 * 1000, stdio: 'inherit' });
    }
    const stage = `${output}.staging-${randomUUID()}`;
    const root = path.join(stage, 'engines');
    const work = path.join(stage, '.work');
    await fs.mkdir(work, { recursive: true });
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(path.join(stage, 'licenses'), { recursive: true });
    await fs.mkdir(path.join(stage, 'installer'), { recursive: true });
    for (const id of ['ffmpeg', 'colmap', 'vcredist']) {
      const component = expected.archives.components[id];
      if (id === 'vcredist') await reuseLocalVcredist(component, cache);
      const archive = await archiveFile(component, cache, offline);
      if (id === 'vcredist') { await fs.copyFile(archive, path.join(stage, 'installer/vc_redist.x64.exe')); continue; }
      const extracted = path.join(work, id);
      if (expand) await expand(archive, extracted, id);
      else run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', absolute('scripts/windows/Expand-AlignmentArchive.ps1'), '-Archive', archive, '-Destination', extracted], { timeout: 10 * 60 * 1000 });
      const exe = await findSingle(extracted, `${id}.exe`);
      const destination = path.join(root, id);
      if (id === 'ffmpeg') {
        await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
        for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await fs.copyFile(path.join(path.dirname(exe), name), path.join(destination, 'bin', name));
        await fs.copyFile(path.join(path.dirname(exe), '../LICENSE'), path.join(destination, 'LICENSE'));
      } else {
        invariant(path.basename(path.dirname(exe)) === 'bin', 'COLMAP archive has unexpected layout');
        await fs.cp(path.dirname(path.dirname(exe)), destination, { recursive: true });
        for (const record of await files(destination)) {
          if (record.path.endsWith('.pdb') || /_test\.exe$/i.test(record.path) || path.basename(record.path) === 'RUN_TESTS.bat') await fs.unlink(child(destination, record.path));
        }
        await fs.copyFile(absolute('packaging/windows-x64/licenses/COLMAP-COPYING.txt'), path.join(destination, 'COPYING.txt'));
      }
    }
    await fs.cp(brush, path.join(root, 'brush'), { recursive: true });
    await writeJson(path.join(root, 'brush/source-lock.json'), expected.source);
    await fs.copyFile(path.join(root, 'brush/BRUSH-LICENSE'), path.join(root, 'brush/LICENSE'));
    const sourceHash = await digest(path.join(root, 'brush/source-lock.json'));
    const manifest = { schema_version: 1, pack_version: expected.candidate.pack_version, platform: 'windows-x64', engines: {} };
    const mappings = { ffmpeg: { ffmpeg: 'ffmpeg/bin/ffmpeg.exe', ffprobe: 'ffmpeg/bin/ffprobe.exe' }, colmap: { colmap: 'colmap/bin/colmap.exe' }, brush: { brush: 'brush/bin/brush-cli.exe' } };
    for (const id of ['ffmpeg', 'colmap', 'brush']) {
      const source = expected.archives.components[id];
      const records = await files(path.join(root, id), root);
      manifest.engines[id] = {
        version: id === 'brush' ? expected.candidate.brush_version : source.version,
        executables: mappings[id],
        source_url: id === 'brush' ? 'https://github.com/MinKaiZhi/brush/tree/1388f74c6fe0236f68ee4915564bf00e9d2e3747' : source.source_url,
        source_sha256: id === 'brush' ? sourceHash : source.sha256,
        files: records,
        license_files: [id === 'colmap' ? 'colmap/COPYING.txt' : `${id}/LICENSE`,
          ...records.filter((record) => record.path.startsWith(`${id}/notices/`)).map((record) => record.path)],
      };
    }
    await writeJson(path.join(root, 'engine-manifest.json'), manifest);
    await writeJson(path.join(root, 'BUILD-INFO.json'), { schema_version: 1, candidate: expected.candidate, archives: expected.archives });
    for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) await fs.copyFile(absolute(name), path.join(stage, 'licenses', name));
    for (const id of ['ffmpeg', 'colmap', 'brush']) {
      await fs.mkdir(path.join(stage, 'licenses', id));
      for (const relative of manifest.engines[id].license_files) {
        const destination = child(path.join(stage, 'licenses'), relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(child(root, relative), destination);
      }
    }
    const notice = `Internal Windows alignment candidate ${expected.candidate.pack_version}\nFFmpeg GPLv3; COLMAP BSD; Brush Apache-2.0.\nLPIPS/VGG inference dependencies are excluded according to the frozen Brush recipe.\nWebView2 and MSVC runtime remain prerequisites.\nPublic distribution is blocked pending native macOS regression and complete dependency license review.\nSee engines/brush/BUILD-INFO.json and target-tree.txt for actual build provenance.\n`;
    await fs.writeFile(path.join(stage, 'licenses/THIRD_PARTY_NOTICES.md'), notice);
    // Only remove this invocation's verified staging work subtree.
    const safeWork = child(await fs.realpath(stage), '.work');
    invariant(await fs.realpath(work) === safeWork, 'Staging work directory changed identity');
    await fs.rm(safeWork, { recursive: true });
    await writeJson(path.join(stage, 'checksums.json'), await files(stage));
    await verifyPack(stage, { expected });
    await publishDirectory(stage, output);
    return output;
  } finally {
    await handle.close();
    await fs.unlink(lockFile);
  }
}

async function main(args) {
  const command = args.shift();
  const options = {};
  while (args.length) {
    const name = args.shift();
    invariant(['--output', '--cache', '--brush', '--source', '--config', '--offline', '--skip-runtime'].includes(name), `Unknown option ${name}`);
    options[name.slice(2)] = ['--offline', '--skip-runtime'].includes(name) ? true : args.shift();
  }
  if (command === 'prepare') console.log(await preparePack({ ...options, sourceRepository: options.source }));
  else if (command === 'verify') {
    const result = await verifyPack(absolute(options.output ?? 'target/distribution/windows-x64-alignment'), { runtime: !options['skip-runtime'], expected: await locks() });
    console.log(JSON.stringify({ pack_version: result.manifest.pack_version, platform: result.manifest.platform,
      integrity: 'passed', runtime_contracts: options['skip-runtime'] ? 'not_run' : 'passed',
      gpu_validation: result.gpu_validation, distribution_status: result.distribution_status }, null, 2));
  }
  else if (command === 'bundle-config') console.log(JSON.stringify(await bundleConfiguration(absolute(options.output ?? 'target/distribution/windows-x64-alignment'), options.config), null, 2));
  else throw new Error('Expected prepare, verify or bundle-config');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
