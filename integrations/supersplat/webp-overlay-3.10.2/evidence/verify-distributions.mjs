import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
const base = new URL('./sources/splat-transform/', import.meta.url);
const require = createRequire(new URL('package.json', base));
const esm = await import(new URL('dist/index.mjs', base));
const cjsPath = fileURLToPath(new URL('dist/index.cjs', base));
const originalCjsPath = fileURLToPath(new URL('./originals/package/dist/index.cjs', import.meta.url));
const directCjs = [];
for (const [label,path] of [['candidate',cjsPath],['baseline',originalCjsPath]]) {
  try { require(path); directCjs.push({label,status:'passed'}); }
  catch(error) { directCjs.push({label,status:'failed',message:error.message}); }
}
assert.equal(directCjs[0].message,directCjs[1].message,'same existing CJS dependency interop limitation');
const playcanvas = await import(new URL('node_modules/playcanvas/build/playcanvas/src/index.js',base));
function loadCjsWithExternalAdapter(path) {
  const mod = new Module(path); mod.filename=path;
  const localRequire=createRequire(path);
  mod.require=name=>name==='playcanvas'?playcanvas:localRequire(name);
  mod._compile(readFileSync(path,'utf8'),path);
  return mod.exports;
}
const cjs = loadCjsWithExternalAdapter(cjsPath);
const original = await import(new URL('./originals/package/dist/index.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('lib/webp.wasm', base));
const rgba = Uint8Array.from({length: 7 * 5 * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 37 + 23) % 256);
const results = [];
for (const [name, mod] of [['esm', esm], ['cjs', cjs]]) {
  assert.deepEqual(Object.keys(mod).sort(), Object.keys(original).sort());
  mod.WebPCodec.wasmUrl = wasm;
  mod.WorkerQueue.maxWorkers = 1;
  const codec = await mod.WebPCodec.create();
  const encoded = codec.encodeLosslessRGBA(rgba, 7, 5);
  assert.deepEqual(codec.decodeRGBA(encoded).rgba, rgba);
  const transferred = rgba.slice();
  assert.equal(mod.WorkerQueue.isInline, false);
  const fromWorker = await mod.WorkerQueue.run('encodeWebp', {rgba: transferred, width: 7, height: 5, effort:3}, [transferred.buffer]);
  assert.equal(transferred.byteLength, 0, 'buffer detached: real worker transport used');
  assert.equal(mod.WorkerQueue.isInline, false, 'did not fall back inline');
  assert.deepEqual(codec.decodeRGBA(fromWorker).rgba, rgba);
  await mod.WorkerQueue.destroy();
  results.push({entry: name, exports_count: Object.keys(mod).length, codec_roundtrip: true, real_worker_queue_roundtrip: true});
}
const worker = new Worker(new URL('dist/worker.mjs', base));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('worker timeout')), 20000);
  worker.on('error', reject);
  worker.on('message', async message => {
    try {
      if (message.type === 'ready') {
        worker.postMessage({type: 'init', wasmUrl: wasm});
        worker.postMessage({type: 'task', task: 'encodeWebp', args: {rgba, width: 7, height: 5, effort:3}});
      } else if (message.type === 'result') {
        assert.deepEqual((await esm.WebPCodec.create()).decodeRGBA(message.result).rgba, rgba);
        clearTimeout(timer); resolve();
      } else if (message.type === 'error') { throw new Error(message.message); }
    } catch (error) {clearTimeout(timer); reject(error);}
  });
});
await worker.terminate();
const glue = readFileSync(new URL('lib/webp.mjs', base), 'utf8');
const sourceMapBindings=[];
const codecSource=readFileSync(new URL('src/lib/utils/webp-codec.ts',base),'utf8');
for(const name of ['index.mjs','index.cjs','worker.mjs','cli.mjs']) {
  const map=JSON.parse(readFileSync(new URL('dist/'+name+'.map',base),'utf8'));
  const idx=map.sources.findIndex(p=>p.endsWith('/lib/webp.mjs'));
  assert.ok(idx>=0);assert.equal(map.sourcesContent[idx],glue);
  const codecIdx=map.sources.findIndex(p=>p.endsWith('/src/lib/utils/webp-codec.ts'));
  assert.ok(codecIdx>=0);assert.equal(map.sourcesContent[codecIdx],codecSource);
  sourceMapBindings.push({entry:name,source:map.sources[idx],glue_sha256:createHash('sha256').update(map.sourcesContent[idx]).digest('hex'),codec_source_sha256:createHash('sha256').update(codecSource).digest('hex'),entry_sha256:createHash('sha256').update(readFileSync(new URL('dist/'+name,base))).digest('hex')});
}
console.log(JSON.stringify({status:'passed-with-known-limitations',direct_cjs_baseline_comparison:directCjs,cjs_test_adapter:'Actual PlayCanvas ESM exports supplied as external to CJS bundle; ordinary Node require fails identically in baseline and candidate.',results,direct_built_worker:true,source_map_bindings:sourceMapBindings,limitations:['Node runtime only; browser/native full-app acceptance remains separate.']},null,2));
