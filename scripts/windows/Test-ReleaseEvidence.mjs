import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const staging = resolve(root, process.argv[2] ?? 'target/distribution/windows-x64');
const licenses = join(staging, 'licenses');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function child(base, name) {
  const path = resolve(base, name);
  const suffix = relative(base, path);
  assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), `Unsafe evidence path: ${name}`);
  return path;
}
const bom = readJson(join(licenses, 'SBOM.cdx.json'));
const readiness = readJson(join(licenses, 'release-readiness.json'));
const index = readJson(join(licenses, 'dependency-license-index.json'));
const payload = readJson(join(licenses, 'native-payload-inventory.json'));
assert.equal(bom.bomFormat, 'CycloneDX');
assert.equal(bom.specVersion, '1.6');
assert.equal(bom.compositions[0].aggregate, 'incomplete');
assert.equal(readiness.public_distribution_ready, false);
const refs = new Set([bom.metadata.component['bom-ref'], ...bom.components.map(component => component['bom-ref'])]);
assert.equal(refs.size, bom.components.length + 1, 'Duplicate component reference');
for (const node of bom.dependencies) {
  assert(refs.has(node.ref));
  for (const dep of node.dependsOn) assert(refs.has(dep), `Unknown dependency: ${dep}`);
}
for (const item of index) {
  assert(refs.has(item.component));
  assert.equal(sha256(child(licenses, item.path)), item.sha256, `License hash mismatch: ${item.path}`);
}
for (const item of payload) {
  assert.equal(sha256(child(staging, item.path)), item.sha256, `Payload hash mismatch: ${item.path}`);
}
// Generated metadata must not expose machine-local paths or cached credential URLs.
for (const name of ['SBOM.cdx.json', 'release-readiness.json', 'dependency-license-index.json', 'native-payload-inventory.json']) {
  const text = readFileSync(join(licenses, name), 'utf8');
  assert(!/"[A-Z]:[\\/]|file:\/\/|https?:\/\/[^\s"/]+:[^\s"/]+@/i.test(text), `Private path or credential URL in ${name}`);
}
const schemaDirectory = process.argv[3];
if (schemaDirectory) {
  const packageDirectory = readdirSync(join(root, 'node_modules/.pnpm')).find(name => name.startsWith('ajv@6.'));
  assert(packageDirectory, 'Installed AJV is required for optional schema validation.');
  const require = createRequire(import.meta.url);
  const Ajv = require(join(root, 'node_modules/.pnpm', packageDirectory, 'node_modules/ajv'));
  const ajv = new Ajv({ allErrors: true, schemaId: 'auto', unknownFormats: 'ignore' });
  for (const name of ['spdx.schema.json', 'jsf-0.82.schema.json']) ajv.addSchema(readJson(join(schemaDirectory, name)));
  const validate = ajv.compile(readJson(join(schemaDirectory, 'bom-1.6.schema.json')));
  assert(validate(bom), JSON.stringify(validate.errors, null, 2));
}
assert.throws(() => child(licenses, '../outside'), /Unsafe evidence path/);
console.log(`Verified ${refs.size} SBOM references, ${index.length} license hashes and ${payload.length} native payload hashes${schemaDirectory ? ' against CycloneDX 1.6 schema' : ''}.`);
