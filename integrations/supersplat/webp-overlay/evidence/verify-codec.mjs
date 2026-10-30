// Isolated codec acceptance. Writes JSON to stdout only; does not change products.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const SCRIPT = fileURLToPath(import.meta.url);
const OUT = dirname(SCRIPT);
const ROOT = resolve(OUT, '../../..');
const CODEC_SOURCE = resolve(ROOT, 'target/macos-m4/webp-provenance-followup-20261028/current-codec-from-installed-sourcemap.ts');
const OLD_LIB = resolve(ROOT, 'target/supersplat-source/upstream/node_modules/@playcanvas/splat-transform/lib');
const NEW_LIB = resolve(OUT, 'outputs');
const require = createRequire(resolve(ROOT, 'apps/desktop/package.json'));
const source = readFileSync(CODEC_SOURCE, 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileRecord = path => {
    const bytes = readFileSync(path);
    return { path, size_bytes: bytes.length, sha256: hash(bytes) };
};
let compiledCodec;

function makeCodecClass(createModule) {
    if (!compiledCodec) {
        const ts = require('typescript');
        // CommonJS evaluation needs a supplied module URL. All codec methods and
        // its import remain the actual source; require binds that import to a pair.
        const replaced = source.replaceAll('import.meta.url', '__codecModuleUrl');
        assert.notEqual(replaced, source, 'the source contains module URL expressions');
        const result = ts.transpileModule(replaced, {
            fileName: 'current-codec-from-installed-sourcemap.ts',
            reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
        });
        assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
        compiledCodec = result.outputText;
    }
    const exports = {};
    new Function('require', 'exports', '__codecModuleUrl', compiledCodec)(name => {
        assert.equal(name, '../../../lib/webp.mjs');
        return { default: createModule };
    }, exports, pathToFileURL(CODEC_SOURCE).href);
    return exports.WebPCodec;
}

async function loadPair(label, directory) {
    const glue = resolve(directory, 'webp.mjs');
    const wasm = resolve(directory, 'webp.wasm');
    const bindings = { glue: fileRecord(glue), wasm: fileRecord(wasm) };
    const { default: factory } = await import(pathToFileURL(glue).href);
    assert.equal(typeof factory, 'function', `${label}: modularized default factory`);
    let factoryCalls = 0;
    const locations = [];
    const Codec = makeCodecClass(options => {
        factoryCalls++;
        return factory({
            ...options,
            locateFile(path, prefix) {
                const result = options.locateFile(path, prefix);
                locations.push({ path, resolved: result });
                return result;
            },
            print: text => console.error(`[${label}] ${text}`),
            printErr: text => console.error(`[${label}] ${text}`)
        });
    });
    Codec.wasmUrl = pathToFileURL(wasm).href;
    assert.equal(Codec.resolveWasmUrl(), pathToFileURL(wasm).href);
    const [codec, second] = await Promise.all([Codec.create(), Codec.create()]);
    assert.equal(codec.Module, second.Module, `${label}: concurrent create shares one instance`);
    assert.equal((await Codec.create()).Module, codec.Module);
    assert.equal(factoryCalls, 1, `${label}: one factory per independent class`);
    assert(locations.some(item => item.resolved === pathToFileURL(wasm).href), `${label}: exact paired WASM requested`);
    const M = codec.Module;
    for (const name of ['_malloc', '_free', '_webp_free', '_webp_encode_rgba', '_webp_encode_lossless_rgba', '_webp_decode_rgba', 'cwrap']) {
        assert.equal(typeof M[name], 'function', `${label}: ${name}`);
    }
    assert(M.HEAPU8 instanceof Uint8Array);
    assert(M.HEAPU32 instanceof Uint32Array);
    assert.equal(M.HEAPU8.buffer, M.HEAPU32.buffer);
    return { label, bindings, Codec, codec, M, factoryCalls, locations };
}

function fixture(label, width, height, padding = 0, alpha = 'opaque') {
    const stride = width * 4 + padding;
    const backing = new Uint8Array(stride * height + 10).fill(0xa5);
    const input = backing.subarray(5, 5 + stride * height);
    const packed = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const pixel = [(x * 53 + y * 19 + 11) & 255, (x * 7 + y * 97 + 29) & 255,
            (x * 31 + y * 13 + 151) & 255,
            alpha === 'opaque' ? 255 : alpha === 'transparent' ? 0 : [0, 1, 127, 254, 255][(y * width + x) % 5]];
        input.set(pixel, y * stride + x * 4);
        packed.set(pixel, (y * width + x) * 4);
    }
    return { label, width, height, stride, input, packed, backing, before: backing.slice() };
}

function assertPixels(decoded, f, label) {
    assert.equal(decoded.width, f.width, `${label}: width`);
    assert.equal(decoded.height, f.height, `${label}: height`);
    assert(decoded.rgba instanceof Uint8Array, `${label}: owned RGBA array`);
    assert.equal(decoded.rgba.length, f.packed.length, `${label}: byte length`);
    let transparentPixels = 0;
    let changedHiddenRgbBytes = 0;
    const hiddenRgbExamples = [];
    for (let i = 0; i < f.packed.length; i += 4) {
        assert.equal(decoded.rgba[i + 3], f.packed[i + 3], `${label}: alpha at pixel ${i / 4}`);
        if (f.packed[i + 3] === 0) {
            transparentPixels++;
            let changed = false;
            for (let c = 0; c < 3; c++) if (decoded.rgba[i + c] !== f.packed[i + c]) {
                changedHiddenRgbBytes++;
                changed = true;
            }
            if (changed && hiddenRgbExamples.length < 4) hiddenRgbExamples.push({ pixel: i / 4,
                input: [...f.packed.slice(i, i + 4)], decoded: [...decoded.rgba.slice(i, i + 4)] });
        } else {
            for (let c = 0; c < 3; c++) assert.equal(decoded.rgba[i + c], f.packed[i + c], `${label}: RGB byte ${i + c}`);
        }
    }
    assert.deepEqual(f.backing, f.before, `${label}: caller input and guard bytes unchanged`);
    return { transparent_pixels: transparentPixels, changed_hidden_rgb_bytes: changedHiddenRgbBytes,
        hidden_rgb_examples: hiddenRgbExamples, expected_rgba_sha256: hash(f.packed), decoded_rgba_sha256: hash(decoded.rgba) };
}

function assertWebp(bytes, label) {
    assert(bytes instanceof Uint8Array);
    assert(bytes.length >= 20, `${label}: encoded length`);
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString('ascii'), 'RIFF');
    assert.equal(Buffer.from(bytes.subarray(8, 12)).toString('ascii'), 'WEBP');
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8, bytes.length);
}

function measure(M, callback) {
    const original = { malloc: M._malloc, free: M._free, webpFree: M._webp_free };
    const allocated = [], freed = [], webpFreed = [], unownedFrees = [];
    const active = new Set();
    let value, error;
    M._malloc = size => { const p = original.malloc(size); allocated.push({ pointer: p, bytes: size }); if (p) active.add(p); return p; };
    M._free = p => { freed.push(p); if (p && !active.has(p)) unownedFrees.push(p); active.delete(p); return original.free(p); };
    M._webp_free = p => { webpFreed.push(p); return original.webpFree(p); };
    try { value = callback(); } catch (caught) { error = caught; }
    finally { M._malloc = original.malloc; M._free = original.free; M._webp_free = original.webpFree; }
    return { value, error, allocated, freed, webpFreed, unownedFrees, outstanding: [...active] };
}

function allocationSummary(record) {
    return { caller_malloc_calls: record.allocated.length, caller_free_calls: record.freed.length,
        webp_free_calls: record.webpFreed.length, outstanding_caller_allocations: record.outstanding.length };
}

function checkedCall(M, callback, expected, label) {
    const record = measure(M, callback);
    if (record.error) throw record.error;
    assert(record.allocated.every(row => row.pointer > 0), `${label}: all allocations succeeded`);
    assert.equal(record.allocated.length, expected.malloc, `${label}: malloc count`);
    assert.equal(record.freed.length, expected.free, `${label}: free count`);
    assert.equal(record.webpFreed.length, expected.webpFree, `${label}: WebPFree count`);
    assert.deepEqual(record.unownedFrees, [], `${label}: frees belong to live caller allocations`);
    assert.deepEqual(record.outstanding, [], `${label}: caller allocations balanced`);
    assert(record.webpFreed.every(p => p > 0), `${label}: WebP output freed`);
    return record;
}

function rawEncode(M, f, lossy = false, viaCwrap = false) {
    const caller = [];
    let output = 0;
    const alloc = size => { const p = M._malloc(size); assert(p > 0); caller.push(p); return p; };
    try {
        const input = alloc(f.input.length), out = alloc(4), size = alloc(4);
        M.HEAPU8.set(f.input, input);
        M.HEAPU32[out >>> 2] = 0; M.HEAPU32[size >>> 2] = 0;
        const name = lossy ? 'webp_encode_rgba' : 'webp_encode_lossless_rgba';
        const fn = viaCwrap ? M.cwrap(name, 'number', Array(lossy ? 7 : 6).fill('number')) : M[`_${name}`];
        const args = [input, f.width, f.height, f.stride, ...(lossy ? [75.5] : []), out, size];
        assert.equal(fn(...args), 1, `${name}: successful status`);
        const p = M.HEAPU32[out >>> 2], length = M.HEAPU32[size >>> 2];
        assert(p > 0 && length > 0 && p + length <= M.HEAPU8.length, 'valid encoded output range');
        output = p;
        const bytes = M.HEAPU8.slice(p, p + length);
        assertWebp(bytes, name);
        return bytes;
    } finally {
        if (output) M._webp_free(output);
        for (const p of caller) M._free(p);
    }
}

function rawDecode(M, bytes, viaCwrap = false) {
    const caller = [];
    let output = 0;
    const alloc = size => { const p = M._malloc(size); assert(p > 0); caller.push(p); return p; };
    try {
        const input = alloc(bytes.length), out = alloc(4), widthSlot = alloc(4), heightSlot = alloc(4);
        M.HEAPU8.set(bytes, input);
        for (const p of [out, widthSlot, heightSlot]) M.HEAPU32[p >>> 2] = 0;
        const fn = viaCwrap ? M.cwrap('webp_decode_rgba', 'number', Array(5).fill('number')) : M._webp_decode_rgba;
        assert.equal(fn(input, bytes.length, out, widthSlot, heightSlot), 1);
        const p = M.HEAPU32[out >>> 2], width = M.HEAPU32[widthSlot >>> 2], height = M.HEAPU32[heightSlot >>> 2];
        const size = width * height * 4;
        assert(p > 0 && width > 0 && height > 0 && p + size <= M.HEAPU8.length, 'valid decoded output range');
        output = p;
        return { rgba: M.HEAPU8.slice(p, p + size), width, height };
    } finally {
        if (output) M._webp_free(output);
        for (const p of caller) M._free(p);
    }
}

function safeNegatives(M, validWebp) {
    const input = M._malloc(Math.max(24, validWebp.length));
    const slots = M._malloc(12);
    assert(input > 0 && slots > 0);
    const sentinel = [0x13579bdf, 0x2468ace0, 0x10203040];
    const out = slots, size = slots + 4, height = slots + 8;
    const rows = [];
    const run = (label, bytes, fn) => {
        M.HEAPU8.set(bytes, input);
        M.HEAPU32.set(sentinel, slots >>> 2);
        assert.equal(fn(), 0, `${label}: rejected without trap`);
        assert.deepEqual([...M.HEAPU32.subarray(slots >>> 2, (slots >>> 2) + 3)], sentinel, `${label}: output slots unchanged`);
        assert.deepEqual(M.HEAPU8.slice(input, input + bytes.length), bytes, `${label}: input unchanged`);
        rows.push({ label, status: 0, output_slots_unchanged: true });
    };
    try {
        const rgba = new Uint8Array(24).fill(137);
        for (const lossy of [false, true]) {
            const fn = lossy ? M._webp_encode_rgba : M._webp_encode_lossless_rgba;
            const prefix = lossy ? 'lossy' : 'lossless';
            const cases = [
                ['null-input', 0, 3, 2, 12, out, size], ['width-zero', input, 0, 2, 12, out, size],
                ['width-negative', input, -1, 2, 12, out, size], ['height-zero', input, 3, 0, 12, out, size],
                ['height-negative', input, 3, -1, 12, out, size], ['stride-zero', input, 3, 2, 0, out, size],
                ['stride-negative', input, 3, 2, -12, out, size], ['stride-short-safe-buffer', input, 3, 2, 11, out, size],
                ['null-output-slot', input, 3, 2, 12, 0, size], ['null-size-slot', input, 3, 2, 12, out, 0]
            ];
            for (const [label, p, w, h, stride, o, s] of cases) {
                run(`${prefix}:${label}`, rgba, () => fn(p, w, h, stride, ...(lossy ? [75.5] : []), o, s));
            }
            if (lossy) for (const quality of [-1, 101]) run(`lossy:quality-${quality}`, rgba,
                () => fn(input, 3, 2, 12, quality, out, size));
        }
        const decode = M._webp_decode_rgba;
        run('decode:null-input', validWebp, () => decode(0, validWebp.length, out, size, height));
        run('decode:zero-length', validWebp, () => decode(input, 0, out, size, height));
        for (const [label, o, w, h] of [['null-output-slot', 0, size, height], ['null-width-slot', out, 0, height], ['null-height-slot', out, size, 0]]) {
            run(`decode:${label}`, validWebp, () => decode(input, validWebp.length, o, w, h));
        }
        for (const [label, bytes] of [['junk', new Uint8Array(16).fill(0x5a)], ['truncated-header-only', validWebp.slice(0, 12)]]) {
            run(`decode:${label}`, bytes, () => decode(input, bytes.length, out, size, height));
        }
        return rows;
    } finally { M._free(input); M._free(slots); }
}

function sourceFailureAccounting(pair) {
    const { codec, M } = pair;
    const encode = measure(M, () => codec.encodeLosslessRGBA(new Uint8Array(24), 3, 2, 11));
    try {
        assert(encode.error instanceof Error && /WebP lossless encode failed/.test(encode.error.message));
        assert.deepEqual(allocationSummary(encode), { caller_malloc_calls: 3, caller_free_calls: 0, webp_free_calls: 0, outstanding_caller_allocations: 3 });
        assert(encode.allocated.every(row => row.pointer > 0));
    } finally {
        // This is harness cleanup AFTER recording the existing caller defect.
        // It does not modify the codec or claim that its failure path is repaired.
        for (const p of encode.outstanding) M._free(p);
    }
    const decode = measure(M, () => codec.decodeRGBA(new Uint8Array(16).fill(0x5a)));
    assert(decode.error instanceof Error && /WebP decode failed/.test(decode.error.message));
    assert.deepEqual(allocationSummary(decode), { caller_malloc_calls: 4, caller_free_calls: 4, webp_free_calls: 0, outstanding_caller_allocations: 0 });
    return { encode: { ...allocationSummary(encode), classification: 'known existing source-codec failure leak; not repaired',
        harness_cleanup_after_measurement: 3 }, decode: allocationSummary(decode) };
}

function growthAndOwnership(pair, f) {
    const { M, codec } = pair;
    const encoded = codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride);
    const decoded = codec.decodeRGBA(encoded);
    const savedEncoded = encoded.slice(), savedRgba = decoded.rgba.slice();
    assert.notEqual(encoded.buffer, M.HEAPU8.buffer);
    assert.notEqual(decoded.rgba.buffer, M.HEAPU8.buffer);
    const marker = M._malloc(16);
    assert(marker > 0);
    const markerBytes = new Uint8Array(16).fill(0x6d);
    M.HEAPU8.set(markerBytes, marker);
    const before = M.HEAPU8.byteLength, previousBuffer = M.HEAPU8.buffer;
    assert(before <= 128 * 1024 * 1024, 'bounded growth fixture requires initial heap at most 128 MiB');
    const request = before + 65536;
    let reserve = 0;
    try {
        reserve = M._malloc(request);
        assert(reserve > 0);
        assert(M.HEAPU8.byteLength > before, 'malloc caused actual memory growth');
        assert.notEqual(M.HEAPU8.buffer, previousBuffer);
        assert.equal(M.HEAPU32.buffer, M.HEAPU8.buffer);
        assert.deepEqual(M.HEAPU8.slice(marker, marker + 16), markerBytes, 'pre-growth allocation retained');
        const call = checkedCall(M, () => {
            const bytes = codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride);
            return codec.decodeRGBA(bytes);
        }, { malloc: 7, free: 7, webpFree: 2 }, `${pair.label}: post-growth codec`);
        assertPixels(call.value, f, `${pair.label}: post-growth`);
        assert.deepEqual(encoded, savedEncoded, 'returned WebP remains owned');
        assert.deepEqual(decoded.rgba, savedRgba, 'returned RGBA remains owned');
        return { before_bytes: before, requested_allocation_bytes: request, after_bytes: M.HEAPU8.byteLength,
            actual_growth: true, output_arrays_owned: true, counts: allocationSummary(call),
            scope: 'Real malloc growth followed by actual source-codec calls; not a claim that the encoder itself triggered growth.' };
    } finally { if (reserve) M._free(reserve); M._free(marker); }
}

async function workerMain() {
    const pair = await loadPair(workerData.label, workerData.directory);
    parentPort.on('message', message => {
        try {
            const call = checkedCall(pair.M, () => pair.codec.encodeLosslessRGBA(message.rgba, message.width, message.height, message.stride),
                { malloc: 3, free: 3, webpFree: 1 }, 'worker source codec');
            const bytes = call.value;
            assertWebp(bytes, 'worker encoded data');
            parentPort.postMessage({ type: 'result', id: message.id, bytes, counts: allocationSummary(call) }, [bytes.buffer]);
            parentPort.postMessage({ type: 'transfer-ack', id: message.id, detached: bytes.byteLength === 0 });
        } catch (error) { parentPort.postMessage({ type: 'failure', id: message.id, message: String(error), stack: error.stack }); }
    });
    parentPort.postMessage({ type: 'ready', bindings: pair.bindings, factory_calls: pair.factoryCalls });
}

async function workerSmoke(pair, otherPair) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'codec-smoke', label: pair.label,
        directory: dirname(pair.bindings.glue.path) } });
    const queued = [];
    let waiting, failure, terminating = false;
    const fail = error => { failure = error; if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); waiting = undefined; } };
    worker.on('message', value => {
        if (waiting) { clearTimeout(waiting.timer); waiting.resolve(value); waiting = undefined; }
        else queued.push(value);
    });
    worker.on('error', fail);
    worker.on('exit', code => { if (!terminating) fail(new Error(`Worker exited unexpectedly: ${code}`)); });
    const next = () => {
        if (failure) return Promise.reject(failure);
        if (queued.length) return Promise.resolve(queued.shift());
        return new Promise((resolveMessage, reject) => {
            const timer = setTimeout(() => fail(new Error('Worker response timeout')), 30000);
            waiting = { resolve: resolveMessage, reject, timer };
        });
    };
    const cases = [];
    try {
        const ready = await next();
        assert.equal(ready.type, 'ready');
        assert.deepEqual(ready.bindings, pair.bindings);
        assert.equal(ready.factory_calls, 1);
        for (const [id, f] of [fixture('worker-opaque', 3, 2), fixture('worker-alpha', 17, 13, 0, 'mixed')].entries()) {
            const sent = f.input.slice();
            worker.postMessage({ id, rgba: sent, width: f.width, height: f.height, stride: f.stride }, [sent.buffer]);
            assert.equal(sent.byteLength, 0, 'sender input transferred');
            const result = await next();
            assert.equal(result.type, 'result', JSON.stringify(result));
            assert.equal(result.id, id);
            assertWebp(result.bytes, 'worker transferred output');
            const alpha = assertPixels(otherPair.codec.decodeRGBA(result.bytes), f, `${pair.label}: worker cross decode`);
            const ack = await next();
            assert.deepEqual(ack, { type: 'transfer-ack', id, detached: true });
            cases.push({ fixture: f.label, bytes: result.bytes.length, counts: result.counts, alpha });
        }
        return { status: 'passed', bindings: ready.bindings, cases,
            scope: 'Node worker_threads with actual transpiled codec and paired factory. Does not test browser Worker loading or rebuilt splat-transform dist/worker.mjs.' };
    } finally { terminating = true; if (waiting) clearTimeout(waiting.timer); await worker.terminate(); }
}

async function main(report) {
    const oldPair = await loadPair('old', OLD_LIB);
    const newPair = await loadPair('candidate', NEW_LIB);
    assert.notEqual(oldPair.Codec, newPair.Codec);
    assert.notEqual(oldPair.M, newPair.M, 'old/new are independent WASM instances');
    assert.notEqual(oldPair.M.HEAPU8.buffer, newPair.M.HEAPU8.buffer);
    report.pair_identity_comparison = { independent_classes_and_instances: true,
        wasm_bytes_differ: oldPair.bindings.wasm.sha256 !== newPair.bindings.wasm.sha256,
        glue_bytes_differ: oldPair.bindings.glue.sha256 !== newPair.bindings.glue.sha256 };
    report.pairs = {};
    const fixtures = [fixture('opaque-1x1', 1, 1), fixture('opaque-3x2', 3, 2),
        fixture('opaque-odd-padded', 17, 13, 7), fixture('mixed-alpha-odd-padded', 17, 13, 7, 'mixed'),
        fixture('transparent-hidden-rgb', 3, 2, 0, 'transparent')];
    const encoded = new Map();
    for (const pair of [oldPair, newPair]) {
        const result = { bindings: pair.bindings, concurrent_factory_calls: pair.factoryCalls, locate_file: pair.locations, cases: [] };
        report.pairs[pair.label] = result;
        const outputs = [];
        for (const f of fixtures) {
            const encode = checkedCall(pair.M, () => pair.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride),
                { malloc: 3, free: 3, webpFree: 1 }, `${pair.label}:${f.label}: encode`);
            assertWebp(encode.value, f.label);
            assert.notEqual(encode.value.buffer, pair.M.HEAPU8.buffer);
            const decode = checkedCall(pair.M, () => pair.codec.decodeRGBA(encode.value),
                { malloc: 4, free: 4, webpFree: 1 }, `${pair.label}:${f.label}: decode`);
            assert.notEqual(decode.value.rgba.buffer, pair.M.HEAPU8.buffer);
            const alpha = assertPixels(decode.value, f, `${pair.label}:${f.label}`);
            result.cases.push({ fixture: f.label, width: f.width, height: f.height, stride: f.stride,
                input_byte_offset: f.input.byteOffset, webp_bytes: encode.value.length, webp_sha256: hash(encode.value), alpha,
                encode_allocations: allocationSummary(encode), decode_allocations: allocationSummary(decode) });
            outputs.push(encode.value);
        }
        encoded.set(pair, outputs);
        const wrapped = rawEncode(pair.M, fixtures[2], false, true);
        result.cwrap = { status: 'passed', alpha: assertPixels(rawDecode(pair.M, wrapped, true), fixtures[2], `${pair.label}: cwrap`) };
        result.safe_c_abi_negatives = safeNegatives(pair.M, outputs[1]);
        result.source_failure_accounting = sourceFailureAccounting(pair);
        // A successful call after the negative cases also checks recoverability.
        assertPixels(pair.codec.decodeRGBA(rawEncode(pair.M, fixtures[1])), fixtures[1], `${pair.label}: negative-case recovery`);
        result.heap_growth = growthAndOwnership(pair, fixtures[2]);
        const loop = checkedCall(pair.M, () => {
            for (let i = 0; i < 12; i++) {
                const f = fixtures[i % fixtures.length];
                assertPixels(pair.codec.decodeRGBA(pair.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride)), f, `${pair.label}: repeated-${i}`);
            }
        }, { malloc: 84, free: 84, webpFree: 24 }, `${pair.label}: repeated caller ownership`);
        result.repeated_calls = { iterations: 12, ...allocationSummary(loop) };
    }
    report.cross_decode = [];
    report.lossy = [];
    for (const [encoder, decoder] of [[oldPair, newPair], [newPair, oldPair]]) {
        fixtures.forEach((f, i) => report.cross_decode.push({ encoder: encoder.label, decoder: decoder.label, fixture: f.label,
            alpha: assertPixels(decoder.codec.decodeRGBA(encoded.get(encoder)[i]), f, `${encoder.label}->${decoder.label}:${f.label}`) }));
        const f = fixtures[3];
        const bytes = rawEncode(encoder.M, f, true, true);
        const decoded = decoder.codec.decodeRGBA(bytes);
        assert.equal(decoded.width, f.width); assert.equal(decoded.height, f.height);
        assert.equal(decoded.rgba.length, f.packed.length);
        for (let i = 3; i < f.packed.length; i += 4) assert.equal(decoded.rgba[i], f.packed[i], 'lossy default alpha remains exact');
        let rgbAbsoluteError = 0;
        for (let i = 0; i < f.packed.length; i++) if (i % 4 !== 3) rgbAbsoluteError += Math.abs(decoded.rgba[i] - f.packed[i]);
        report.lossy.push({ encoder: encoder.label, decoder: decoder.label, quality: 75.5,
            webp_bytes: bytes.length, webp_sha256: hash(bytes), width: decoded.width, height: decoded.height,
            alpha_exact: true, rgb_absolute_error_observed_not_gated: rgbAbsoluteError,
            scope: 'Actual lossy export and cross-version decode validity; no quality-improvement or RGB-losslessness claim.' });
    }
    report.node_workers = {};
    report.node_workers.old = await workerSmoke(oldPair, newPair);
    report.node_workers.candidate = await workerSmoke(newPair, oldPair);
    // Bind final receipt to unchanged input files, without touching any package.
    for (const pair of [oldPair, newPair]) {
        assert.deepEqual(fileRecord(pair.bindings.glue.path), pair.bindings.glue);
        assert.deepEqual(fileRecord(pair.bindings.wasm.path), pair.bindings.wasm);
    }
    assert.equal(hash(readFileSync(CODEC_SOURCE)), hash(source));
}

if (!isMainThread && workerData?.kind === 'codec-smoke') {
    workerMain().catch(error => { parentPort.postMessage({ type: 'failure', message: String(error), stack: error.stack }); process.exitCode = 1; });
} else {
    const report = {
        status: 'running', started_at: new Date().toISOString(), script: fileRecord(SCRIPT), source_codec: fileRecord(CODEC_SOURCE),
        scope: 'Isolated old/new paired WebP module ABI, actual transpiled source codec, RGBA data, ownership and Node-worker checks. No production assets, license collections or application bundles changed.',
        transparent_pixel_contract: 'Alpha is exact; RGB is exact where alpha>0. Simple libwebp lossless API has exact=0, so hidden RGB at alpha=0 is observed separately, not masked into an all-RGBA-lossless claim.',
        allocation_scope: 'Counts cover JS-visible caller malloc/free and WebP output free calls. They are not instrumentation of internal WASM allocations.',
        known_limitations: [
            'Actual source codec leaks three caller allocations on encode failure. This harness records that behavior and explicitly frees only its measured leftovers afterward; source is not repaired.',
            'C ABI has no RGBA input-buffer length; no arbitrary bad pointer, short allocation, overflow dimension or NaN coercion test is claimed.',
            'Compressed bytes may differ across library versions. Acceptance compares decoded data, not identical compression output.',
            'Node worker_threads coverage is not browser-worker, rebuilt dist/worker.mjs, SOG pipeline, GPU, native UI or full-application acceptance.'
        ]
    };
    try { await main(report); report.status = 'passed-with-known-limitations'; }
    catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
    report.completed_at = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
}
