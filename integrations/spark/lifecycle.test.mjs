import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpoint, fixture, implementationIdentity, THREE } from './lifecycle-harness.mjs';

console.log(`Spark lifecycle implementation: ${JSON.stringify(implementationIdentity)}`);
const settings = { concurrency: false, timeout: 2000 };

test('normal sort and re-sort retain the same live Worker and ordering texture', settings, async t => {
  const f = fixture(t);
  await f.normalSort();
  const worker = f.spark.sortWorker;
  const texture = f.spark.orderingTexture;
  assert.equal(texture.isDataTexture, true);
  assert.equal(f.spark.activeSplats, 1);
  await f.normalSort();
  assert.equal(f.workers.length, 1);
  assert.equal(f.spark.sortWorker === worker, true);
  assert.equal(f.spark.orderingTexture === texture, true);
  assert.equal(f.spark.sorting, false);
});

test('onDirty sees completed sorting and may synchronously start the next sort', settings, async t => {
  const f = fixture(t);
  let nested;
  const observed = [];
  f.spark.dirty = false;
  f.spark.onDirty = () => {
    observed.push(f.spark.sorting);
    assert.equal(f.spark.sorting, false, 'onDirty runs after the completed sort releases its flag');
    if (!nested) nested = f.start();
  };
  const outer = f.start();
  f.clock.fireDelay(1);
  const result = await f.finish(outer);
  assert.equal(result.status, 'fulfilled', String(result.error));
  assert.deepEqual(observed, [false]);
  assert.ok(nested, 'onDirty started another real driveSort');
  assert.equal(nested.settled, false);
  assert.equal(f.spark.sorting, true, 'The outer finally must not clear a nested sort flag');
  assert.ok(f.clock.hasDelay(1));
  f.clock.fireDelay(1);
  assert.equal((await f.finish(nested)).status, 'fulfilled');
  assert.equal(f.spark.sorting, false);
  assert.equal(f.workers.length, 1);
});

test('dispose during default readPause safely exits before GPU readback', settings, async t => {
  const f = fixture(t);
  const task = f.start();
  assert.ok(f.clock.hasDelay(1));
  f.dispose();
  f.clock.fireDelay(1);
  await f.assertCancelled(task);
});

test('late GPU readback success cannot recreate a disposed Worker or texture', settings, async t => {
  const f = fixture(t);
  await f.normalSort();
  const priorWorker = f.workers[0];
  const priorTexture = f.spark.orderingTexture;
  let textureDisposals = 0;
  priorTexture.addEventListener('dispose', () => textureDisposals++);
  f.gpu.mode = 'deferred';
  const { task, readback } = await f.reachReadback();
  f.dispose();
  assert.equal(priorWorker.terminated, true);
  assert.equal(textureDisposals, 1);
  readback.resolve();
  await f.assertCancelled(task);
});

test('late GPU readback rejection after dispose safely settles stale work', settings, async t => {
  const f = fixture(t);
  f.gpu.mode = 'deferred';
  const { task, readback } = await f.reachReadback();
  f.dispose();
  readback.reject(new Error('readback rejected after disposal'));
  await f.assertCancelled(task);
});

test('dispose while Worker reply is pending handles real wrapper termination rejection', settings, async t => {
  const f = fixture(t);
  const { task, worker } = await f.reachWorker();
  f.dispose();
  assert.equal(worker.terminated, true);
  await f.assertCancelled(task);
});

test('a queued Worker reply cannot revive work when dispose wins delivery', settings, async t => {
  const f = fixture(t);
  const { task, worker } = await f.reachWorker();
  worker.replyQueued();
  f.dispose();
  await f.assertCancelled(task);
});

test('an already resolved Worker reply cannot install a texture after dispose', settings, async t => {
  const f = fixture(t);
  const { task, worker } = await f.reachWorker();
  // Resolve the real SplatWorker request, then dispose before await continuations.
  worker.replyNow();
  f.dispose();
  await f.assertCancelled(task);
});

test('dispose during sortPause prevents Worker creation on timer continuation', settings, async t => {
  const f = fixture(t);
  f.spark.sortPause = 7;
  const { task } = await f.reachReadback();
  await checkpoint(() => f.clock.hasDelay(7), 'sortPause');
  f.dispose();
  f.clock.fireDelay(7);
  await f.assertCancelled(task);
});

test('dispose during sortDelay prevents texture creation after a successful Worker result', settings, async t => {
  const f = fixture(t);
  f.spark.sortDelay = 9;
  const { task } = await f.reachReadback();
  await checkpoint(() => f.clock.hasDelay(9), 'sortDelay');
  f.dispose();
  f.clock.fireDelay(9);
  await f.assertCancelled(task);
});

test('dispose cancels a scheduled minSortInterval timer', settings, async t => {
  const f = fixture(t);
  f.spark.lastSortTime = performance.now();
  f.spark.minSortIntervalMs = 100000;
  const task = f.start();
  assert.equal((await f.finish(task)).status, 'fulfilled');
  const handle = f.spark.sortTimeoutId;
  assert.ok(f.clock.has(handle));
  f.dispose();
  assert.equal(f.clock.has(handle), false, 'Scheduled sort timer must be cancelled');
  assert.equal(f.spark.sortTimeoutId, -1);
});

test('dispose cancels an update timer scheduled by real onBeforeRender', settings, t => {
  const f = fixture(t);
  f.spark.preUpdate = false;
  f.spark.onBeforeRender(f.gpu, new THREE.Scene(), new THREE.PerspectiveCamera());
  const handle = f.spark.updateTimeoutId;
  assert.ok(f.clock.has(handle));
  f.dispose();
  assert.equal(f.clock.has(handle), false, 'Scheduled update timer must be cancelled');
  assert.equal(f.spark.updateTimeoutId, -1);
});

test('normal GPU readback errors retain identity and release the sorting flag', settings, async t => {
  const f = fixture(t);
  f.gpu.mode = 'deferred';
  const { task, readback } = await f.reachReadback();
  const expected = new Error('normal readback failure');
  readback.reject(expected);
  const result = await f.finish(task);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error, expected, 'Do not swallow or replace a live renderer error');
  assert.equal(f.spark.sorting, false);
});

test('normal Worker errors retain identity and release the sorting flag', settings, async t => {
  const f = fixture(t);
  const { task, worker } = await f.reachWorker();
  const expected = new Error('normal sorting failure');
  worker.rejectNow(expected);
  const result = await f.finish(task);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error, expected, 'Do not swallow or replace a live renderer error');
  assert.equal(f.spark.sorting, false);
});
