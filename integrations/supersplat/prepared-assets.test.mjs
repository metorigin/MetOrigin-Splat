import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inventoryPreparedAssets, overlayIdentity, verifyPreparedAssets, verifyPreparedCodec } from './prepared-assets.mjs';
import { themeInputs } from './ui-theme/apply.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const integration = dirname(fileURLToPath(import.meta.url));

test('fixed source preparation repairs a CRLF cache without deleting installed dependencies', async t => {
  const source = await mkdtemp(join(tmpdir(), 'supersplat-git-bytes-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const globalConfig = join(source, 'fixture-global.gitconfig');
  await writeFile(globalConfig, '');
  const execute = promisify(execFile);
  const run = (command, args) => execute(command, args, {
    cwd: source,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  const rawGit = (...args) => run('git', args);
  const files = new Map([
    ['src/main.ts', 'export const main = true;\n'],
    ['src/ui/menu.ts', 'export const menu = true;\n'],
    ['src/splat-serialize.ts', 'export const serializer = true;\n'],
    ['package-lock.json', '{"lockfileVersion":3}\n'],
  ]);
  await rawGit('init', '--quiet', '--initial-branch=fixture');
  for (const [name, bytes] of files) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), bytes);
  }
  await rawGit('-c', 'core.autocrlf=false', 'add', '--', ...files.keys());
  await rawGit('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixed LF fixture');
  const upstream = { commit: (await rawGit('rev-parse', 'HEAD')).stdout.trim() };
  await rawGit('config', 'core.autocrlf', 'true');
  await rawGit('config', 'core.eol', 'crlf');
  for (const name of files.keys()) await rm(join(source, name));
  await rawGit('restore', '--source', upstream.commit, '--', '.');
  assert((await readFile(join(source, 'src/splat-serialize.ts'))).includes(Buffer.from('\r\n')));
  await mkdir(join(source, 'node_modules'));
  await writeFile(join(source, 'node_modules/installed-marker'), 'keep dependencies');
  await writeFile(join(source, 'src/generated-bridge.ts'), 'keep generated input');

  // Exercise the production Git invocation and restore operation against an
  // independent cache with Windows EOL settings, without preparing the editor.
  const preparation = await readFile(join(integration, 'prepare.mjs'), 'utf8');
  const definition = preparation.split('\n').find(line => line.startsWith('const git = '));
  const restore = preparation.split('\n').find(line => line.startsWith("await git('-C', source, 'restore'"));
  assert(definition && restore, 'Missing fixed-source Git preparation operations.');
  const git = new Function('run', 'source', `${definition}\nreturn git;`)(run, source);
  await git('-C', source, 'checkout', '--detach', upstream.commit);
  await new Function('git', 'source', 'upstream', `return (async () => { ${restore} })();`)(git, source, upstream);
  for (const [name, bytes] of files) assert((await readFile(join(source, name))).equals(Buffer.from(bytes)), `Changed upstream bytes: ${name}`);
  assert.equal(await readFile(join(source, 'node_modules/installed-marker'), 'utf8'), 'keep dependencies');
  assert.equal(await readFile(join(source, 'src/generated-bridge.ts'), 'utf8'), 'keep generated input');
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'supersplat-配套 assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const overlay = { manifest: { id: 'derived-test', build_evidence_sha256: 'b'.repeat(64) },
    digest: 'a'.repeat(64), files: new Map([
      ['lib/webp.wasm', Buffer.from('paired-wasm')],
      ['lib/webp.mjs', Buffer.from('paired-glue')],
      ['dist/index.mjs', Buffer.from('paired-derived-js')],
    ]) };
  await mkdir(join(root, 'static/lib/webp'), { recursive: true });
  for (const name of ['index.html', 'index.js', 'index.css', 'index.css.map', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    await writeFile(join(root, name), name);
  }
  await writeFile(join(root, 'static/lib/webp/webp.wasm'), overlay.files.get('lib/webp.wasm'));
  await writeFile(join(root, 'static/lib/webp/webp.mjs'), overlay.files.get('lib/webp.mjs'));
  await mkdir(join(root, 'theme-fonts'));
  for (const name of ['inter.woff2', 'jetbrains-mono.woff2', 'inter.woff2.LICENSE', 'jetbrains-mono.woff2.LICENSE']) {
    await writeFile(join(root, 'theme-fonts', name), name);
  }
  for (const name of ['JAN-LICENSE.txt', 'APACHE-2.0.txt']) await writeFile(join(root, name), name);
  await writeFile(join(root, 'ui-theme.json'), JSON.stringify({ version: 'jan-v1', inputs: await themeInputs(integration) }));
  await writeFile(join(root, 'index.js.map'), JSON.stringify({
    sources: ['../node_modules/@playcanvas/splat-transform/dist/index.mjs', '../src/ui/metorigin-theme.ts'],
    sourcesContent: ['paired-derived-js', await readFile(join(integration, 'ui-theme/runtime.ts'), 'utf8')],
  }));
  const signature = 'c'.repeat(64);
  async function record() {
    await writeFile(join(root, 'build.json'), JSON.stringify({ signature,
      webp_overlay: overlayIdentity(overlay), assets: await inventoryPreparedAssets(root) }));
  }
  await record();
  return { root, overlay, signature, record };
}

test('cache accepts the complete paired asset set, including paths with spaces', async (t) => {
  const { root, overlay, signature } = await fixture(t);
  assert.equal((await verifyPreparedAssets(root, signature, overlay)).assets.length, 16);
  await assert.rejects(verifyPreparedAssets(root, 'd'.repeat(64), overlay), /different preparation/);
});

test('cache rejects modified or unexpected files even when required files remain', async (t) => {
  const { root, overlay, signature } = await fixture(t);
  await writeFile(join(root, 'index.js'), 'changed-js');
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /inventory changed/);
  await writeFile(join(root, 'index.js'), 'index.js');
  await writeFile(join(root, 'stale-worker.js'), 'old worker');
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /inventory changed/);
});

test('a refreshed inventory cannot hide an old WASM or old derived module', async (t) => {
  const { root, overlay, signature, record } = await fixture(t);
  await writeFile(join(root, 'static/lib/webp/webp.wasm'), 'old-wasm');
  await record();
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /WASM differs/);
  await writeFile(join(root, 'static/lib/webp/webp.wasm'), overlay.files.get('lib/webp.wasm'));
  const map = JSON.parse(await readFile(join(root, 'index.js.map'), 'utf8'));
  map.sourcesContent[0] = 'original-unmodified-npm-module';
  await writeFile(join(root, 'index.js.map'), JSON.stringify(map));
  await record();
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /paired derived/);
});

test('missing or duplicate module source-map entries cannot prove pairing', async (t) => {
  const { root, overlay } = await fixture(t);
  const source = '../node_modules/@playcanvas/splat-transform/dist/index.mjs';
  for (const sources of [[], [source, source]]) {
    await writeFile(join(root, 'index.js.map'), JSON.stringify({ sources,
      sourcesContent: sources.map(() => 'paired-derived-js') }));
    await assert.rejects(verifyPreparedCodec(root, overlay), /paired derived/);
  }
});

test('a refreshed inventory cannot hide the old standalone static glue', async (t) => {
  const { root, overlay, signature, record } = await fixture(t);
  await writeFile(join(root, 'static/lib/webp/webp.mjs'), 'old-static-glue');
  await record();
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /static WebP glue differs/);
});

test('3.7 uses package-bundled glue while still rejecting mismatched optional static glue', async (t) => {
  const { root, overlay, signature, record } = await fixture(t);
  overlay.manifest.base = { version: '3.10.2' };
  await rm(join(root, 'static/lib/webp/webp.mjs'));
  await record();
  assert.equal((await verifyPreparedAssets(root, signature, overlay)).assets.length, 15);
  assert.equal((await verifyPreparedCodec(root, overlay)).glue_sha256, null);
  await writeFile(join(root, 'static/lib/webp/webp.mjs'), 'stale-unpaired-glue');
  await record();
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /static WebP glue differs/);
});

test('a refreshed inventory cannot hide an old or missing UI theme runtime', async (t) => {
  const { root, overlay, signature, record } = await fixture(t);
  const map = JSON.parse(await readFile(join(root, 'index.js.map'), 'utf8'));
  map.sourcesContent[1] = 'old-theme-runtime';
  await writeFile(join(root, 'index.js.map'), JSON.stringify(map)); await record();
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /paired UI theme runtime/);
  await rm(join(root, 'theme-fonts/inter.woff2'));
  await assert.rejects(record(), /Missing SuperSplat asset/);
});

test('asset and build metadata symlinks are rejected', async (t) => {
  const { root, overlay, signature } = await fixture(t);
  await writeFile(join(root, 'other.json'), await readFile(join(root, 'build.json')));
  await rm(join(root, 'build.json'));
  await symlink('other.json', join(root, 'build.json'));
  await assert.rejects(verifyPreparedAssets(root, signature, overlay), /regular file/);
  await rm(join(root, 'build.json'));
  await symlink('index.js', join(root, 'linked.js'));
  await assert.rejects(inventoryPreparedAssets(root), /symlink/);
});
