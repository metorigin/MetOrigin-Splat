import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packagePath = fileURLToPath(new URL('../../apps/desktop/node_modules/@sparkjsdev/spark/package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
assert.equal(packageJson.version, '2.1.0', 'Reassess ownership coverage before changing Spark version');
const modulePath = realpathSync(process.env.SPARK_RESOURCE_MODULE
  ? resolve(process.env.SPARK_RESOURCE_MODULE)
  : join(dirname(packagePath), 'dist/spark.module.js'));
export const implementationIdentity = {
  path: modulePath,
  sha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
};

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel', userAgent: 'Spark ownership Node tests', maxTouchPoints: 0 } });
globalThis.self = globalThis;
globalThis.cancelAnimationFrame = () => {};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  assert.ok(url.startsWith('data:'), 'Ownership tests prohibit non-data network requests');
  return nativeFetch(input, options);
};
globalThis.Worker = class { constructor() { throw new Error('Ownership tests must not start workers'); } };

export const spark = await import(pathToFileURL(modulePath).href);
await spark.SplatMesh.staticInitialized;
// Resolve Three from the module under test, including an unpacked candidate package.
const requireFromSpark = createRequire(modulePath);
const threeDirectory = dirname(dirname(requireFromSpark.resolve('three')));
export const THREE = await import(pathToFileURL(join(threeDirectory, 'build/three.module.js')).href);
export const { FullScreenQuad } = await import(pathToFileURL(join(threeDirectory, 'examples/jsm/postprocessing/Pass.js')).href);

export function disposeListeners(object) { return object?._listeners?.dispose?.length ?? 0; }
export function textureValues(value) {
  if (value?.isTexture) return [value];
  if (Array.isArray(value)) return value.flatMap(textureValues);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).flatMap(textureValues);
  return [];
}
export function observeDisposal(object) {
  const observation = { count: 0 };
  object.addEventListener('dispose', () => observation.count++);
  return observation;
}

// This is only the WebGL boundary. Real Three.WebGLRenderer, WebGLGeometries,
// WebGLTextures and material/program cleanup execute unmodified. Shader compile
// succeeds without introspection; initTexture below explicitly exercises the
// actual texture subsystem for textures presented to a compute draw. No pixels,
// real driver allocations, GLSL validation or native memory claims are made.
function webglBoundary(label) {
  const calls = { created: {}, deleted: {}, draws: 0 };
  const live = new Map();
  let serial = 0, nextEnum = 0x10000;
  const enums = new Map();
  const gl = new Proxy({
    drawingBufferWidth: 64, drawingBufferHeight: 64,
    getContextAttributes: () => ({ alpha: false }),
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getProgramParameter(_program, parameter) {
      if (parameter === gl.ACTIVE_UNIFORMS || parameter === gl.ACTIVE_ATTRIBUTES) return 0;
      if (parameter === gl.LINK_STATUS || parameter === gl.VALIDATE_STATUS) return true;
      return 0;
    },
    getParameter(parameter) {
      if (parameter === gl.VERSION) return 'WebGL 2.0 ownership boundary';
      if (parameter === gl.SCISSOR_BOX || parameter === gl.VIEWPORT) return [0, 0, 64, 64];
      if (parameter === gl.MAX_TEXTURE_SIZE || parameter === gl.MAX_CUBE_MAP_TEXTURE_SIZE) return 16384;
      if (parameter === gl.MAX_VERTEX_ATTRIBS) return 16;
      if (parameter === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 32;
      if (parameter === gl.SAMPLES) return 0;
      return 16;
    },
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    getError: () => 0,
    isContextLost: () => false,
    drawArrays() { calls.draws++; },
    drawElements() { calls.draws++; },
    drawArraysInstanced() { calls.draws++; },
    drawElementsInstanced() { calls.draws++; },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
        if (!enums.has(key)) enums.set(key, nextEnum++);
        return enums.get(key);
      }
      if (key.startsWith('create')) {
        const kind = key.slice(6);
        return target[key] = () => {
          const handle = { label, kind, serial: ++serial };
          live.set(handle, kind);
          calls.created[kind] = (calls.created[kind] ?? 0) + 1;
          return handle;
        };
      }
      if (key.startsWith('delete')) {
        const kind = key.slice(6);
        return target[key] = handle => {
          if (handle == null) return;
          assert.equal(handle.label, label, 'Renderer must never delete another renderer\'s GL handle');
          assert.equal(live.get(handle), kind, 'GL handle must be deleted exactly once');
          live.delete(handle);
          calls.deleted[kind] = (calls.deleted[kind] ?? 0) + 1;
        };
      }
      // Non-query state/upload commands deliberately have no driver effects.
      if (/^(bind|buffer|tex|pixelStore|activeTexture|enable|disable|clear|colorMask|depth|stencil|blend|cull|frontFace|polygonOffset|lineWidth|viewport|scissor|attachShader|detachShader|shaderSource|compileShader|linkProgram|validateProgram|useProgram|drawBuffers|readBuffer|framebuffer|renderbuffer|generateMipmap|vertexAttrib|uniform)/.test(key)) {
        return target[key] = () => {};
      }
      throw new Error(`Unexpected WebGL boundary API ${key}`);
    },
  });
  return { gl, calls, live };
}

let nextRenderer = 0;
export function fixture(t) {
  const consumers = [], gpus = [];
  const methods = [spark.SparkRenderer, spark.SplatAccumulator, spark.Readback, spark.PackedSplats]
    .flatMap(type => Object.getOwnPropertyNames(type.prototype)
      .filter(name => typeof Object.getOwnPropertyDescriptor(type.prototype, name).value === 'function')
      .map(name => [type.prototype, name, type.prototype[name]]));
  const f = {
    track(consumer) { consumers.push(consumer); return consumer; },
    gpu() {
      const boundary = webglBoundary(`renderer-${++nextRenderer}`);
      const canvas = { width: 64, height: 64, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} };
      const real = new THREE.WebGLRenderer({ canvas, context: boundary.gl });
      const geometries = new Set(), materials = new Set(), textures = new Set();
      const gpu = {
        real, boundary, draws: [], reads: [], onDraw: null,
        xr: real.xr, info: real.info, properties: real.properties,
        get autoClear() { return real.autoClear; },
        set autoClear(value) { real.autoClear = value; },
        getContext: () => real.getContext(),
        getDrawingBufferSize: vector => real.getDrawingBufferSize(vector),
        getRenderTarget: () => real.getRenderTarget(),
        setRenderTarget: (target, layer) => real.setRenderTarget(target, layer),
        upload(texture) {
          if (!texture || texture.isRenderTargetTexture) return;
          textures.add(texture);
          real.initTexture(texture);
        },
        render(mesh, camera) {
          geometries.add(mesh.geometry);
          materials.add(mesh.material);
          const draw = {
            geometry: mesh.geometry, material: mesh.material,
            target: real.getRenderTarget(),
            uniforms: Object.fromEntries(Object.entries(mesh.material.uniforms ?? {}).map(([key, uniform]) => [key, uniform.value])),
          };
          this.draws.push(draw);
          for (const texture of textureValues(draw.uniforms)) this.upload(texture);
          this.onDraw?.(draw, mesh);
          real.render(mesh, camera);
        },
        readRenderTargetPixelsAsync(target, _x, _y, _width, _height, destination) {
          let resolve;
          const promise = new Promise(yes => { resolve = yes; });
          const call = { target, destination, resolve: () => resolve(destination), promise };
          this.reads.push(call);
          if (!this.holdReads) call.resolve();
          return promise;
        },
        cleanup() {
          for (const read of this.reads) read.resolve();
          // Baseline tests intentionally fail before production cleanup exists.
          // Remove their leftover observed resources only after assertions.
          for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
          real.dispose();
        },
      };
      gpus.push(gpu);
      return gpu;
    },
    spark(gpu) {
      return this.track(new spark.SparkRenderer({ renderer: gpu, autoUpdate: false, enableLod: false, enableDriveLod: false, accumExtSplats: true, covSplats: false }));
    },
    accumulator() { return this.track(new spark.SplatAccumulator({ extSplats: true, covSplats: false })); },
    packed() { return this.track(new spark.PackedSplats()); },
    reader(gpu) { return this.track(new spark.Readback({ renderer: gpu })); },
  };
  t.after(() => {
    for (const consumer of consumers.reverse()) {
      consumer.dispose();
      if (consumer instanceof spark.SparkRenderer) {
        consumer.geometry.dispose();
        consumer.material.dispose();
      }
    }
    for (const gpu of gpus) gpu.cleanup();
    for (const [prototype, name, method] of methods) assert.equal(prototype[name], method, `${name} must remain the real implementation`);
  });
  return f;
}

export function generator(value = 0.5) {
  const scalar = new spark.dyno.DynoFloat({ value, key: 'ownershipScalar' });
  const graph = spark.dyno.dynoBlock({ index: 'int' }, { gsplat: spark.dyno.Gsplat }, ({ index }) => ({
    gsplat: new spark.dyno.CombineGsplat({ index, opacity: scalar }),
  }));
  return { graph, scalar };
}

export function reader(texture) {
  const scalar = new spark.dyno.DynoFloat({ value: 0.5, key: 'ownershipScalar' });
  const sampler = texture && new spark.dyno.DynoUsampler2DArray({ value: texture, key: 'ownershipTexture' });
  const graph = spark.dyno.dynoBlock({ index: 'int' }, { rgba8: 'vec4' }, ({ index }) => ({
    rgba8: new spark.dyno.Dyno({
      inTypes: { index: 'int', scalar: 'float', ...(sampler ? { source: 'usampler2DArray' } : {}) },
      outTypes: { rgba8: 'vec4' },
      inputs: { index, scalar, ...(sampler ? { source: sampler } : {}) },
      statements: ({ inputs, outputs }) => [`${outputs.rgba8} = vec4(${inputs.scalar})${sampler ? ` + vec4(texelFetch(${inputs.source}, ivec3(0), 0))` : ''};`],
    }).outputs.rgba8,
  }));
  return { graph, scalar, sampler };
}

export function drawAccumulator(accumulator, gpu, graph, { base = 0, count = 1 } = {}) {
  accumulator.ensureGenerate({ maxSplats: base + count });
  return accumulator.generate({ generator: graph, base, count, renderer: gpu });
}

export function prepareFrame(accumulator, gpu, graph, previous = new spark.SplatAccumulator(), camera = new THREE.PerspectiveCamera()) {
  const scene = new THREE.Scene();
  scene.add(new spark.SplatGenerator({ numSplats: 1, generator: graph }));
  camera.updateMatrixWorld();
  return accumulator.prepareGenerate({ renderer: gpu, scene, time: 1, camera, sortRadial: false, renderSize: new THREE.Vector2(64, 64), previous });
}
