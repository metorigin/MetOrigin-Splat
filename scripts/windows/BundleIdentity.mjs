import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Tauri 2.11.4 patches UNK to NSS while bundling, then restores the raw binary.
 * This describes an expected payload; installation/extraction verifies it later.
 * No application bytes are modified by this helper.
 */
export function describeBundleBytes(raw, kind) {
  if (!['none', 'nsis'].includes(kind)) throw new Error('Unsupported application bundle identity kind');
  const result = { schema_version: 1, kind, raw_application_sha256: sha256(raw), size_bytes: raw.length,
    expected_payload_sha256: sha256(raw), payload_observation: 'expected_from_raw_build; verify_installed_bytes_separately', transform: null };
  if (kind === 'none') return result;
  const first = raw.indexOf(marker);
  if (first < 0 || raw.indexOf(marker, first + marker.length) >= 0) throw new Error('Expected exactly one Tauri bundle-type marker');
  const offset = first + marker.length;
  if (raw.subarray(offset, offset + 3).toString('ascii') !== 'UNK') throw new Error('Raw application bundle marker must be UNK');
  const patched = Buffer.from(raw);
  patched.write('NSS', offset, 'ascii');
  result.expected_payload_sha256 = sha256(patched);
  result.transform = { kind: 'tauri_windows_bundle_type_marker', from: 'UNK', to: 'NSS', offset, changed_bytes: 3,
    implementation: 'tauri-cli-v2.11.4/tauri-bundler/src/bundle.rs' };
  return result;
}

export async function describeBundleFile(application, kind) {
  return describeBundleBytes(await fs.readFile(application), kind);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [application, kind, output] = process.argv.slice(2);
  const identity = await describeBundleFile(application, kind);
  await fs.writeFile(output, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(identity));
}
