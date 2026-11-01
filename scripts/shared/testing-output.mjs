// Disposable fixtures live in the OS temporary directory. Only the latest
// success and latest failure are published; cleanup never owns caller inputs.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifactPaths } from './artifact-paths.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const markerName = '.metorigin-test-output.json';
const identity = info => `${info.dev}:${info.ino}`;
const present = path => existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })();

function physicalDirectory(path, create = false) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) physicalDirectory(parent, create);
  if (!present(absolute) && create) mkdirSync(absolute);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Test output ancestor is not a physical directory: ${absolute}`);
  return absolute;
}

function marker(path, tool, expected) {
  // NTFS file IDs can exceed Number's integer precision.
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to clean nonphysical test output: ${path}`);
  const file = join(path, markerName);
  if (!present(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to overwrite unowned test output: ${path}`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.schema_version !== 1 || value.kind !== 'metorigin-test-output' || value.tool !== tool
      || !/^[a-f0-9-]{36}$/.test(value.token ?? '') || (expected && (value.token !== expected.token || identity(info) !== expected.inode))) {
    throw new Error(`Test output ownership changed: ${path}`);
  }
  return { token: value.token, inode: identity(info) };
}

function removeOwned(path, tool, expected) {
  physicalDirectory(dirname(path));
  marker(path, tool, expected);
  rmSync(path, { recursive: true, force: false });
}

export function parseTestingOutputArguments(args = process.argv.slice(2), env = process.env) {
  const result = { keep: /^(1|true)$/i.test(env.METORIGIN_KEEP_TEST_OUTPUT ?? ''), reportRoot: undefined, arguments: [] };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--keep') result.keep = true;
    else if (args[index] === '--report' || args[index] === '--report-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing test report directory.');
      result.reportRoot = resolve(value);
    } else result.arguments.push(args[index]);
  }
  return result;
}

export function hostTestPlatform() {
  return process.platform === 'darwin' ? 'macos-arm64' : process.platform === 'win32' ? 'windows-x64' : `${process.platform}-${process.arch}`;
}

export async function createTestingOutput(options = {}) {
  const tool = options.tool;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(tool ?? '')) throw new Error('Invalid test output tool name.');
  const platform = options.platform ?? hostTestPlatform();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(platform)) throw new Error('Invalid test output platform.');
  // The shared artifact schema defines the directory root. Linux CI can use
  // that same root without changing the two shipping platform definitions.
  const repository = resolve(options.repositoryRoot ?? repositoryRoot);
  const paths = await resolveArtifactPaths({ repositoryRoot: repository,
    platform: platform === 'windows-x64' ? platform : 'macos-arm64' });
  const policy = JSON.parse(readFileSync(join(repository, 'packaging/shared/artifact-paths.json'), 'utf8')).retention ?? {};
  if ((policy.successful_test_runs ?? 1) !== 1 || (policy.failed_test_runs ?? 1) !== 1) throw new Error('Test report slots require one current success and one current failure.');
  const toolRoot = resolve(options.reportRoot ?? join(dirname(paths.verification), platform, 'tests', tool));
  for (const name of ['.test-results', '.artifacts', 'target']) {
    const fromLegacy = relative(join(repository, name), toolRoot);
    if (!fromLegacy || (fromLegacy !== '..' && !fromLegacy.startsWith(`..${sep}`) && !isAbsolute(fromLegacy))) {
      throw new Error(`Legacy test report directories are retired: ${toolRoot}`);
    }
  }
  physicalDirectory(toolRoot, true);
  for (const name of ['current', 'failed']) {
    const path = join(toolRoot, name);
    if (present(path)) marker(path, tool);
  }
  const temporaryParent = realpathSync(options.temporaryRoot ?? tmpdir());
  physicalDirectory(temporaryParent);
  const temporary = mkdtempSync(join(temporaryParent, `metorigin-${tool}-`));
  const token = randomUUID();
  const value = { schema_version: 1, kind: 'metorigin-test-output', tool, token };
  writeFileSync(join(temporary, markerName), `${JSON.stringify(value)}\n`, { flag: 'wx' });
  const ownedTemporary = marker(temporary, tool);
  const workDirectory = join(temporary, 'work');
  const reportDirectory = join(temporary, 'report');
  mkdirSync(workDirectory);
  mkdirSync(reportDirectory);
  const keep = options.keep ?? parseTestingOutputArguments().keep;
  let finished;

  return {
    toolRoot, workDirectory, reportDirectory, temporaryDirectory: temporary,
    finalDirectory(success = true) { return join(toolRoot, success ? 'current' : 'failed'); },
    finish({ success = true } = {}) {
      if (finished) return finished;
      physicalDirectory(toolRoot);
      marker(temporary, tool, ownedTemporary);
      physicalDirectory(workDirectory);
      physicalDirectory(reportDirectory);
      const destination = join(toolRoot, success ? 'current' : 'failed');
      const previous = present(destination) ? marker(destination, tool) : undefined;
      const lock = join(toolRoot, '.publishing');
      mkdirSync(lock); // Concurrent publication must fail without deleting either run.
      writeFileSync(join(lock, markerName), JSON.stringify(value), { flag: 'wx' });
      const ownedLock = marker(lock, tool);
      const staging = join(toolRoot, `.staging-${token}`);
      const backup = join(toolRoot, `.previous-${token}`);
      let movedPrevious = false;
      let published = false;
      let ownedStaging;
      try {
        if (present(staging) || present(backup)) throw new Error('Unexpected test publication path.');
        mkdirSync(staging);
        writeFileSync(join(staging, markerName), `${JSON.stringify(value)}\n`, { flag: 'wx' });
        ownedStaging = marker(staging, tool);
        if (present(join(reportDirectory, markerName))) throw new Error('The ownership marker is reserved.');
        for (const name of readdirSync(reportDirectory)) {
          cpSync(join(reportDirectory, name), join(staging, name), { recursive: true, dereference: false, errorOnExist: true, force: false });
        }
        if (!success || keep) {
          if (present(join(staging, 'debug'))) throw new Error('The debug report path is reserved for owned fixtures.');
          cpSync(workDirectory, join(staging, 'debug'), { recursive: true, dereference: false });
        }
        writeFileSync(join(staging, 'output-lifecycle.json'), `${JSON.stringify({ schema_version: 1, tool, platform,
          status: success ? 'PASS' : 'FAIL', kept_debug: !success || keep, temporary_origin: temporary,
          published_directory: destination, completed_at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
        if (previous) {
          marker(destination, tool, previous);
          renameSync(destination, backup);
          movedPrevious = true;
        }
        renameSync(staging, destination);
        published = true;
        if (movedPrevious) removeOwned(backup, tool, previous);
        removeOwned(temporary, tool, ownedTemporary);
        finished = { reportDirectory: destination, debugDirectory: !success || keep ? join(destination, 'debug') : undefined,
          temporaryRemoved: true, success };
        return finished;
      } catch (error) {
        if (!published && movedPrevious && !present(destination)) renameSync(backup, destination);
        if (present(staging) && ownedStaging) {
          try { removeOwned(staging, tool, ownedStaging); }
          catch (cleanupError) { error.message += `; staging retained: ${cleanupError.message}`; }
        }
        // Preserve the original temporary data on any publication/cleanup error.
        error.message += `; test data retained at ${temporary}`;
        throw error;
      } finally {
        removeOwned(lock, tool, ownedLock);
      }
    },
  };
}
