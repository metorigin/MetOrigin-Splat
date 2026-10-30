import { rollup } from './sources/splat-transform-v2/node_modules/rollup/dist/es/rollup.js';
import { rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./sources/splat-transform-v2/', import.meta.url));
process.chdir(root);
const { default: configs } = await import('./sources/splat-transform-v2/rollup.config.mjs');
rmSync('dist', { recursive: true, force: true });
for (const { output, ...input } of configs) {
  const bundle = await rollup(input);
  try {
    const result = await bundle.write(output);
    console.log(JSON.stringify({ input: input.input, output: output.entryFileNames, written: result.output.map(o => o.fileName) }));
  } finally {
    await bundle.close();
  }
}
copyFileSync('dist/lib/index.d.ts', 'dist/lib/index.d.cts');
console.log('All five Rollup targets were written and closed; declaration compatibility copy completed.');
// Some upstream plugin retains idle handles under this pinned SDK Node. All
// awaited writes and bundle.close() calls above must succeed before this exit.
process.exit(0);
