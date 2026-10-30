import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryEnvironment = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG']);

export function sourceGitEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const normalized = name.toUpperCase();
    if (repositoryEnvironment.has(normalized) || /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(normalized)) delete result[name];
  }
  return result;
}

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function physicalDirectory(path) {
  if (!await info(path)) await mkdir(path);
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Generated SuperSplat source paths must be physical directories.');
  return realpath(path);
}

async function physicalMetadata(path) {
  const stat = await info(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
    if (entry.isDirectory() && !await physicalMetadata(join(path, entry.name))) return false;
  }
  return true;
}

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** Own only target/supersplat-source/upstream/.git, never a discovered parent repository. */
export async function ensureSourceRepository({ root, upstream, environment = process.env, log = () => undefined }) {
  assert(/^[a-f0-9]{40}$/.test(upstream.commit) && typeof upstream.repository === 'string' && upstream.repository,
    'Missing fixed SuperSplat repository identity.');
  let directory = await realpath(root);
  for (const name of ['target', 'supersplat-source', 'upstream']) directory = await physicalDirectory(join(directory, name));
  const source = directory;
  const gitDirectory = join(source, '.git');
  const disabledHooks = join(gitDirectory, 'metorigin-disabled-hooks');
  const env = sourceGitEnvironment(environment);
  const git = (...args) => execute('git', ['--no-replace-objects',
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'http.sslBackend=openssl',
    '-c', 'submodule.recurse=false', '-c', `core.hooksPath=${disabledHooks}`,
    '-c', `safe.directory=${source.replaceAll('\\', '/')}`,
    '--git-dir', gitDirectory, '--work-tree', source, ...args],
  { cwd: source, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

  async function identity(requireHead) {
    try {
      if (!await physicalMetadata(gitDirectory)) return null;
      for (const name of ['HEAD', 'config']) if (!(await info(join(gitDirectory, name)))?.isFile()) return null;
      if (!(await info(join(gitDirectory, 'objects')))?.isDirectory()) return null;
      if (await info(join(gitDirectory, 'commondir')) || await info(join(gitDirectory, 'gitdir'))) return null;
      const alternates = join(gitDirectory, 'objects/info/alternates');
      if (await info(alternates) && (await readFile(alternates, 'utf8')).trim()) return null;
      if (await info(disabledHooks) && (await readdir(disabledHooks)).length) return null;
      const paths = (await git('rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--is-bare-repository')).stdout.trim().split(/\r?\n/);
      if (paths.length !== 4 || paths[3] !== 'false') return null;
      if (!samePath(await realpath(resolve(source, paths[0])), source)
        || !samePath(await realpath(resolve(source, paths[1])), gitDirectory)
        || !samePath(await realpath(resolve(source, paths[2])), gitDirectory)) return null;
      if ((await git('remote', 'get-url', '--all', 'origin')).stdout.trim() !== upstream.repository) return null;
      if (!requireHead) return {};
      const head = (await git('rev-parse', '--verify', 'HEAD^{commit}')).stdout.trim();
      return /^[a-f0-9]{40}$/.test(head)
        ? { head, detached: (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim() === head } : null;
    } catch { return null; }
  }

  let changed = false;
  async function initialize() {
    // rm unlinks a .git file/symlink; it does not follow it into another checkout.
    await rm(gitDirectory, { recursive: true, force: true });
    log('Reinitializing generated SuperSplat Git metadata; installed dependencies are preserved.');
    await git('init', '--quiet', '--template=');
    await git('remote', 'add', 'origin', upstream.repository);
    assert(await identity(false), 'Generated SuperSplat Git metadata does not match its fixed repository.');
    changed = true;
  }

  async function fetchCommit() {
    log(`Fetching fixed SuperSplat source ${upstream.commit}.`);
    // Do not resolve "origin" from a restored cache or inherit the host repository.
    await git('fetch', '--no-tags', '--depth', '1', upstream.repository, upstream.commit);
    assert.equal((await git('rev-parse', '--verify', `${upstream.commit}^{commit}`)).stdout.trim(), upstream.commit);
  }

  async function containsCommit() {
    try { await git('cat-file', '-e', `${upstream.commit}^{commit}`); return true; }
    catch { return false; }
  }

  async function restoreOnce() {
    if (!await containsCommit()) await fetchCommit();
    // This generated worktree may retain tracked files after only .git was rebuilt.
    await git('checkout', '--force', '--detach', upstream.commit);
    await git('restore', '--source', upstream.commit, '--', '.');
    const current = await identity(true);
    assert(current?.head === upstream.commit && current.detached, 'SuperSplat HEAD is not detached at the fixed source commit.');
  }

  async function restore() {
    try { await restoreOnce(); }
    catch (error) {
      if (changed) throw error;
      // A cached commit may exist while its tree/index is incomplete.
      await initialize();
      await restoreOnce();
    }
  }

  const cached = await identity(true);
  if (!cached) await initialize();
  if (!cached || cached.head !== upstream.commit || !cached.detached) {
    await restore();
    changed = true;
  } else if (!await containsCommit()) {
    await fetchCommit();
  }
  return { source, git, restore, changed };
}
