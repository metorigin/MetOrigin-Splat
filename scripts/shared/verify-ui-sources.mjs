import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCopiedUiEvidence } from './copied-ui-evidence.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = collectCopiedUiEvidence(root, resolve(root, 'target/ui-source-evidence'));
console.log(`Verified ${evidence.components.reduce((sum, group) => sum + group.files.length, 0)} copied UI inputs and their fixed license/notice texts.`);
