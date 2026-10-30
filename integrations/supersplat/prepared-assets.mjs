import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeInputs } from './ui-theme/apply.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = ['index.html', 'index.js', 'index.js.map', 'index.css', 'index.css.map', 'LICENSE',
  'THIRD_PARTY_NOTICES.txt', 'static/lib/webp/webp.wasm',
  'ui-theme.json', 'theme-fonts/inter.woff2', 'theme-fonts/inter.woff2.LICENSE',
  'theme-fonts/jetbrains-mono.woff2', 'theme-fonts/jetbrains-mono.woff2.LICENSE', 'JAN-LICENSE.txt', 'APACHE-2.0.txt'];

export function overlayIdentity(overlay) {
  return { id: overlay.manifest.id, manifest_sha256: overlay.digest,
    build_evidence_sha256: overlay.manifest.build_evidence_sha256 };
}

export async function preparationSignature(integration, upstream, bridge, overlay) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ upstream, bridge, overlay: overlayIdentity(overlay) }));
  for (const name of ['prepare.mjs', 'source-checkout.mjs', 'prepared-assets.mjs', 'webp-overlay.mjs', 'webp-evidence.mjs']) {
    hash.update('\0' + name + '\0').update(await readFile(join(integration, name)));
  }
  if (overlay.manifest.base?.version === '3.10.2') {
    for (const name of ['overlay.mjs', 'verify-evidence.mjs', 'profile.mjs']) {
      const path = `webp-overlay-3.10.2/${name}`;
      hash.update('\0' + path + '\0').update(await readFile(join(integration, path)));
    }
  }
  hash.update(JSON.stringify(await themeInputs(integration)));
  return hash.digest('hex');
}

// The cache is a complete inventory, not merely a list of files that exist.
// Reject links even when they point back into the generated directory.
export async function inventoryPreparedAssets(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('SuperSplat assets must be a physical directory.');
  const files = [];
  const names = new Set();
  async function visit(folder, prefix) {
    for (const name of (await readdir(folder)).sort()) {
      const relative = prefix + name;
      const path = join(folder, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`SuperSplat asset is a symlink: ${relative}`);
      if (info.isDirectory()) await visit(path, relative + '/');
      else if (info.isFile()) {
        if (relative === 'build.json') continue;
        if (names.has(relative.toLowerCase())) throw new Error(`Duplicate SuperSplat asset: ${relative}`);
        names.add(relative.toLowerCase());
        const bytes = await readFile(path);
        files.push({ path: relative, size_bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`SuperSplat asset is not a regular file: ${relative}`);
    }
  }
  await visit(directory, '');
  for (const name of required) {
    if (!files.some((file) => file.path === name)) throw new Error(`Missing SuperSplat asset: ${name}`);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyPreparedCodec(directory, overlay) {
  const wasm = await readFile(join(directory, 'static/lib/webp/webp.wasm'));
  if (!wasm.equals(overlay.files.get('lib/webp.wasm'))) throw new Error('SuperSplat WebP WASM differs from its paired overlay.');
  let glue;
  try { glue = await readFile(join(directory, 'static/lib/webp/webp.mjs')); }
  catch (error) {
    if (error.code !== 'ENOENT' || overlay.manifest.base?.version !== '3.10.2') throw error;
  }
  if (glue && !glue.equals(overlay.files.get('lib/webp.mjs'))) throw new Error('SuperSplat static WebP glue differs from its paired overlay.');
  const map = JSON.parse(await readFile(join(directory, 'index.js.map'), 'utf8'));
  if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)
    || map.sources.length !== map.sourcesContent.length) throw new Error('SuperSplat source map is incomplete.');
  const source = '../node_modules/@playcanvas/splat-transform/dist/index.mjs';
  const matches = map.sources.flatMap((name, index) => name === source ? [index] : []);
  if (matches.length !== 1 || typeof map.sourcesContent[matches[0]] !== 'string'
    || !Buffer.from(map.sourcesContent[matches[0]]).equals(overlay.files.get('dist/index.mjs'))) {
    throw new Error('SuperSplat source map does not contain the paired derived splat-transform module.');
  }
  return { wasm_sha256: sha256(wasm), glue_sha256: glue ? sha256(glue) : null,
    derived_module_sha256: sha256(overlay.files.get('dist/index.mjs')) };
}

export async function verifyPreparedAssets(directory, signature, overlay) {
  const buildPath = join(directory, 'build.json');
  if (!(await lstat(buildPath)).isFile()) throw new Error('SuperSplat build identity must be a regular file.');
  const built = JSON.parse(await readFile(buildPath, 'utf8'));
  if (built.signature !== signature || JSON.stringify(built.webp_overlay) !== JSON.stringify(overlayIdentity(overlay))) {
    throw new Error('SuperSplat build belongs to different preparation inputs.');
  }
  const actual = await inventoryPreparedAssets(directory);
  if (JSON.stringify(built.assets) !== JSON.stringify(actual)) throw new Error('SuperSplat prepared asset inventory changed.');
  await verifyPreparedCodec(directory, overlay);
  const theme = JSON.parse(await readFile(join(directory, 'ui-theme.json'), 'utf8'));
  const integration = dirname(fileURLToPath(import.meta.url));
  if (theme.version !== 'jan-v1' || JSON.stringify(theme.inputs) !== JSON.stringify(await themeInputs(integration))) {
    throw new Error('SuperSplat theme belongs to different preparation inputs.');
  }
  const map = JSON.parse(await readFile(join(directory, 'index.js.map'), 'utf8'));
  const themeSources = map.sources.flatMap((name, index) => name === '../src/ui/metorigin-theme.ts' ? [index] : []);
  if (themeSources.length !== 1 || map.sourcesContent[themeSources[0]] !== await readFile(join(integration, 'ui-theme/runtime.ts'), 'utf8')) {
    throw new Error('SuperSplat source map does not contain the paired UI theme runtime.');
  }
  return built;
}
