#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const schemas = dirname(fileURLToPath(import.meta.url));
const fixtures = join(schemas, 'examples', 'checkpoint-restore');
const ajv = process.argv[2] ?? 'ajv';
const files = readdirSync(fixtures).filter(name => /\.(valid|invalid)\.json$/.test(name));
if (!files.some(name => name.endsWith('.valid.json')) || !files.some(name => name.endsWith('.invalid.json'))) {
  throw new Error('Both accepted and rejected checkpoint-restore fixtures are required.');
}
for (const name of files.sort()) {
  const fixture = resolve(fixtures, name);
  const result = spawnSync(ajv, ['validate', '--spec=draft2020', '--strict=false',
    '-s', join(schemas, 'checkpoint-restore.schema.json'), '-d', fixture], { encoding: 'utf8' });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Schema validator could not run for ${name}: ${result.error ?? result.stderr}`);
  }
  const expected = name.endsWith('.valid.json') ? 0 : 1;
  if (result.status !== expected || (expected === 1 &&
      !`${result.stdout}\n${result.stderr}`.includes(`${fixture} invalid`))) {
    throw new Error(`Unexpected schema result for ${name}:\n${result.stdout}\n${result.stderr}`);
  }
}
console.log(`Checkpoint-restore schema: ${files.length} accepted/rejected fixtures passed.`);
