import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyWebpOverlay, loadWebpOverlay, verifyWebpOverlayInstalled } from './webp-overlay-3.10.2/overlay.mjs';
import { inventoryPreparedAssets, overlayIdentity, preparationSignature, verifyPreparedAssets, verifyPreparedCodec } from './prepared-assets.mjs';
import { verifyWebpBuildEvidence } from './webp-evidence.mjs';
import { applyThemeSources, finishThemeAssets } from './ui-theme/apply.mjs';

const integration = dirname(fileURLToPath(import.meta.url));
const root = resolve(integration, '../..');
const upstream = JSON.parse(await readFile(join(integration, 'upstream.json'), 'utf8'));
const source = join(root, 'target/supersplat-source/upstream');
const destination = join(root, 'apps/desktop/public/supersplat');
const bridge = await readFile(join(integration, 'metorigin-bridge.ts'), 'utf8');
const overlayRoot = join(integration, 'webp-overlay-3.10.2');
const overlay = await loadWebpOverlay(overlayRoot);
const webpEvidence = await verifyWebpBuildEvidence(overlayRoot, overlay);
const signature = await preparationSignature(integration, upstream, bridge, overlay);
const transformPackage = join(source, 'node_modules/@playcanvas/splat-transform');
const exists = (path) => access(path).then(() => true, () => false);
if (await exists(join(destination, 'build.json'))) {
  try {
    await verifyPreparedAssets(destination, signature, overlay);
    await verifyWebpOverlayInstalled(transformPackage, overlay);
    process.exit(0);
  } catch (error) {
    console.log(`SuperSplat cache requires preparation: ${error.message}`);
  }
}
const run = (command, args, cwd = root, env = process.env) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${code})`)));
});
// This separate checkout has no root attributes; preserve the fixed LF blobs
// even when Git for Windows inherits core.autocrlf=true from its global config.
const git = (...args) => run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'http.sslBackend=openssl', '-c', `safe.directory=${source.replaceAll('\\', '/')}`, ...args]);
await mkdir(dirname(source), { recursive: true });
if (!await exists(join(source, '.git'))) await git('clone', '--no-checkout', '--filter=blob:none', upstream.repository, source);
// A fixed commit already available locally needs no network access to rebuild.
await git('-C', source, 'cat-file', '-e', `${upstream.commit}^{commit}`)
  .catch(() => git('-C', source, 'fetch', '--depth', '1', 'origin', upstream.commit));
await git('-C', source, 'checkout', '--detach', upstream.commit);
// Restore every tracked blob in this generated target/ checkout: changing Git's
// EOL policy alone does not rewrite a cached checkout of the same commit.
// Untracked node_modules and generated files are preserved.
await git('-C', source, 'restore', '--source', upstream.commit, '--', '.');
await applyThemeSources(integration, source);
await writeFile(join(source, 'src/metorigin-bridge.ts'), bridge);
const mainPath = join(source, 'src/main.ts');
let main = await readFile(mainPath, 'utf8');
if (!main.includes('    scene.start();')) throw new Error('Pinned SuperSplat startup hook changed.');
if (!main.includes('    registerPreferences(events, sceneConfig, urlArgs);')) throw new Error('Pinned SuperSplat preferences hook changed.');
main = `import { migrateEmbeddedOverlayDefaults } from './ui/metorigin-presentation';\nimport { registerMetOriginBridge } from './metorigin-bridge';\n${main}`
  .replace('    registerPreferences(events, sceneConfig, urlArgs);', '    migrateEmbeddedOverlayDefaults();\n    registerPreferences(events, sceneConfig, urlArgs);')
  .replace('    scene.start();', '    scene.start();\n    registerMetOriginBridge(events, scene);');
await writeFile(mainPath, main);
const lockHash = createHash('sha256').update(await readFile(join(source, 'package-lock.json'))).digest('hex');
const installStamp = join(source, 'node_modules/.metorigin-lock');
// Changing the derivative requires a fresh fixed npm base even when the
// upstream lockfile is unchanged. Never accept unrelated previous overlay bytes.
const installIdentity = JSON.stringify({ package_lock_sha256: lockHash, overlay_manifest_sha256: overlay.digest });
if (!await exists(installStamp) || (await readFile(installStamp, 'utf8')) !== installIdentity) {
  // Invoke npm's JS entrypoint without a shell. Standard Node/NVM layouts keep
  // it under ../lib; portable distributions may place it beside node. A cached
  // fixed dependency tree does not need an npm executable just to rebuild UI.
  const candidates = process.env.METORIGIN_NPM_CLI ? [process.env.METORIGIN_NPM_CLI] : [
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  let npmPath;
  for (const candidate of candidates) if (await exists(candidate)) { npmPath = candidate; break; }
  if (!npmPath) throw new Error('npm CLI not found. Set METORIGIN_NPM_CLI to npm-cli.js.');
  await run(process.execPath, [npmPath, 'ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--prefer-offline', '--cache', join(root, 'target/supersplat-npm-cache'), '--fetch-retries=1', '--fetch-timeout=30000'], source);
  await writeFile(installStamp, installIdentity);
}
// These are explicitly derived bytes, applied after every npm install. All
// entry points and their maps use the same generated glue/WASM pair.
await applyWebpOverlay(transformPackage, overlay);
await verifyWebpOverlayInstalled(transformPackage, overlay);
// SuperSplat 3.7 copies WASM from its paired splat-transform package in Rollup.
// Its JS glue is bundled from that same dependency, with no second static copy.
await rm(join(source, 'dist'), { recursive: true, force: true });
await run(process.execPath, [join(source, 'node_modules/rollup/dist/bin/rollup'), '-c'], source, { ...process.env, BASE_HREF: './' });
const prepared = join(source, 'dist');
await verifyPreparedCodec(prepared, overlay);
const themeNotices = await finishThemeAssets(integration, source, prepared);
await cp(join(source, 'LICENSE'), join(prepared, 'LICENSE'));
// Keep notices for the packages actually included by Rollup, including the
// transitive runtime dependencies. Source maps retain their corresponding source.
const map = JSON.parse(await readFile(join(source, 'dist/index.js.map'), 'utf8'));
const packageDirs = new Set(map.sources.flatMap((name) => {
  const match = name.match(/\.\.\/(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  return match ? [match[1]] : [];
}));
let notices = `SuperSplat ${upstream.version}\n${upstream.repository}\nCommit: ${upstream.commit}\n\n${await readFile(join(source, 'LICENSE'), 'utf8')}\n`;
notices += '\nMetOrigin modified the UI palette, PCUI presentation, embedded menu branding and initial overlay preferences, and UI-only histogram/performance paint. Jan design values are adapted from Menlo Research, Apache-2.0; see host copied-UI notices. Scene rendering, selection colors and serialization remain upstream.\n' + themeNotices;
for (const relative of [...packageDirs].sort()) {
  const directory = join(source, relative);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const label = pkg.name === overlay.manifest.base.name
    ? `derived from ${pkg.version}; MetOrigin overlay ${overlay.manifest.id}` : pkg.version;
  notices += `\n=== ${pkg.name} ${label} (${pkg.license ?? 'see license text'}) ===\n`;
  const licenses = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  for (const license of licenses) notices += `${await readFile(join(directory, license), 'utf8')}\n`;
}
for (const notice of webpEvidence.notices) {
  notices += `\n=== Rebuilt WebP: ${notice.component} — ${notice.path} ===\n${notice.bytes.toString('utf8')}\n`;
}
await writeFile(join(prepared, 'THIRD_PARTY_NOTICES.txt'), notices);
await writeFile(join(prepared, 'build.json'), JSON.stringify({ ...upstream, signature,
  webp_overlay: overlayIdentity(overlay), assets: await inventoryPreparedAssets(prepared) }, null, 2) + '\n');
await verifyPreparedAssets(prepared, signature, overlay);
// Publish only the fully checked generated tree, excluding stale cache files.
await rm(destination, { recursive: true, force: true });
await cp(prepared, destination, { recursive: true });
await cp(join(source, 'LICENSE'), join(integration, 'LICENSE'));
console.log(`SuperSplat ${upstream.version} prepared locally (${upstream.commit}).`);
