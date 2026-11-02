import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { repository } from './AlignmentPack.mjs';

const portable = (value) => value.split(path.sep).join('/');
const webviewFilename = 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe';
const webviewRelativePath = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/MicrosoftEdgeWebView2RuntimeInstallerX64\.exe$/i;
async function files(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bundler receipt requires physical tool-cache directories');
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Bundler receipt refuses tool-cache links');
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.isFile()) result.push(full);
    else throw new Error('Bundler receipt requires regular tool files');
  }
  return result;
}
async function record(label, file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Bundler input is not a regular file: ${label}`);
  return { path: portable(label), size_bytes: info.size,
    sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
}
function inventory(records) {
  records.sort((a, b) => a.path.localeCompare(b.path));
  const body = { schema_version: 1, files: records };
  return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
export async function captureBuildToolInputs(tools) {
  return inventory(await Promise.all(tools.map(tool => record(`tools/${tool.label}`, tool.file))));
}
/** Only the selected cached bundler inputs; generated NSIS scripts are outputs. */
export async function captureBundlerInputs({ target, tools = [] }) {
  const records = [];
  const nsis = path.join(target, '.tauri/NSIS');
  for (const file of await files(nsis)) records.push(await record(`nsis/${path.relative(nsis, file)}`, file));
  if (!records.some((file) => file.path === 'nsis/Bin/makensis.exe') ||
      !records.some((file) => file.path.endsWith('/nsis_tauri_utils.dll'))) throw new Error('Complete NSIS tool cache is required before freezing bundler inputs');
  // Evergreen's official redirect changes its GUID independently of the CLI.
  // Freeze every cached runtime so a newly selected/downloaded GUID cannot evade
  // the post-bundle comparison by leaving an older runtime untouched.
  const webviewRoot = path.join(target, '.tauri/x64');
  const runtimes = (await files(webviewRoot)).filter((file) => path.basename(file) === webviewFilename);
  if (!runtimes.length) throw new Error('Offline WebView2 runtime cache is missing');
  for (const file of runtimes) {
    const relative = portable(path.relative(webviewRoot, file));
    if (!webviewRelativePath.test(relative)) throw new Error('Unexpected offline WebView2 cache layout');
    records.push(await record(`webview2/${relative}`, file));
  }
  for (const tool of tools) records.push(await record(`tools/${tool.label}`, tool.file));
  return inventory(records);
}
export function assertBundlerUnchanged(before, after) {
  for (const value of [before, after]) {
    if (value.schema_version !== 1 || !Array.isArray(value.files) || value.digest !== inventory([...value.files]).digest) throw new Error('Invalid bundler receipt');
  }
  if (before.digest !== after.digest) throw new Error('Bundler inputs changed; refusing to publish');
}
function decodeNsisLiteral(value) {
  // Match the escaping used by the pinned Tauri Handlebars renderer. Do not
  // resolve NSIS variables or execute arbitrary preprocessor expressions.
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$') { decoded += value[index]; continue; }
    const next = value[++index];
    if (next === '$') { decoded += '$'; continue; }
    const escapes = { '"': '"', '`': '`', n: '\n', t: '\t', r: '\r' };
    const escaped = value[++index];
    if (next !== '\\' || !Object.hasOwn(escapes, escaped)) throw new Error('Unsupported NSIS WebView2 path expression');
    decoded += escapes[escaped];
  }
  return decoded;
}
async function verifySelectedWebview(target, script, inputs) {
  assertBundlerUnchanged(inputs, inputs);
  const modes = [...script.matchAll(/^\s*!define[ \t]+INSTALLWEBVIEW2MODE[ \t]+"([^"\r\n]*)"[ \t]*$/gmi)];
  const definitions = [...script.matchAll(/^\s*!define[ \t]+WEBVIEW2INSTALLERPATH[ \t]+"((?:\$\\"|[^"\r\n])*)"[ \t]*$/gmi)];
  const uses = [...script.matchAll(/^[ \t]*File[ \t]+"\/oname=\$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller\.exe"[ \t]+"\$\{WEBVIEW2INSTALLERPATH\}"[ \t]*$/gmi)];
  if (modes.length !== 1 || modes[0][1] !== 'offlineInstaller' || definitions.length !== 1 || uses.length !== 1) {
    throw new Error('Generated NSIS script must embed exactly one selected offline WebView2 installer');
  }
  const selected = decodeNsisLiteral(definitions[0][1]);
  const relative = portable(path.relative(path.resolve(target, '.tauri/x64'), selected));
  if (!path.isAbsolute(selected) || !webviewRelativePath.test(relative)) throw new Error('Generated NSIS WebView2 input is outside the frozen runtime cache');
  const label = `webview2/${relative}`;
  const expected = inputs.files.find((file) => process.platform === 'win32' ? file.path.toLowerCase() === label.toLowerCase() : file.path === label);
  if (!expected) throw new Error('Generated NSIS script references an unfrozen WebView2 runtime');
  const actual = await record(expected.path, selected);
  if (actual.sha256 !== expected.sha256 || actual.size_bytes !== expected.size_bytes) throw new Error('Selected NSIS WebView2 runtime differs from its frozen input');
}
export async function captureBundlerOutputs(target, inputs) {
  const base = path.join(target, 'release/nsis/x64');
  const records = [];
  for (const file of await files(base)) records.push(await record(`generated-nsis/${path.relative(base, file)}`, file));
  if (!records.some((file) => file.path === 'generated-nsis/installer.nsi')) throw new Error('Generated NSIS installer script is missing');
  await verifySelectedWebview(target, (await fs.readFile(path.join(base, 'installer.nsi'), 'utf8')).replace(/^\uFEFF/, ''), inputs);
  return inventory(records);
}
async function main(args) {
  const [operation, target, node, pnpm, rustc, destination, outputs] = args;
  if (!['capture', 'verify', 'capture-tools', 'verify-tools'].includes(operation) || !destination) throw new Error('Expected capture|verify|capture-tools|verify-tools target node pnpm rustc receipt [outputs]');
  const cli = createRequire(path.join(repository, 'apps/desktop/package.json')).resolve('@tauri-apps/cli/package.json');
  const nativeCli = createRequire(cli).resolve('@tauri-apps/cli-win32-x64-msvc');
  const toolFiles = ['package.json', 'tauri.js', 'index.js', 'main.js'].map((name) => ({ label: `tauri/${name}`, file: path.join(path.dirname(cli), name) }));
  toolFiles.push({ label: 'tauri/native-cli.node', file: nativeCli }, { label: 'node.exe', file: node },
    { label: 'pnpm-launcher.cmd', file: pnpm }, { label: 'rustc.exe', file: rustc });
  const proof = operation.endsWith('-tools') ? await captureBuildToolInputs(toolFiles) : await captureBundlerInputs({ target, tools: toolFiles });
  if (operation === 'capture' || operation === 'capture-tools') await fs.writeFile(destination, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
  else {
    const before = JSON.parse(await fs.readFile(destination, 'utf8'));
    assertBundlerUnchanged(before, proof);
    if (operation === 'verify') await fs.writeFile(outputs, `${JSON.stringify(await captureBundlerOutputs(target, before), null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ bundler_inputs_digest: proof.digest, files: proof.files.length, status: operation }));
}
const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && path.relative(invokedPath, await fs.realpath(fileURLToPath(import.meta.url))) === '') main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
