#!/usr/bin/env node
// Bind the embedded frontend's source inputs to the selected license evidence.
// Final app hashing remains verify-app.py's responsibility; this is not binary extraction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayIdentity, verifyPreparedAssets } from '../../integrations/supersplat/prepared-assets.mjs';
import { currentSupersplatEvidenceInputs } from '../shared/supersplat-evidence.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifySupersplatInputs(root, licenseRoot, includeDist = false) {
  const { overlay, signature, publicRoot, built } = await currentSupersplatEvidenceInputs(root);
  const publicBuild = await readFile(join(publicRoot, 'build.json'));
  const licenseBuild = await readFile(join(licenseRoot, 'supersplat/build.json'));
  assert.ok(publicBuild.equals(licenseBuild), 'SuperSplat payload differs from the selected license collection.');
  const licenseOverlay = await readFile(join(licenseRoot, 'vendored/webp/manifest.json'));
  assert.equal(hash(licenseOverlay), overlay.digest, 'WebP overlay differs from the selected license collection.');
  if (includeDist) {
    const dist = join(root, 'apps/desktop/dist/supersplat');
    await verifyPreparedAssets(dist, signature, overlay);
    assert.ok(publicBuild.equals(await readFile(join(dist, 'build.json'))), 'Embedded frontend dist differs from public inputs.');
  }
  return { schema_version: 1, input_identity: {
    signature, webp_overlay: overlayIdentity(overlay), build_json_sha256: hash(publicBuild), assets: built.assets,
  }, dist_verified: includeDist,
  scope: 'Checksummed prepared public assets and selected notices; optional exact Vite dist copy. Tauri embeds these frontend inputs, so final executable identity is verified separately.' };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  let licenseRoot, reportPath, expectedPath, includeDist = false;
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--dist') includeDist = true;
    else if (['--license-root', '--report', '--expected-report'].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--license-root') licenseRoot = resolve(value);
      else if (flag === '--report') reportPath = resolve(value);
      else expectedPath = resolve(value);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!licenseRoot) throw new Error('--license-root is required.');
  const report = await verifySupersplatInputs(root, licenseRoot, includeDist);
  if (expectedPath) {
    const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    assert.deepEqual(report.input_identity, expected.input_identity, 'SuperSplat inputs changed during packaging.');
  }
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ verified: true, dist_verified: report.dist_verified,
    asset_count: report.input_identity.assets.length, webp_overlay: report.input_identity.webp_overlay }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
