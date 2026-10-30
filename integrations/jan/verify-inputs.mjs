import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateHostTokens } from './theme.mjs';

const base = new URL('./', import.meta.url);
const index = JSON.parse(readFileSync(new URL('source-index.json', base), 'utf8'));
if (index.repository !== 'https://github.com/janhq/jan' || index.commit !== 'b8d58255baf6d9e870025d3f0c60a5b80a63143b') {
  throw new Error('Unreviewed Jan source identity');
}
for (const file of index.files) {
  if (!/^(LICENSE|web-app\/src\/[a-zA-Z0-9_./-]+)$/.test(file.upstreamPath) || file.upstreamPath.includes('..')) throw new Error('Invalid Jan source path');
  const bytes = readFileSync(new URL(`upstream/${file.upstreamPath}`, base));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha256 !== file.upstreamSha256 || blob !== file.upstreamBlobSha) throw new Error(`Jan source hash mismatch: ${file.upstreamPath}`);
}
const tokens = readFileSync(new URL('../../apps/desktop/src/styles/tokens.css', base), 'utf8');
if (tokens !== generateHostTokens()) throw new Error('Stale host theme: run node integrations/jan/theme.mjs');
const manifest = JSON.parse(readFileSync(new URL('../../apps/desktop/ui-sources.json', base), 'utf8'));
for (const entry of manifest.components.filter(entry => entry.project === 'Jan')) {
  const file = index.files.find(file => file.upstreamPath === entry.upstreamPath);
  if (!file || entry.commit !== index.commit || entry.upstreamSha256 !== file.upstreamSha256) throw new Error(`Jan mapping differs: ${entry.localPath}`);
}
console.log(`Jan inputs verified: ${index.files.length} exact source files, generated host tokens and fixed source mappings (${fileURLToPath(base)})`);
