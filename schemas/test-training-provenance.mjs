#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const schemas = dirname(fileURLToPath(import.meta.url));
const fixtures = join(schemas, 'examples', 'training-state');
const ajv = process.argv[2] ?? 'ajv';
const files = readdirSync(fixtures).filter(name => /\.(valid|invalid)\.json$/.test(name));
for (const name of files.sort()) {
  const schema = name.startsWith('archive') ? 'training-archive-journal.schema.json' : 'training-state.schema.json';
  const result = spawnSync(ajv, ['validate', '--spec=draft2020', '--strict=false',
    '-s', join(schemas, schema), '-d', resolve(fixtures, name)], { encoding: 'utf8' });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Schema validator could not run for ${name}: ${result.error ?? result.stderr}`);
  }
  const expected = name.endsWith('.valid.json') ? 0 : 1;
  if (result.status !== expected) {
    throw new Error(`Unexpected schema result for ${name}:\n${result.stdout}\n${result.stderr}`);
  }
  if (expected === 1 && !result.stdout.includes(`${resolve(fixtures, name)} invalid`) &&
      !result.stderr.includes(`${resolve(fixtures, name)} invalid`)) {
    throw new Error(`Expected a fixture rejection, not a schema/tool failure: ${name}\n${result.stderr}`);
  }
}
console.log(`Training-provenance schema: ${files.length} accepted/rejected fixtures passed.`);
