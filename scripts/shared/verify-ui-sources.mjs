import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync, writeFileSync } from 'node:fs';
import { collectCopiedUiEvidence } from './copied-ui-evidence.mjs';
import { createTestingOutput, parseTestingOutputArguments } from './testing-output.mjs';
const root = resolve(dirname(realpathSync.native(fileURLToPath(import.meta.url))), '../..');

export async function verifyUiSources(options = {}) {
  const output = await createTestingOutput({ tool: 'ui-sources', ...options });
  let evidence;
  let failure;
  try {
    evidence = collectCopiedUiEvidence(options.repositoryRoot ?? root, output.workDirectory);
    writeFileSync(resolve(output.reportDirectory, 'source-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    failure = error;
    writeFileSync(resolve(output.reportDirectory, 'failure.json'), `${JSON.stringify({ status: 'FAIL', message: error.message }, null, 2)}\n`);
  }
  const published = output.finish({ success: !failure });
  if (failure) { failure.reportDirectory = published.reportDirectory; throw failure; }
  return { evidence, ...published, temporaryDirectory: output.temporaryDirectory };
}

let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync.native(process.argv[1]); } catch { /* Not a file entry point. */ }
if (invokedPath && relative(invokedPath, realpathSync.native(fileURLToPath(import.meta.url))) === '') {
  const options = parseTestingOutputArguments();
  if (options.arguments.length) throw new Error('Usage: verify-ui-sources.mjs [--keep] [--report DIR]');
  const result = await verifyUiSources(options);
  console.log(`Verified ${result.evidence.components.reduce((sum, group) => sum + group.files.length, 0)} copied UI inputs and their fixed license/notice texts. Report: ${result.reportDirectory}`);
}
