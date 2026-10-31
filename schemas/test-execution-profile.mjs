#!/usr/bin/env node
// Uses the same ajv-cli/draft2020 validator as the repository schema CI job.
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const schemas = dirname(fileURLToPath(import.meta.url));
const fixtures = join(schemas, 'examples', 'execution-profile');
// A direct JS entry point also works on Windows, where spawnSync cannot execute
// the npm .cmd shim without a shell. Keep every validator argument structured.
const ajv = process.argv[2] ?? 'ajv';
const jsValidator = /\.[cm]?js$/i.test(ajv);
const executable = jsValidator ? process.execPath : ajv;
const validatorPrefix = jsValidator ? [resolve(ajv)] : [];
const files = readdirSync(fixtures).filter(name => /\.(valid|invalid)\.json$/.test(name));
if (!files.some(name => name.endsWith('.valid.json')) || !files.some(name => name.endsWith('.invalid.json'))) {
  throw new Error('Both accepted and rejected execution-profile fixtures are required.');
}
for (const name of files.sort()) {
  const result = spawnSync(executable, [...validatorPrefix, 'validate', '--spec=draft2020', '--strict=false',
    '-s', join(schemas, 'execution-profile.schema.json'), '-d', resolve(fixtures, name)],
  { encoding: 'utf8' });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Schema validator could not run for ${name}: ${result.error ?? result.stderr}`);
  }
  const expected = name.endsWith('.valid.json') ? 0 : 1;
  if (result.status !== expected) {
    throw new Error(`Unexpected schema result for ${name}:\n${result.stdout}\n${result.stderr}`);
  }
  // Ajv uses status 1 for compile errors too: ensure a rejection identifies the data.
  if (expected === 1 && !result.stdout.includes(`${resolve(fixtures, name)} invalid`) &&
      !result.stderr.includes(`${resolve(fixtures, name)} invalid`)) {
    throw new Error(`Expected a fixture rejection, not a schema/tool failure: ${name}\n${result.stderr}`);
  }
}
console.log(`Execution-profile schema: ${files.length} accepted/rejected fixtures passed.`);
