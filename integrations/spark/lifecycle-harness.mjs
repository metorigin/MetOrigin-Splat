import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packagePath = fileURLToPath(new URL('../../apps/desktop/node_modules/@sparkjsdev/spark/package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
assert.equal(packageJson.version, '2.1.0', 'Reassess lifecycle coverage before changing Spark version');
const modulePath = realpathSync(join(dirname(packagePath), 'dist/spark.module.js'));
export const implementationIdentity = {
  name: packageJson.name,
  version: packageJson.version,
  path: modulePath,
  sha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
};

// Browser boundaries only. The imported Spark and Three implementations are not patched.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel', userAgent: 'Spark lifecycle tests in Node', maxTouchPoints: 0 } });
globalThis.self = globalThis;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  assert.ok(url.startsWith('data:'), 'Lifecycle tests prohibit non-data network requests');
  return nativeFetch(input, options);
};

let activeFixture;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  // Do not intercept Node's test timeouts or the harness's own scheduling.
  if (activeFixture && new Error().stack?.includes(modulePath)) return activeFixture.clock.schedule(callback, delay, args);
  return nativeSetTimeout(callback, delay, ...args);
};
globalThis.clearTimeout = (handle) => {
  if (activeFixture?.clock.cancel(handle)) return;
  nativeClearTimeout(handle);
};

globalThis.Worker = class BrowserWorkerStub {
  constructor() {
    assert.ok(activeFixture, 'Unexpected Worker outside a lifecycle test');
    this.owner = activeFixture;
    this.terminated = false;
    this.pending = [];
    this.onmessage = null;
    this.owner.workers.push(this);
  }
  addEventListener(type) { assert.equal(type, 'error'); }
  postMessage(message, options) {
    assert.equal(this.terminated, false);
    assert.equal(message.name, 'sortSplats32');
    const request = structuredClone(message, { transfer: options.transfer });
    this.pending.push(request);
    if (this.owner.workerMode === 'reply') this.replyQueued();
  }
  resultFor(request) {
    const { readback, ordering, numSplats } = request.args;
    for (let index = 0; index < numSplats; index++) ordering[index] = index;
    return structuredClone({ id: request.id, result: { readback, ordering, activeSplats: numSplats } }, { transfer: [readback.buffer, ordering.buffer] });
  }
  replyQueued() {
    const request = this.pending.shift();
    assert.ok(request, 'No Worker request to reply to');
    const data = this.resultFor(request);
    queueMicrotask(() => { if (!this.terminated) this.onmessage({ data }); });
  }
  replyNow() {
    const request = this.pending.shift();
    assert.ok(request, 'No Worker request to reply to');
    this.onmessage({ data: this.resultFor(request) });
  }
  rejectNow(error) {
    const request = this.pending.shift();
    assert.ok(request, 'No Worker request to reject');
    this.onmessage({ data: { id: request.id, error } });
  }
  terminate() { this.terminated = true; }
};

const sparkModule = await import(pathToFileURL(modulePath).href);
const requireFromSpark = createRequire(modulePath);
const threeDirectory = dirname(dirname(requireFromSpark.resolve('three')));
export const THREE = await import(pathToFileURL(join(threeDirectory, 'build/three.module.js')).href);
const { SparkRenderer, SplatAccumulator } = sparkModule;
const lifecycleMethods = Object.fromEntries(['driveSort', 'dispose', 'readbackDepth', 'saveRenderState', 'resetRenderState', 'setDirty'].map(name => [name, SparkRenderer.prototype[name]]));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function checkpoint(predicate, label) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), `Did not reach ${label} within 40 microtask turns`);
}

function clock() {
  const entries = new Map();
  let next = 1;
  return {
    schedule(callback, delay, args) {
      const handle = { sparkTestTimer: next++ };
      entries.set(handle, { callback, delay, args });
      return handle;
    },
    cancel(handle) { return entries.delete(handle); },
    has(handle) { return entries.has(handle); },
    hasDelay(delay) { return [...entries.values()].some(entry => entry.delay === delay); },
    get size() { return entries.size; },
    fireDelay(delay) {
      const pair = [...entries].find(([, entry]) => entry.delay === delay);
      assert.ok(pair, `No pending Spark timer with delay ${delay}`);
      const [handle, entry] = pair;
      entries.delete(handle);
      entry.callback(...entry.args);
    },
    clear() { entries.clear(); },
  };
}

export function fixture(t) {
  assert.equal(activeFixture, undefined, 'Fixtures must run sequentially');
  const f = { workers: [], workerMode: 'reply', clock: clock(), disposed: false, tasks: [] };
  activeFixture = f;
  const gpu = {
    mode: 'immediate', calls: [], currentTarget: null,
    xr: { enabled: false, isPresenting: false }, autoClear: true,
    info: { render: { frame: 1 } }, properties: { has: () => false },
    getContext: () => ({}),
    getDrawingBufferSize: vector => vector.set(64, 64),
    getRenderTarget() { return this.currentTarget; },
    setRenderTarget(target) { this.currentTarget = target; },
    readRenderTargetPixelsAsync(target, x, y, width, height, destination) {
      const call = { ...deferred(), width, height, destinationBytes: destination.byteLength };
      this.calls.push(call);
      destination.fill(0);
      if (this.mode === 'immediate') call.resolve(destination);
      return call.promise;
    },
  };
  f.gpu = gpu;
  f.spark = new SparkRenderer({ renderer: gpu, sortRadial: false, enableLod: false, accumExtSplats: true, maxStdDev: 3, preBlurAmount: 0.3, blurAmount: 0 });
  assert.ok(f.spark.current instanceof SplatAccumulator);
  f.spark.current.ensureGenerate({ maxSplats: 1 });
  f.spark.current.numSplats = 1;
  for (const [name, method] of Object.entries(lifecycleMethods)) assert.equal(f.spark[name], method);
  assert.equal(f.spark.readPause, 1);

  f.start = () => {
    f.spark.sortDirty = true;
    const task = { settled: false, outcome: null };
    // Attach both handlers immediately, including cases expected to reject.
    task.result = f.spark.driveSort().then(
      value => { task.settled = true; return task.outcome = { status: 'fulfilled', value }; },
      error => { task.settled = true; return task.outcome = { status: 'rejected', error }; },
    );
    f.tasks.push(task);
    return task;
  };
  f.finish = async task => {
    await checkpoint(() => task.settled, 'driveSort settlement');
    return task.result;
  };
  f.normalSort = async () => {
    const task = f.start();
    assert.ok(f.clock.hasDelay(1), 'Use the real default readPause');
    f.clock.fireDelay(1);
    const result = await f.finish(task);
    assert.equal(result.status, 'fulfilled', String(result.error));
    return task;
  };
  f.reachReadback = async () => {
    const count = gpu.calls.length;
    const task = f.start();
    f.clock.fireDelay(1);
    await checkpoint(() => gpu.calls.length === count + 1, 'GPU readback');
    return { task, readback: gpu.calls.at(-1) };
  };
  f.reachWorker = async () => {
    f.workerMode = 'hold';
    const { task } = await f.reachReadback();
    await checkpoint(() => f.workers.at(-1)?.pending.length > 0, 'Worker request');
    return { task, worker: f.workers.at(-1) };
  };
  f.dispose = () => {
    f.disposed = true;
    f.spark.dispose();
    f.workerCountAtDispose = f.workers.length;
    f.gpuCallsAtDispose = gpu.calls.length;
    assert.equal(f.spark.sortWorker === null, true, 'dispose clears sortWorker');
    assert.equal(f.spark.orderingTexture === null, true, 'dispose clears orderingTexture');
  };
  f.assertCancelled = async task => {
    const result = await f.finish(task);
    assert.equal(result.status, 'fulfilled', `Disposal must safely settle stale work: ${String(result.error)}`);
    assert.equal(f.workers.length, f.workerCountAtDispose, 'No new Worker after disposal');
    assert.equal(gpu.calls.length, f.gpuCallsAtDispose, 'No new GPU readback after disposal');
    assert.equal(f.spark.sortWorker === null, true, 'No live sort Worker after disposal');
    assert.equal(f.spark.orderingTexture === null, true, 'No ordering texture after disposal');
    assert.equal(f.spark.sorting, false, 'Released work must not retain the sorting flag');
    assert.ok(f.workers.every(worker => worker.terminated), 'All existing Worker stubs were terminated');
  };
  t.after(() => {
    f.spark.dispose();
    f.spark.geometry.dispose();
    f.spark.material.dispose();
    for (const worker of f.workers) worker.terminate();
    f.clock.clear();
    for (const [name, method] of Object.entries(lifecycleMethods)) assert.equal(SparkRenderer.prototype[name], method);
    activeFixture = undefined;
  });
  return f;
}
