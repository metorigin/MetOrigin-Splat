// Native application-core acceptance; deliberately restricted to the two agreed devices.
// This never replaces an installation or modifies the supplied input fixtures.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { createTestingOutput, parseTestingOutputArguments } from './testing-output.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseTestingOutputArguments();
const windows = process.platform === 'win32' && process.arch === 'x64';
const mac = process.platform === 'darwin' && process.arch === 'arm64';
if (!windows && !mac) throw new Error('Native Windows x64 / Apple Silicon required.');
const backend = args.arguments[0] ?? (windows ? 'auto' : 'metal');
if (!(windows ? ['auto', 'dx12', 'vulkan'] : ['metal']).includes(backend)) throw new Error('Invalid platform backend.');
const query = (program, argv) => execFileSync(program, argv, { encoding: 'utf8', windowsHide: true }).trim();
const hardware = windows
  ? query('nvidia-smi', ['--query-gpu=name,driver_version,uuid', '--format=csv,noheader'])
  : query('system_profiler', ['SPHardwareDataType', 'SPDisplaysDataType']);
if (windows ? !/RTX 5080(?: Laptop)? GPU|RTX 5080,/.test(hardware) : !/Chip:\s+Apple M1 Pro\b/.test(hardware)) {
  throw new Error('Acceptance is limited to RTX 5080 or Apple M1 Pro.');
}
const keys = ['BRUSH', 'COLMAP', 'FFMPEG', 'FFPROBE', 'IMAGE_DIR'];
for (const key of keys) {
  if (!process.env[`METORIGIN_TEST_${key}`]) throw new Error(`Set METORIGIN_TEST_${key} to a native engine or James40 images path.`);
}
const output = await createTestingOutput({ tool: `gpu-resilience-${backend}`, keep: true, reportRoot: args.reportRoot });
const receipt = {
  schema_version: 1, started_at: new Date().toISOString(), status: 'RUNNING', backend,
  hardware, os: { platform: process.platform, arch: process.arch, release: os.release(), memory_bytes: os.totalmem() },
  commit: query('git', ['-C', root, 'rev-parse', 'HEAD']),
  source_status: query('git', ['-C', root, 'status', '--short']),
  source_diff: query('git', ['-C', root, 'diff', 'HEAD', '--stat']),
  source_diff_sha256: createHash('sha256').update(execFileSync('git', ['-C', root, 'diff', 'HEAD', '--binary'], { windowsHide: true })).digest('hex'),
  scope: 'Native production Rust application core, 3000 steps, checkpoint restore, export and project reopen. GUI and installer acceptance are separate.',
  native_ui_verified: false, installer_verified: false,
  engines: {},
};
async function hash(path) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}
const persist = () => writeFile(join(output.reportDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2));
let success = false;
try {
  receipt.runner_sha256 = await hash(fileURLToPath(import.meta.url));
  receipt.untracked_source_sha256 = {};
  for (const path of query('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    receipt.untracked_source_sha256[path] = await hash(join(root, path));
  }
  for (const key of keys.filter(key => key !== 'IMAGE_DIR')) {
    const path = resolve(process.env[`METORIGIN_TEST_${key}`]);
    receipt.engines[key] = { path, sha256: await hash(path) };
  }
  if (windows) {
    for (const dll of ['dxcompiler.dll', 'dxil.dll']) {
      const path = join(dirname(receipt.engines.BRUSH.path), dll);
      receipt.engines[dll] = { path, sha256: await hash(path) };
    }
  }
  await persist();
  const projectRoot = join(output.workDirectory, 'projects');
  await mkdir(projectRoot);
  const env = { ...process.env, METORIGIN_TEST_PROJECT_ROOT: projectRoot,
    METORIGIN_TEST_ITERATIONS: '3000', METORIGIN_TEST_SYSTEM_MEMORY_BYTES: String(os.totalmem()) };
  delete env.METORIGIN_BRUSH_DEVICE_ID;
  delete env.METORIGIN_BRUSH_BACKEND;
  if (windows && backend !== 'auto') env.METORIGIN_BRUSH_BACKEND = backend;
  const test = windows ? 'real_windows_pipeline' : 'real_macos_pipeline';
  const name = windows ? 'windows_real_photos_cancel_resume_restore_to_scene_ply' : 'macos_real_photos_to_scene_ply';
  const command = ['test', '--locked', '-p', 'splat-pipeline', '--test', test, name, '--', '--ignored', '--nocapture', '--test-threads=1'];
  receipt.command = ['cargo', ...command];
  let log = '';
  const code = await new Promise((done, reject) => {
    const child = spawn('cargo', command, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', done);
  });
  await writeFile(join(output.reportDirectory, 'cargo.log'), log);
  if (code !== 0) throw new Error(`Native acceptance failed (exit ${code}); see cargo.log and preserved project logs.`);
  const projects = await readdir(projectRoot, { withFileTypes: true });
  const candidates = [];
  for (const item of projects.filter(item => item.isDirectory())) {
    try {
      await access(join(projectRoot, item.name, 'project.json'));
      await access(join(projectRoot, item.name, 'runtime/acceptance-evidence.json'));
      candidates.push(item);
    } catch { /* Incomplete directories are not successful evidence. */ }
  }
  if (candidates.length !== 1) throw new Error('Expected exactly one completed acceptance project.');
  const [project] = candidates;
  const evidence = JSON.parse(await readFile(join(projectRoot, project.name, 'runtime/acceptance-evidence.json'), 'utf8'));
  const actualBackend = evidence.profile.brush.backend;
  if ((backend !== 'auto' && actualBackend !== backend) || (windows && !/RTX 5080/.test(evidence.profile.brush.probe_result.device_name))) {
    throw new Error('Actual probe backend/device differs from requested acceptance hardware.');
  }
  if (mac && !/Apple M1 Pro\b/.test(evidence.profile.brush.probe_result.device_name)) throw new Error('Actual Metal adapter is not Apple M1 Pro.');
  for (const [key, engine] of Object.entries(receipt.engines)) {
    if (await hash(engine.path) !== engine.sha256) throw new Error(`Engine dependency changed during acceptance: ${key}`);
  }
  receipt.evidence = evidence;
  receipt.status = 'PASS';
  success = true;
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = String(error);
  process.exitCode = 1;
} finally {
  receipt.completed_at = new Date().toISOString();
  await persist();
  try {
    const result = output.finish({ success });
    process.stdout.write(`\nEvidence: ${result.reportDirectory}\n`);
  } catch (error) {
    // Publication is separate from the observed native test result. Preserve the
    // original project and reports when a Windows directory is still held open.
    receipt.publication_error = String(error);
    await persist();
    process.stderr.write(`\nReport publication failed; original evidence retained at ${output.reportDirectory}\n`);
    process.exitCode = 1;
  }
}
