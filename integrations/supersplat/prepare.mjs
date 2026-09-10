import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const integration = dirname(fileURLToPath(import.meta.url));
const root = resolve(integration, '../..');
const upstream = JSON.parse(await readFile(join(integration, 'upstream.json'), 'utf8'));
const source = join(root, 'target/supersplat-source/upstream');
const destination = join(root, 'apps/desktop/public/supersplat');
const bridge = await readFile(join(integration, 'metorigin-bridge.ts'), 'utf8');
const signature = createHash('sha256').update(upstream.commit).update(bridge)
  .update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const exists = (path) => access(path).then(() => true, () => false);
if (await exists(join(destination, 'build.json'))) {
  const previous = JSON.parse(await readFile(join(destination, 'build.json'), 'utf8'));
  const required = ['index.html', 'index.js', 'index.css', 'static/lib/webp/webp.wasm', 'THIRD_PARTY_NOTICES.txt'];
  if (previous.signature === signature && (await Promise.all(required.map((name) => exists(join(destination, name))))).every(Boolean)) process.exit(0);
}
const run = (command, args, cwd = root, env = process.env) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${code})`)));
});
const git = (...args) => run('git', ['-c', 'http.sslBackend=openssl', '-c', `safe.directory=${source.replaceAll('\\', '/')}`, ...args]);
await mkdir(dirname(source), { recursive: true });
if (!await exists(join(source, '.git'))) await git('clone', '--no-checkout', '--filter=blob:none', upstream.repository, source);
await git('-C', source, 'fetch', '--depth', '1', 'origin', upstream.commit);
await git('-C', source, 'checkout', '--detach', upstream.commit);
// These files are generated in target/, never in the user's checkout.
await git('-C', source, 'restore', '--source', upstream.commit, '--', 'src/main.ts');
await writeFile(join(source, 'src/metorigin-bridge.ts'), bridge);
const mainPath = join(source, 'src/main.ts');
let main = await readFile(mainPath, 'utf8');
if (!main.includes('    scene.start();')) throw new Error('Pinned SuperSplat startup hook changed.');
main = `import { registerMetOriginBridge } from './metorigin-bridge';\n${main}`
  .replace('    scene.start();', '    scene.start();\n    registerMetOriginBridge(events);');
await writeFile(mainPath, main);
// npm's CLI is JS; invoking via Node avoids shell quoting and visible consoles.
// Use the npm shipped beside node (also works when pnpm launches this script).
const npmPath = process.env.METORIGIN_NPM_CLI ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!await exists(npmPath)) throw new Error(`npm CLI not found: ${npmPath}. Set METORIGIN_NPM_CLI to npm-cli.js.`);
const lockHash = createHash('sha256').update(await readFile(join(source, 'package-lock.json'))).digest('hex');
const installStamp = join(source, 'node_modules/.metorigin-lock');
if (!await exists(installStamp) || (await readFile(installStamp, 'utf8')) !== lockHash) {
  await run(process.execPath, [npmPath, 'ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(root, 'target/supersplat-npm-cache'), '--fetch-retries=1', '--fetch-timeout=30000'], source);
  await writeFile(installStamp, lockHash);
}
await run(process.execPath, [join(source, 'node_modules/rollup/dist/bin/rollup'), '-c'], source, { ...process.env, BASE_HREF: './' });
await mkdir(destination, { recursive: true });
await cp(join(source, 'dist'), destination, { recursive: true });
await cp(join(source, 'LICENSE'), join(destination, 'LICENSE'));
await cp(join(source, 'LICENSE'), join(integration, 'LICENSE'));
// Keep notices for the packages actually included by Rollup, including the
// transitive runtime dependencies. Source maps retain their corresponding source.
const map = JSON.parse(await readFile(join(source, 'dist/index.js.map'), 'utf8'));
const packageDirs = new Set(map.sources.flatMap((name) => {
  const match = name.match(/\.\.\/(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  return match ? [match[1]] : [];
}));
let notices = `SuperSplat ${upstream.version}\n${upstream.repository}\nCommit: ${upstream.commit}\n\n${await readFile(join(source, 'LICENSE'), 'utf8')}\n`;
for (const relative of [...packageDirs].sort()) {
  const directory = join(source, relative);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  notices += `\n=== ${pkg.name} ${pkg.version} (${pkg.license ?? 'see license text'}) ===\n`;
  const licenses = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  for (const license of licenses) notices += `${await readFile(join(directory, license), 'utf8')}\n`;
}
await writeFile(join(destination, 'THIRD_PARTY_NOTICES.txt'), notices);
await writeFile(join(destination, 'build.json'), JSON.stringify({ ...upstream, signature }, null, 2));
console.log(`SuperSplat ${upstream.version} prepared locally (${upstream.commit}).`);
