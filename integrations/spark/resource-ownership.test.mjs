import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THREE, FullScreenQuad, spark, fixture, generator, reader, drawAccumulator,
  prepareFrame, disposeListeners, observeDisposal, implementationIdentity, textureValues as collectTextures,
} from './resource-ownership-harness.mjs';

const options = { concurrency: false, timeout: 5000 };
const textureValues = draw => collectTextures(draw.uniforms);
const scalarValue = draw => Object.entries(draw.uniforms).find(([key]) => key.includes('ownershipScalar'))?.[1];

test('resource ownership tests identify the actual imported Spark module', options, t => {
  t.diagnostic(JSON.stringify({ implementationIdentity, scope: 'Actual Spark and Three.WebGLRenderer; stub WebGL API and readback boundary; explicit initTexture for sampler bindings; no GPU pixels or native memory acceptance' }));
  assert.equal(implementationIdentity.sha256.length, 64);
});

for (const kind of ['accumulator', 'reader', 'packed']) {
  test(`${kind} internal draw uses private geometry and releases real Three geometry/material listeners`, options, t => {
    const f = fixture(t), gpu = f.gpu();
    const consumer = kind === 'reader' ? f.reader(gpu) : f[kind]();
    if (kind === 'accumulator') drawAccumulator(consumer, gpu, generator().graph);
    if (kind === 'reader') consumer.render({ reader: reader().graph, count: 1 });
    if (kind === 'packed') {
      consumer.ensureGenerate(1);
      consumer.generate({ generator: generator().graph, base: 0, count: 1, renderer: gpu });
    }
    const { geometry, material } = gpu.draws.at(-1);
    const sharedPassGeometry = new FullScreenQuad()._mesh.geometry;
    assert.equal(disposeListeners(geometry), 1, 'Actual WebGLGeometries installed one disposal listener');
    assert.equal(disposeListeners(material), 1, 'Actual WebGLRenderer installed one material disposal listener');
    assert.notEqual(geometry, sharedPassGeometry, 'Internal compute must clone Three Pass module geometry');
    consumer.dispose();
    assert.equal(disposeListeners(geometry), 0, 'Owner disposal removes the real geometry listener');
    assert.equal(disposeListeners(material), 0, 'Owner disposal removes the real material listener');
    assert.equal(gpu.real.info.memory.geometries, 0);
    assert.equal(gpu.real.info.memory.textures, 0, 'Render target is released before renderer disposal');
    assert.equal(gpu.real.info.programs.length, 0, 'Owned material releases its real Three program');
  });
}

test('six sequential renderer consumers leave no real resource callbacks behind', options, t => {
  const f = fixture(t), graph = generator().graph, receipts = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    const gpu = f.gpu(), accumulator = f.accumulator();
    drawAccumulator(accumulator, gpu, graph);
    const draw = gpu.draws.at(-1);
    accumulator.dispose();
    receipts.push({ geometry: disposeListeners(draw.geometry), material: disposeListeners(draw.material), programs: gpu.real.info.programs.length });
  }
  assert.deepEqual(receipts, Array.from({ length: 6 }, () => ({ geometry: 0, material: 0, programs: 0 })));
});

test('two renderers isolate compute geometry, materials, placeholders and disposal', options, t => {
  const f = fixture(t), a = f.gpu(), b = f.gpu();
  const ra = f.reader(a), rb = f.reader(b), source = reader(spark.SplatAccumulator.emptyTexture);
  ra.render({ reader: source.graph, count: 1 });
  rb.render({ reader: source.graph, count: 1 });
  const da = a.draws.at(-1), db = b.draws.at(-1);
  assert.notEqual(da.geometry, db.geometry, 'Independent renderers must own independent geometry');
  assert.notEqual(da.material, db.material, 'Independent renderers must own independent materials');
  const ta = textureValues(da)[0], tb = textureValues(db)[0];
  assert.notEqual(ta, tb, 'Independent renderers must own independent fallback textures');
  assert.equal(disposeListeners(ta), 1);
  assert.equal(disposeListeners(tb), 1);
  const bDeletes = structuredClone(b.boundary.calls.deleted);
  ra.dispose();
  assert.equal(disposeListeners(da.geometry), 0);
  assert.equal(disposeListeners(da.material), 0);
  assert.equal(disposeListeners(ta), 0);
  assert.equal(disposeListeners(db.geometry), 1);
  assert.equal(disposeListeners(db.material), 1);
  assert.equal(disposeListeners(tb), 1);
  assert.deepEqual(b.boundary.calls.deleted, bDeletes, 'Disposing renderer A consumer cannot delete B handles');
  rb.render({ reader: source.graph, count: 1 });
  assert.equal(b.draws.at(-1).material, db.material);
});

test('multiple Spark consumers share an owner until the last consumer releases it', options, t => {
  const f = fixture(t), gpu = f.gpu(), a = f.spark(gpu), b = f.spark(gpu), graph = generator().graph;
  drawAccumulator(a.current, gpu, graph);
  const da = gpu.draws.at(-1);
  drawAccumulator(b.current, gpu, graph);
  const db = gpu.draws.at(-1);
  assert.ok(a._resourceOwner, 'Spark acquires a renderer resource lease');
  assert.equal(a._resourceOwner, b._resourceOwner);
  assert.equal(da.geometry, db.geometry, 'Consumers on one renderer share private quad geometry');
  assert.notEqual(da.material, db.material, 'Consumer material state remains independent');
  const owner = b._resourceOwner;
  a.dispose();
  assert.equal(b._resourceOwner, owner);
  assert.equal(disposeListeners(db.geometry), 1, 'First consumer does not dispose the live shared geometry');
  assert.equal(disposeListeners(da.material), 0, 'First consumer releases its own material');
  assert.equal(disposeListeners(db.material), 1);
  drawAccumulator(b.current, gpu, graph);
  b.dispose();
  assert.equal(disposeListeners(db.geometry), 0);
  assert.equal(disposeListeners(db.material), 0);
  assert.equal(owner.users.size, 0);
});

test('standalone helper keeps a renderer owner alive after Spark is disposed', options, t => {
  const f = fixture(t), gpu = f.gpu(), display = f.spark(gpu), helper = f.reader(gpu);
  helper.render({ reader: reader().graph, count: 1 });
  const draw = gpu.draws.at(-1);
  assert.ok(display._resourceOwner);
  assert.equal(display._resourceOwner, helper._resourceOwner);
  display.dispose();
  assert.equal(disposeListeners(draw.geometry), 1);
  assert.equal(disposeListeners(draw.material), 1);
  helper.dispose();
  assert.equal(disposeListeners(draw.geometry), 0);
  assert.equal(disposeListeners(draw.material), 0);
});

test('placeholder clones release real texture listeners while preserving template Source data', options, t => {
  const f = fixture(t), gpu = f.gpu(), helper = f.reader(gpu);
  const template = spark.SplatAccumulator.emptyTexture;
  const originalSource = template.source, originalData = template.source.data;
  const originalListeners = disposeListeners(template);
  const graph = reader(template).graph;
  helper.render({ reader: graph, count: 1 });
  const local = textureValues(gpu.draws.at(-1))[0];
  assert.notEqual(local, template, 'Static placeholder must not be uploaded directly');
  assert.equal(disposeListeners(local), 1, 'Real WebGLTextures listener is installed on the local texture');
  assert.equal(disposeListeners(template), originalListeners, 'Template acquires no renderer listener');
  helper.dispose();
  assert.equal(disposeListeners(local), 0, 'Owner removes real WebGLTextures listener');
  assert.equal(template.source, originalSource);
  assert.equal(template.source.data, originalData, 'Disposing a clone must not null shared CPU data');
});

test('Spark initial and onBeforeRender fallback uniforms use renderer local textures', options, t => {
  const f = fixture(t), a = f.gpu(), b = f.gpu(), sa = f.spark(a), sb = f.spark(b);
  const originals = [spark.SparkRenderer.emptyOrdering, spark.SplatAccumulator.emptyTexture];
  const originalSources = originals.map(texture => texture.source.data);
  const camera = new THREE.PerspectiveCamera(), scene = new THREE.Scene();
  for (const display of [sa, sb]) display.onBeforeRender(display.renderer, scene, camera);
  for (const key of ['ordering', 'extSplats', 'extSplats2']) {
    const ta = sa.uniforms[key].value, tb = sb.uniforms[key].value;
    assert.notEqual(ta, tb, `${key} must be renderer local`);
    assert.ok(!originals.includes(ta));
    a.upload(ta); b.upload(tb);
    assert.equal(disposeListeners(ta), 1);
    assert.equal(disposeListeners(tb), 1);
  }
  const textures = [...new Set(['ordering', 'extSplats', 'extSplats2'].map(key => sa.uniforms[key].value))];
  sa.dispose();
  for (const texture of textures) assert.equal(disposeListeners(texture), 0);
  for (const [index, texture] of originals.entries()) assert.equal(texture.source.data, originalSources[index]);
});

test('legacy material and real caller source remain borrowed by internal compute', options, t => {
  const f = fixture(t), gpu = f.gpu(), helper = f.reader(gpu);
  const texture = new THREE.DataArrayTexture(new Uint32Array([1, 2, 3, 4]), 1, 1, 1);
  texture.format = THREE.RGBAIntegerFormat; texture.type = THREE.UnsignedIntType; texture.needsUpdate = true;
  const data = texture.source.data, graph = reader(texture).graph;
  const { program, material: legacy } = helper.prepareProgramMaterial(graph);
  const legacyDisposal = observeDisposal(legacy), sourceDisposal = observeDisposal(texture);
  helper.render({ reader: graph, count: 1 });
  const draw = gpu.draws.at(-1);
  assert.notEqual(draw.material, legacy, 'Internal compute cannot adopt legacy program.prepareMaterial material');
  assert.equal(program.prepareMaterial(), legacy);
  assert.ok(textureValues(draw).includes(texture), 'Real caller texture identity is preserved');
  helper.dispose();
  assert.equal(legacyDisposal.count, 0);
  assert.equal(sourceDisposal.count, 0);
  assert.equal(texture.source.data, data);
  assert.equal(disposeListeners(draw.material), 0);
  // Borrowed resources still have their owners; explicitly clean them in test teardown.
  t.after(() => { legacy.dispose(); texture.dispose(); });
});

test('resizing targets retains the resource lease and repeated dispose is idempotent', options, t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator(), graph = generator().graph;
  drawAccumulator(accumulator, gpu, graph);
  const owner = accumulator._resourceOwner, token = accumulator._resourceToken;
  assert.ok(owner);
  const first = gpu.draws.at(-1), firstTarget = accumulator.target;
  const targetDisposed = observeDisposal(firstTarget);
  accumulator.ensureGenerate({ maxSplats: accumulator.maxSplats + 1 });
  assert.equal(targetDisposed.count, 1);
  assert.equal(accumulator._resourceOwner, owner);
  assert.equal(accumulator._resourceToken, token);
  assert.ok(owner.users.has(token));
  drawAccumulator(accumulator, gpu, graph);
  assert.equal(gpu.draws.at(-1).geometry, first.geometry);
  assert.equal(gpu.draws.at(-1).material, first.material);
  accumulator.dispose();
  const deletes = structuredClone(gpu.boundary.calls.deleted);
  accumulator.dispose();
  assert.deepEqual(gpu.boundary.calls.deleted, deletes);
  assert.equal(disposeListeners(first.geometry), 0);
});

test('helper renderer switch requires explicit disposal, then supports rebind', options, t => {
  const f = fixture(t), a = f.gpu(), b = f.gpu(), helper = f.reader(a), graph = reader().graph;
  helper.render({ reader: graph, count: 1 });
  const first = a.draws.at(-1);
  assert.throws(() => helper.render({ reader: graph, count: 1, renderer: b }), /renderer|dispose/i);
  assert.equal(b.draws.length, 0);
  helper.dispose();
  helper.render({ reader: graph, count: 1, renderer: b });
  assert.notEqual(b.draws.at(-1).geometry, first.geometry);
  assert.equal(disposeListeners(first.geometry), 0);
  assert.equal(helper._resourceOwner.renderer, b);
});

test('successive readback programs release historical material/program references', options, t => {
  const f = fixture(t), gpu = f.gpu(), helper = f.reader(gpu), history = [];
  for (let index = 0; index < 12; index++) {
    helper.render({ reader: reader().graph, count: 1 });
    history.push(gpu.draws.at(-1).material);
    assert.ok(helper._resourceOwner, 'Helper owns renderer resources');
    assert.equal(helper._resourceOwner.programMaterials.size, 1, 'Only the current program remains retained');
    assert.equal(gpu.real.info.programs.length, 1, 'Real Three program references remain bounded');
  }
  for (const material of history.slice(0, -1)) assert.equal(disposeListeners(material), 0);
  helper.dispose();
  assert.equal(disposeListeners(history.at(-1)), 0);
});

test('new accumulator frames release replaced generators and retain current frame programs', options, t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator(), previous = f.accumulator();
  for (let index = 0; index < 8; index++) {
    prepareFrame(accumulator, gpu, generator().graph, previous).generate();
    assert.ok(accumulator._resourceOwner);
    assert.equal(accumulator._resourceOwner.programMaterials.size, 1, 'Historical scene generators must not accumulate');
  }
  const emptyScene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  accumulator.prepareGenerate({ renderer: gpu, scene: emptyScene, time: 2, camera, sortRadial: false, renderSize: new THREE.Vector2(64, 64), previous }).generate();
  assert.equal(accumulator._resourceOwner.programMaterials.size, 0, 'Empty frame releases previous generator programs');
});

test('repeated cached generator calls synchronize updated scalar and control uniforms', options, t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator(), source = generator(0.25);
  drawAccumulator(accumulator, gpu, source.graph, { base: 0, count: 2 });
  const first = gpu.draws.at(-1);
  source.scalar.value = 0.75;
  drawAccumulator(accumulator, gpu, source.graph, { base: 3, count: 4 });
  const second = gpu.draws.at(-1);
  assert.equal(first.material, second.material, 'Cached material is reused');
  assert.equal(scalarValue(first), 0.25);
  assert.equal(scalarValue(second), 0.75);
  assert.deepEqual([second.uniforms.targetLayer, second.uniforms.targetBase, second.uniforms.targetCount], [0, 3, 4]);
});

test('cached readback material synchronizes replacement texture values without disposing borrowed sources', options, t => {
  const f = fixture(t), gpu = f.gpu(), helper = f.reader(gpu);
  const textures = [1, 2].map(value => {
    const texture = new THREE.DataArrayTexture(new Uint32Array([value, 0, 0, 0]), 1, 1, 1);
    texture.format = THREE.RGBAIntegerFormat; texture.type = THREE.UnsignedIntType; texture.needsUpdate = true;
    return texture;
  });
  const source = reader(textures[0]), counts = textures.map(observeDisposal);
  helper.render({ reader: source.graph, count: 1 });
  source.sampler.value = textures[1];
  source.scalar.value = 0.9;
  helper.render({ reader: source.graph, count: 2 });
  assert.ok(textureValues(gpu.draws.at(-1)).includes(textures[1]));
  assert.ok(!textureValues(gpu.draws.at(-1)).includes(textures[0]));
  assert.equal(scalarValue(gpu.draws.at(-1)), 0.9);
  helper.dispose();
  assert.deepEqual(counts.map(value => value.count), [0, 0]);
});

test('nested consumers on one renderer preserve outer quad material and target control uniforms', options, t => {
  const f = fixture(t), gpu = f.gpu(), outer = f.accumulator(), inner = f.accumulator(), graph = generator().graph;
  inner.ensureGenerate({ maxSplats: 8 });
  let entered = false;
  gpu.onDraw = (draw, mesh) => {
    if (entered) return;
    entered = true;
    const outerMaterial = mesh.material;
    inner.generate({ generator: graph, base: 5, count: 2, renderer: gpu });
    assert.equal(mesh.material, outerMaterial, 'Nested draw restores the shared quad material');
    assert.deepEqual([outerMaterial.uniforms.targetLayer.value, outerMaterial.uniforms.targetBase.value, outerMaterial.uniforms.targetCount.value], [0, 1, 3]);
    assert.equal(gpu.getRenderTarget(), draw.target, 'Nested draw restores the outer render target');
  };
  drawAccumulator(outer, gpu, graph, { base: 1, count: 3 });
  assert.equal(gpu.draws.length, 2);
  assert.notEqual(gpu.draws[0].material, gpu.draws[1].material);
});

test('same-consumer recursive draw isolates temporary material and restores outer uniforms', options, t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator(), graph = generator().graph;
  let entered = false;
  gpu.onDraw = (_draw, mesh) => {
    if (entered) return;
    entered = true;
    const outerMaterial = mesh.material;
    accumulator.generate({ generator: graph, base: 5, count: 2, renderer: gpu });
    assert.equal(mesh.material, outerMaterial);
    assert.deepEqual([outerMaterial.uniforms.targetLayer.value, outerMaterial.uniforms.targetBase.value, outerMaterial.uniforms.targetCount.value], [0, 1, 3]);
  };
  accumulator.ensureGenerate({ maxSplats: 8 });
  accumulator.generate({ generator: graph, base: 1, count: 3, renderer: gpu });
  assert.notEqual(gpu.draws[0].material, gpu.draws[1].material);
  assert.equal(disposeListeners(gpu.draws[1].material), 0, 'Temporary nested material is disposed at scope exit');
});

test('saved generate and readback closures cannot reacquire after disposal or later rebind', options, async t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator(), graph = generator().graph;
  const oldFrame = prepareFrame(accumulator, gpu, graph);
  oldFrame.generate();
  accumulator.dispose();
  const before = gpu.draws.length;
  assert.throws(() => oldFrame.generate(), /invalidated by disposal/);
  await assert.rejects(oldFrame.readback(), /invalidated by disposal/);
  assert.equal(gpu.draws.length, before, 'Disposed saved closures do not draw');
  assert.ok(accumulator.target === null, 'Disposed saved closures do not allocate a target');
  assert.ok(accumulator.readback === null, 'Disposed saved closures do not create a helper');
  assert.ok(!accumulator._resourceOwner, 'Disposed saved closures do not acquire a new owner');
  const nextFrame = prepareFrame(accumulator, gpu, graph);
  nextFrame.generate();
  const nextOwner = accumulator._resourceOwner, reboundDraws = gpu.draws.length;
  assert.throws(() => oldFrame.generate(), /invalidated by disposal/);
  await assert.rejects(oldFrame.readback(), /invalidated by disposal/);
  assert.equal(gpu.draws.length, reboundDraws, 'A new explicit generation does not revive old closures');
  assert.equal(accumulator._resourceOwner, nextOwner);
});

test('pending readback continuation settles without recreating resources after disposal', options, async t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator();
  const frame = prepareFrame(accumulator, gpu, generator().graph);
  frame.generate();
  gpu.holdReads = true;
  const pending = frame.readback();
  assert.equal(gpu.reads.length, 1);
  const helper = accumulator.readback, draws = gpu.draws.length;
  accumulator.dispose();
  for (const call of gpu.reads) call.resolve();
  await pending;
  assert.equal(gpu.draws.length, draws);
  assert.ok(accumulator.readback === null, 'Accumulator releases the readback helper');
  assert.ok(!accumulator._resourceOwner);
  assert.ok(!helper._resourceOwner);
  assert.equal(gpu.real.info.programs.length, 0);
});

test('nested camera generation cannot mutate the outer draw vector uniform values', options, t => {
  const f = fixture(t), gpu = f.gpu(), outer = f.accumulator(), inner = f.accumulator();
  const graph = generator().graph;
  const cameraA = new THREE.PerspectiveCamera(), cameraB = new THREE.PerspectiveCamera();
  cameraA.position.set(1, 2, 3); cameraB.position.set(9, 8, 7);
  const frame = prepareFrame(outer, gpu, graph, f.accumulator(), cameraA);
  let entered = false;
  gpu.onDraw = (draw, mesh) => {
    if (entered) return;
    entered = true;
    const key = Object.keys(draw.uniforms).find(key => draw.uniforms[key]?.isVector3 && draw.uniforms[key].equals(cameraA.position));
    assert.ok(key, 'Actual compiled depth program must contain the outer camera origin');
    const outerMaterial = mesh.material;
    prepareFrame(inner, gpu, graph, f.accumulator(), cameraB).generate();
    assert.ok(mesh.material === outerMaterial, 'Outer material is restored before the actual Three draw');
    assert.deepEqual(outerMaterial.uniforms[key].value.toArray(), [1, 2, 3], 'Inner camera update cannot change pending outer draw values');
  };
  frame.generate();
  assert.equal(gpu.draws.length, 2);
});

test('nested generation snapshots matrix and typed-array uniform values for the outer draw', options, t => {
  const f = fixture(t), gpu = f.gpu(), outer = f.accumulator(), inner = f.accumulator();
  const matrix = new spark.dyno.DynoMat4({ key: 'ownershipMatrix', value: new THREE.Matrix4().makeTranslation(1, 2, 3) });
  const values = new spark.dyno.DynoUniform({ key: 'ownershipArray', type: 'float', count: 2, value: new Float32Array([0.25, 0.75]) });
  const graph = spark.dyno.dynoBlock({ index: 'int' }, { gsplat: spark.dyno.Gsplat }, ({ index }) => ({
    gsplat: new spark.dyno.CombineGsplat({ index, center: new spark.dyno.Dyno({
      inTypes: { matrix: 'mat4', values: 'float' }, outTypes: { center: 'vec3' }, inputs: { matrix, values },
      statements: ({ inputs, outputs }) => [`${outputs.center} = (${inputs.matrix} * vec4(${inputs.values}[0], 0.0, 0.0, 1.0)).xyz;`],
    }).outputs.center }),
  }));
  inner.ensureGenerate({ maxSplats: 1 });
  let entered = false;
  gpu.onDraw = (draw, mesh) => {
    if (entered) return;
    entered = true;
    const matrixKey = Object.keys(draw.uniforms).find(key => key.includes('ownershipMatrix'));
    const arrayKey = Object.keys(draw.uniforms).find(key => key.includes('ownershipArray'));
    assert.ok(matrixKey && arrayKey);
    const outerMaterial = mesh.material, originalMatrix = matrix.value.toArray();
    matrix.value.makeTranslation(9, 8, 7); values.value[0] = 0.9;
    inner.generate({ generator: graph, base: 0, count: 1, renderer: gpu });
    assert.deepEqual(outerMaterial.uniforms[matrixKey].value.toArray(), originalMatrix);
    assert.deepEqual(Array.from(outerMaterial.uniforms[arrayKey].value), [0.25, 0.75]);
  };
  drawAccumulator(outer, gpu, graph);
  assert.equal(gpu.draws.length, 2);
});

test('readback disposal inside a draw rejects stale work and restores renderer state', options, async t => {
  const f = fixture(t), gpu = f.gpu(), helper = f.reader(gpu);
  gpu.xr.enabled = true; gpu.autoClear = true;
  gpu.onDraw = () => { gpu.onDraw = null; helper.dispose(); };
  await assert.rejects(helper.renderReadback({ reader: reader().graph, count: 1, readback: helper.ensureBuffer(1, new Uint32Array(0)) }), /invalidated by disposal/);
  assert.ok(gpu.getRenderTarget() === null, 'Original render target is restored even though helper.renderer was released');
  assert.equal(gpu.xr.enabled, true);
  assert.equal(gpu.autoClear, true);
  assert.equal(gpu.reads.length, 0, 'Invalidated draw must not start asynchronous readback');
  assert.ok(helper.target == null, 'Disposed helper has no render target');
  assert.ok(!helper._resourceOwner);
  assert.equal(disposeListeners(gpu.draws[0].geometry), 0);
  assert.equal(disposeListeners(gpu.draws[0].material), 0);
});

test('standalone generation after a mapped frame does not retain historical foreign programs', options, t => {
  const f = fixture(t), gpu = f.gpu(), accumulator = f.accumulator();
  prepareFrame(accumulator, gpu, generator().graph).generate();
  assert.equal(accumulator.mapping.length, 1);
  const materials = [];
  for (let index = 0; index < 10; index++) {
    drawAccumulator(accumulator, gpu, generator().graph);
    materials.push(gpu.draws.at(-1).material);
    assert.ok(accumulator._resourceOwner, 'Real compute owns renderer resources');
    assert.ok(accumulator._resourceOwner.programMaterials.size <= 2, 'Only the mapped program and current standalone program can remain');
    assert.ok(gpu.real.info.programs.length <= 2, 'Actual Three program cache must stay bounded');
  }
  for (const material of materials.slice(0, -1)) assert.equal(disposeListeners(material), 0);
});

test('Spark disposes its created display resources and preserves caller replacements', options, t => {
  const f = fixture(t), gpu = f.gpu(), display = f.spark(gpu);
  const createdGeometry = display.geometry, createdMaterial = display.material;
  const geometryDisposal = observeDisposal(createdGeometry), materialDisposal = observeDisposal(createdMaterial);
  const borrowedGeometry = new THREE.BufferGeometry(), borrowedMaterial = new THREE.RawShaderMaterial();
  const borrowedGeometryDisposal = observeDisposal(borrowedGeometry), borrowedMaterialDisposal = observeDisposal(borrowedMaterial);
  display.geometry = borrowedGeometry; display.material = borrowedMaterial;
  display.dispose();
  assert.equal(geometryDisposal.count, 1);
  assert.equal(materialDisposal.count, 1);
  assert.equal(borrowedGeometryDisposal.count, 0);
  assert.equal(borrowedMaterialDisposal.count, 0);
});

test('real non-LOD SplatMesh with loaded ExtSplats and SH uses local fallback and borrowed model textures', options, async t => {
  const f = fixture(t), a = f.gpu(), b = f.gpu(), sa = f.spark(a), sb = f.spark(b);
  const source = new spark.ExtSplats();
  source.pushSplat(new THREE.Vector3(1, 2, -3), new THREE.Vector3(0.1, 0.2, 0.3), new THREE.Quaternion(), 0.8, new THREE.Color(0.7, 0.5, 0.2));
  source.extra = Object.fromEntries(['sh1', 'sh2', 'sh3a', 'sh3b'].map(key => [key, new Uint32Array(source.maxSplats * 4)]));
  source.updateTextures();
  const mesh = f.track(new spark.SplatMesh({ extSplats: source, enableLod: false, editable: false, raycastable: false }));
  await mesh.initialized;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  scene.add(mesh); scene.updateMatrixWorld(); camera.updateMatrixWorld();
  const template = mesh.context.lodIndices.value, templateData = template.source.data;
  const templateListeners = disposeListeners(template);
  const generate = (display, gpu) => display.current.prepareGenerate({
    renderer: gpu, scene, time: 1, camera, sortRadial: false, renderSize: new THREE.Vector2(64, 64), previous: f.accumulator(),
  }).generate();
  generate(sa, a); generate(sb, b);
  assert.equal(mesh.context.enableLod.value, false);
  assert.equal(mesh.context.lodIndices.value, template, 'Shared mesh context retains its CPU template');
  assert.equal(source.getNumSh(), 3);
  const da = a.draws.at(-1), db = b.draws.at(-1);
  assert.ok(da && db, 'Both renderers execute the actual constructed SplatMesh generator');
  const lodKey = Object.keys(da.uniforms).find(key => key.includes('lodIndices'));
  assert.ok(lodKey, 'Runtime-disabled LOD sampler remains in the actual generated shader');
  assert.ok(da.material.fragmentShader.includes(lodKey));
  const localA = da.uniforms[lodKey], localB = db.uniforms[lodKey];
  assert.ok(localA !== template && localB !== template && localA !== localB, 'Non-LOD fallback is isolated per renderer');
  assert.equal(disposeListeners(template), templateListeners);
  assert.equal(disposeListeners(localA), 1);
  assert.equal(disposeListeners(localB), 1);
  const shTextures = ['sh1Texture', 'sh2Texture', 'sh3TextureA', 'sh3TextureB'].map(key => source.extra[key].value);
  const modelTextures = [...source.textures, ...shTextures];
  const data = modelTextures.map(texture => texture.source.data), disposals = modelTextures.map(observeDisposal);
  for (const texture of modelTextures) {
    assert.ok(textureValues(da).includes(texture) && textureValues(db).includes(texture), 'Every model and SH texture is passed through by identity');
    assert.equal(disposeListeners(texture), 3, 'Two real WebGLTextures listeners plus the test observer are installed');
  }
  sa.dispose();
  assert.equal(disposeListeners(localA), 0);
  assert.equal(disposeListeners(localB), 1);
  assert.deepEqual(disposals.map(value => value.count), [0, 0, 0, 0, 0, 0], 'Compute owner never disposes model or SH source textures');
  for (const [index, texture] of modelTextures.entries()) assert.equal(texture.source.data, data[index]);
  generate(sb, b);
  sb.dispose();
  assert.equal(disposeListeners(localB), 0);
  assert.equal(template.source.data, templateData);
  assert.deepEqual(disposals.map(value => value.count), [0, 0, 0, 0, 0, 0]);
});
