import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { repository } from './AlignmentPack.mjs';

const portable = (value) => value.split(path.sep).join('/');
async function files(directory) {
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
/** Only the selected cached bundler inputs; generated NSIS scripts are outputs. */
export async function captureBundlerInputs({ target, tools = [] }) {
  const records = [];
  const nsis = path.join(target, '.tauri/NSIS');
  for (const file of await files(nsis)) records.push(await record(`nsis/${path.relative(nsis, file)}`, file));
  if (!records.some((file) => file.path === 'nsis/Bin/makensis.exe') ||
      !records.some((file) => file.path.endsWith('/nsis_tauri_utils.dll'))) throw new Error('Complete NSIS tool cache is required before freezing bundler inputs');
  const webview = path.join(target, '.tauri/x64/d6179690-e992-460b-ae64-476693dd6a91/MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  records.push(await record('webview2/MicrosoftEdgeWebView2RuntimeInstallerX64.exe', webview));
  for (const tool of tools) records.push(await record(`tools/${tool.label}`, tool.file));
  return inventory(records);
}
export function assertBundlerUnchanged(before, after) {
  for (const value of [before, after]) {
    if (value.schema_version !== 1 || !Array.isArray(value.files) || value.digest !== inventory(value.files).digest) throw new Error('Invalid bundler receipt');
  }
  if (before.digest !== after.digest) throw new Error('Bundler inputs changed; refusing to publish');
}
export async function captureBundlerOutputs(target) {
  const base = path.join(target, 'release/nsis/x64');
  const records = [];
  for (const file of await files(base)) records.push(await record(`generated-nsis/${path.relative(base, file)}`, file));
  if (!records.some((file) => file.path === 'generated-nsis/installer.nsi')) throw new Error('Generated NSIS installer script is missing');
  return inventory(records);
}
async function main(args) {
  const [operation, target, node, pnpm, rustc, destination, outputs] = args;
  if (!['capture', 'verify'].includes(operation) || !destination) throw new Error('Expected capture|verify target node pnpm rustc receipt [outputs]');
  const cli = createRequire(path.join(repository, 'apps/desktop/package.json')).resolve('@tauri-apps/cli/package.json');
  const nativeCli = createRequire(cli).resolve('@tauri-apps/cli-win32-x64-msvc');
  const toolFiles = ['package.json', 'tauri.js', 'index.js', 'main.js'].map((name) => ({ label: `tauri/${name}`, file: path.join(path.dirname(cli), name) }));
  toolFiles.push({ label: 'tauri/native-cli.node', file: nativeCli }, { label: 'node.exe', file: node },
    { label: 'pnpm-launcher.cmd', file: pnpm }, { label: 'rustc.exe', file: rustc });
  const proof = await captureBundlerInputs({ target, tools: toolFiles });
  if (operation === 'capture') await fs.writeFile(destination, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
  else {
    assertBundlerUnchanged(JSON.parse(await fs.readFile(destination, 'utf8')), proof);
    await fs.writeFile(outputs, `${JSON.stringify(await captureBundlerOutputs(target), null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ bundler_inputs_digest: proof.digest, files: proof.files.length, status: operation }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
