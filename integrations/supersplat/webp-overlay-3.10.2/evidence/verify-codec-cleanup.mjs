// Tests actual v2 TS cleanup against real WASM allocations, with safe JS faults.
// Only JSON is written to stdout. This does not modify the baseline harness.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const OUT = dirname(SCRIPT);
const ROOT = resolve(OUT, '../..');
const V1_SOURCE = resolve(OUT, 'originals/source/src/lib/utils/webp-codec.ts');
const V2_SOURCE = resolve(OUT, 'sources/splat-transform/src/lib/utils/webp-codec.ts');
const GLUE = resolve(OUT, 'outputs/webp.mjs');
const WASM = resolve(OUT, 'outputs/webp.wasm');
const require = createRequire(resolve(ROOT, 'apps/desktop/package.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = path => { const bytes = readFileSync(path); return { path, size_bytes: bytes.length, sha256: sha(bytes) }; };
const errorRecord = error => error ? { name: error.name, message: error.message, stack: error.stack } : null;

async function loadCodec(sourcePath, label, factory, ts, wasm = WASM) {
    const source = readFileSync(sourcePath, 'utf8');
    const rewritten = source.replaceAll('import.meta.url', '__codecModuleUrl');
    assert.notEqual(rewritten, source, 'module URL binding was substituted');
    const compiled = ts.transpileModule(rewritten, { fileName: 'webp-codec.ts', reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const exports = {};
    let factoryCalls = 0;
    const locations = [];
    new Function('require', 'exports', '__codecModuleUrl', compiled.outputText)(name => {
        assert.equal(name, '../../../lib/webp.mjs');
        return { default: options => {
            factoryCalls++;
            return factory({ ...options,
                locateFile(path, prefix) { const resolved = options.locateFile(path, prefix); locations.push(resolved); return resolved; },
                print: text => console.error(`[cleanup:${label}] ${text}`),
                printErr: text => console.error(`[cleanup:${label}] ${text}`)
            });
        } };
    }, exports, pathToFileURL(sourcePath).href);
    const Codec = exports.WebPCodec;
    Codec.wasmUrl = pathToFileURL(wasm).href;
    const codec = await Codec.create();
    assert.equal(factoryCalls, 1);
    assert(locations.includes(pathToFileURL(wasm).href), 'actual paired WASM requested');
    const M = codec.Module;
    for (const name of ['_malloc', '_free', '_webp_free', '_webp_encode_lossless_rgba', '_webp_decode_rgba']) assert.equal(typeof M[name], 'function');
    assert(M.HEAPU8 instanceof Uint8Array && M.HEAPU32 instanceof Uint32Array);
    return { Codec, codec, M, source: record(sourcePath), factoryCalls, locations };
}

function fixture(label, width, height, padding = 0, alpha = 'opaque', offset = 0) {
    const stride = width * 4 + padding;
    const storage = new Uint8Array(offset + stride * height + 7).fill(0xa5);
    const input = storage.subarray(offset, offset + stride * height);
    const packed = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const n = y * width + x;
        const pixel = [(17 + x * 53 + y * 19) & 255, (41 + x * 11 + y * 71) & 255, (149 + x * 31 + y * 7) & 255,
            alpha === 'opaque' ? 255 : alpha === 'nonzero' ? [1, 127, 254, 255][n % 4] : [0, 1, 127, 255][n % 4]];
        input.set(pixel, y * stride + x * 4); packed.set(pixel, n * 4);
    }
    return { label, width, height, stride, input, packed, storage, before: storage.slice() };
}

function assertDecoded(decoded, f, exactInput = true) {
    assert.equal(decoded.width, f.width); assert.equal(decoded.height, f.height);
    assert(decoded.rgba instanceof Uint8Array); assert.equal(decoded.rgba.length, f.packed.length);
    if (exactInput) assert.deepEqual(decoded.rgba, f.packed);
    else for (let i = 0; i < f.packed.length; i += 4) {
        assert.equal(decoded.rgba[i + 3], f.packed[i + 3]);
        if (f.packed[i + 3]) for (let c = 0; c < 3; c++) assert.equal(decoded.rgba[i + c], f.packed[i + c]);
    }
    assert.deepEqual(f.storage, f.before, 'input/guard bytes unchanged');
}

// All nonzero pointers in these ledgers come from real WASM allocations or a
// successful real codec call. Invalid/double frees are recorded and refused.
function trackModule(real, fault = {}) {
    const callers = new Map(), outputs = new Map();
    const events = [], violations = [];
    const injectedError = new Error(`injected JavaScript fault: ${fault.kind ?? 'none'}`);
    const counts = { malloc_attempts: 0, caller_allocations: 0, caller_frees: 0, null_caller_frees: 0,
        codec_calls: 0, codec_outputs: 0, codec_output_frees: 0, heap_set_calls: 0, heap_slice_calls: 0, injected_faults: 0 };
    const inject = () => { counts.injected_faults++; throw injectedError; };
    const methods = {
        _malloc(size) {
            counts.malloc_attempts++;
            if (counts.malloc_attempts === fault.at && fault.kind === 'malloc-throw') inject();
            if (counts.malloc_attempts === fault.at && fault.kind === 'malloc-zero') {
                counts.injected_faults++; events.push({ event: 'malloc-zero', size }); return 0;
            }
            const p = real._malloc(size);
            assert(p > 0, 'fixture uses small successful real allocations; no real OOM is simulated');
            assert(!callers.has(p) && !outputs.has(p), 'fresh live allocation address');
            callers.set(p, size); counts.caller_allocations++;
            // Poison stale output-pointer slots. Correct code must initialize
            // its own output slot before ever considering it for WebPFree.
            real.HEAPU8.fill(0xa7, p, p + Math.min(size, 16));
            events.push({ event: 'malloc', pointer: p, size }); return p;
        },
        _free(p) {
            if (!p) { counts.null_caller_frees++; return real._free(0); }
            if (!callers.has(p)) {
                violations.push({ event: 'refused-unowned-caller-free', pointer: p });
                throw new Error(`Refusing unowned or duplicate caller free: ${p}`);
            }
            real._free(p); callers.delete(p); counts.caller_frees++;
            events.push({ event: 'free', pointer: p });
        },
        _webp_free(p) {
            if (!outputs.has(p)) {
                violations.push({ event: 'refused-unacquired-output-free', pointer: p });
                throw new Error(`Refusing unacquired or duplicate codec output free: ${p}`);
            }
            real._webp_free(p); outputs.delete(p); counts.codec_output_frees++;
            events.push({ event: 'webp-free', pointer: p });
        }
    };
    for (const [name, outputArg] of [['_webp_encode_lossless_rgba', 4], ['_webp_encode_lossless_rgba_level', 5], ['_webp_decode_rgba', 2]]) {
        methods[name] = (...args) => {
            counts.codec_calls++;
            const status = real[name](...args);
            events.push({ event: 'codec-return', name, status });
            if (status) {
                const p = real.HEAPU32[args[outputArg] >>> 2];
                assert(p > 0 && p < real.HEAPU8.length, 'real successful codec output');
                assert(!outputs.has(p) && !callers.has(p));
                outputs.set(p, name); counts.codec_outputs++;
                events.push({ event: 'codec-output-acquired-by-ABI', pointer: p });
            }
            // Throw AFTER real C success, before caller receives its return
            // value or assigns a local outPtr. Finally must recover the slot.
            if (fault.kind === 'after-codec-return') { assert.equal(status, 1); inject(); }
            return status;
        };
    }
    const module = new Proxy(real, {
        get(target, property) {
            if (Object.hasOwn(methods, property)) return methods[property];
            if (property === 'HEAPU8') {
                const heap = target.HEAPU8; // fresh view if WASM memory grew
                return new Proxy(heap, { get(array, key) {
                    if (key === 'set') return (...args) => {
                        counts.heap_set_calls++;
                        if (fault.kind === 'input-set') inject();
                        return array.set(...args);
                    };
                    if (key === 'slice') return (...args) => {
                        counts.heap_slice_calls++;
                        if (fault.kind === 'output-slice') inject();
                        return array.slice(...args);
                    };
                    const value = Reflect.get(array, key, array);
                    return typeof value === 'function' ? value.bind(array) : value;
                } });
            }
            return Reflect.get(target, property, target);
        }
    });
    return { module, injectedError, counts, events, violations,
        snapshot() { return { ...counts, outstanding_callers: callers.size, outstanding_codec_outputs: outputs.size,
            violations: [...violations], events: [...events] }; },
        emergencyCleanup() {
            const result = { caller_allocations: callers.size, codec_outputs: outputs.size };
            for (const p of outputs.keys()) real._webp_free(p);
            for (const p of callers.keys()) real._free(p);
            outputs.clear(); callers.clear();
            return result;
        }
    };
}

function runCase(v2, spec, f, webp) {
    const tracked = trackModule(v2.M, spec.fault);
    const codec = new v2.Codec();
    codec.Module = tracked.module;
    let value, caught;
    try {
        value = spec.operation.startsWith('encode')
            ? codec.encodeLosslessRGBA(f.input, f.width, f.height, spec.invalid ? f.width * 4 - 1 : f.stride, spec.operation === 'encode-level' ? 3 : undefined)
            : codec.decodeRGBA(spec.invalid ? new Uint8Array(16).fill(0x5a) : webp);
    } catch (error) { caught = error; }
    const observed = tracked.snapshot(); // before any harness-only remediation
    const result = { label: spec.label, operation: spec.operation, fault: spec.fault ?? null,
        status: 'running', observed, caught: errorRecord(caught) };
    try {
        if (['malloc-throw', 'input-set', 'output-slice', 'after-codec-return'].includes(spec.fault?.kind)) {
            assert.equal(caught, tracked.injectedError, 'the injected exception propagates unchanged');
        } else if (spec.invalid || spec.fault?.kind === 'malloc-zero') {
            assert(caught instanceof Error);
            assert.match(caught.message, spec.operation.startsWith('encode') ? /WebP lossless encode failed/ : /WebP decode failed/);
        } else {
            assert.equal(caught, undefined);
            if (spec.operation.startsWith('encode')) {
                assert(value instanceof Uint8Array && value.length > 12);
                assert.notEqual(value.buffer, v2.M.HEAPU8.buffer);
                assertDecoded(v2.codec.decodeRGBA(value), f);
            } else {
                assertDecoded(value, f); assert.notEqual(value.rgba.buffer, v2.M.HEAPU8.buffer);
            }
        }
        for (const [key, expected] of Object.entries(spec.expected)) assert.equal(observed[key], expected, `${spec.label}: ${key}`);
        assert.equal(observed.injected_faults, spec.fault ? 1 : 0);
        assert.equal(observed.caller_frees, observed.caller_allocations, 'every acquired caller allocation freed');
        assert.equal(observed.codec_output_frees, observed.codec_outputs, 'every successful codec output freed');
        assert.equal(observed.outstanding_callers, 0); assert.equal(observed.outstanding_codec_outputs, 0);
        assert.deepEqual(observed.violations, []);
        assert.deepEqual(f.storage, f.before);
        result.status = 'passed';
    } catch (error) { result.status = 'failed'; result.assertion = errorRecord(error); }
    finally {
        // A failing test is never converted to passed by this cleanup. Only
        // ledger-owned real pointers are touched, allowing subsequent cases.
        result.emergency_cleanup_after_measurement = tracked.emergencyCleanup();
    }
    return result;
}

function specsFor(operation) {
    const n = operation.startsWith('encode') ? 3 : 4;
    const normal = { malloc_attempts: n, caller_allocations: n, codec_calls: 1, codec_outputs: 1,
        heap_set_calls: 1, heap_slice_calls: 1 };
    const specs = [
        { label: `${operation}:success`, operation, expected: normal },
        { label: `${operation}:C-rejects-input`, operation, invalid: true,
            expected: { ...normal, codec_outputs: 0, heap_slice_calls: 0 } },
        { label: `${operation}:input-HEAPU8.set-throws`, operation, fault: { kind: 'input-set' },
            expected: { ...normal, codec_calls: 0, codec_outputs: 0, heap_slice_calls: 0 } },
        { label: `${operation}:output-HEAPU8.slice-throws`, operation, fault: { kind: 'output-slice' }, expected: normal },
        { label: `${operation}:C-succeeded-then-JS-throws-before-return`, operation, fault: { kind: 'after-codec-return' },
            expected: { ...normal, heap_slice_calls: 0 } }
    ];
    for (const at of [1, 2, n]) {
        specs.push({ label: `${operation}:malloc-${at}-throws`, operation, fault: { kind: 'malloc-throw', at },
            expected: { malloc_attempts: at, caller_allocations: at - 1, codec_calls: 0, codec_outputs: 0, heap_set_calls: 0, heap_slice_calls: 0 } });
        // No OOM: one selected allocation returns zero without calling WASM.
        // Current v2 checks the group after requesting its remaining slots.
        specs.push({ label: `${operation}:malloc-${at}-returns-zero`, operation, fault: { kind: 'malloc-zero', at },
            expected: { malloc_attempts: n, caller_allocations: n - 1, codec_calls: 0, codec_outputs: 0, heap_set_calls: 0, heap_slice_calls: 0 } });
    }
    return specs;
}

function compareSuccess(v1, v2) {
    const fixtures = [fixture('opaque', 3, 2), fixture('nonzero-alpha', 17, 5, 0, 'nonzero'),
        fixture('alpha-zero-hidden-RGB', 17, 5, 0, 'zero'), fixture('stride-padding', 17, 5, 7),
        fixture('subarray-with-nonzero-offset', 3, 2, 0, 'nonzero', 5)];
    return fixtures.flatMap(f => [undefined, 0, 1, 3, 6, 9].map(effort => {
        const oldBytes = v1.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride, effort);
        const newBytes = v2.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride, effort);
        assert.deepEqual(newBytes, oldBytes, `${f.label}: cleanup preserves encoding with same rebuilt ABI`);
        const oldDecoded = v1.codec.decodeRGBA(oldBytes), newDecoded = v2.codec.decodeRGBA(newBytes);
        assert.equal(newDecoded.width, oldDecoded.width); assert.equal(newDecoded.height, oldDecoded.height);
        assert.deepEqual(newDecoded.rgba, oldDecoded.rgba);
        assertDecoded(newDecoded, f, effort !== undefined || f.label !== 'alpha-zero-hidden-RGB');
        return { fixture:f.label, effort:effort ?? 'default', encoded_bytes:newBytes.length,
            encoded_sha256:sha(newBytes), encode_bytes_identical:true, all_decoded_rgba_bytes_identical:true };
    }));
}

async function main(report) {
    report.bindings = { v1_source: record(V1_SOURCE), v2_source: record(V2_SOURCE), glue: record(GLUE), wasm: record(WASM) };
    const ts = require('typescript');
    const { default: factory } = await import(pathToFileURL(GLUE).href);
    const v1 = await loadCodec(V1_SOURCE, 'v1', factory, ts);
    const v2 = await loadCodec(V2_SOURCE, 'v2', factory, ts);
    assert.notEqual(v1.Codec, v2.Codec); assert.notEqual(v1.M, v2.M);
    assert.notEqual(v1.M.HEAPU8.buffer, v2.M.HEAPU8.buffer);
    report.initialization = { independent_classes_and_instances: true, v1_factory_calls: v1.factoryCalls, v2_factory_calls: v2.factoryCalls,
        v1_locations: v1.locations, v2_locations: v2.locations, same_glue_and_wasm: true };
    report.success_path_comparison = compareSuccess(v1, v2);
    const officialGlue = resolve(OUT, 'originals/package/lib/webp.mjs');
    const officialWasm = resolve(OUT, 'originals/package/lib/webp.wasm');
    const { default: officialFactory } = await import(pathToFileURL(officialGlue).href);
    const official = await loadCodec(V1_SOURCE, 'npm-official-3.10.2', officialFactory, ts, officialWasm);
    report.official_binary_bindings = { glue:record(officialGlue), wasm:record(officialWasm) };
    report.official_binary_comparison = [fixture('opaque', 3, 2), fixture('transparent', 7, 5, 3, 'zero')].flatMap(f =>
        [undefined, 0, 1, 3, 6, 9].map(effort => {
            const expected = official.codec.encodeLosslessRGBA(f.input,f.width,f.height,f.stride,effort);
            const actual = v2.codec.encodeLosslessRGBA(f.input,f.width,f.height,f.stride,effort);
            assert.deepEqual(v2.codec.decodeRGBA(actual),official.codec.decodeRGBA(expected));
            assert.deepEqual(v2.codec.decodeRGBA(expected),official.codec.decodeRGBA(actual));
            return { fixture:f.label, effort:effort ?? 'default', identical_decoded_RGBA:true,
                cross_decode:true, encoded_bytes_identical:Buffer.from(expected).equals(Buffer.from(actual)),
                official_encoded_sha256:sha(expected), candidate_encoded_sha256:sha(actual) };
        }));
    const f = fixture('exception-fixture-opaque', 3, 2);
    const webp = v2.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride);
    report.invalid_efforts = [-1, 10, 1.5, NaN, Infinity].map(effort => { assert.throws(() => v2.codec.encodeLosslessRGBA(f.input, f.width, f.height, f.stride, effort), /effort must/); return String(effort); });
    report.cases = [];
    for (const spec of [...specsFor('encode'), ...specsFor('encode-level'), ...specsFor('decode')]) {
        const result = runCase(v2, spec, f, webp);
        // Same underlying module must still support valid operations after
        // each injected failure; these calls have their own real ledgers.
        result.recovery = ['encode', 'encode-level', 'decode'].map(operation => runCase(v2,
            { ...specsFor(operation)[0], label: `${spec.label}:recovery-${operation}` }, f, webp));
        report.cases.push(result);
    }
    for (const binding of Object.values(report.bindings)) assert.deepEqual(record(binding.path), binding, 'input binding unchanged during verification');
    const failures = report.cases.filter(row => row.status !== 'passed' || row.recovery.some(r => r.status !== 'passed'));
    report.counts = { primary_cases: report.cases.length, recovery_cases: report.cases.length * 3,
        successful_output_comparisons: report.success_path_comparison.length, failed_case_groups: failures.length };
    assert.equal(failures.length, 0, `Failed cleanup groups: ${failures.map(failure => failure.label).join(', ')}`);
}

const report = { status: 'running', started_at: new Date().toISOString(), script: record(SCRIPT),
    scope: 'Actual official 3.10.2 and cleanup-patched 3.10.2 TypeScript classes, independently instantiated from the same candidate glue/WASM. Real caller allocation and codec-output ownership measured through a Module Proxy; only bounded JS exceptions and one mocked null allocation are injected.',
    boundaries: [
        'No real OOM, allocator corruption, invalid free, arbitrary pointer, trap, browser, worker, full application, GPU or production packaging claim.',
        'Unowned frees are refused by the harness before reaching real WASM. Failed-case emergency cleanup never changes the recorded failing result.',
        'Counters cover caller-visible allocation/free and outputs from real codec returns, not every internal libwebp allocation.',
        'Official 3.10.2 and patched 3.10.2 TS comparison uses the same rebuilt binary. It proves cleanup preserves successful output; default exact=0 may still change RGB under fully transparent pixels relative to input.',
        'The production baseline harness and license/public/app resources are not modified.'
    ] };
try { await main(report); report.status = 'passed'; }
catch (error) { report.status = 'failed'; report.error = errorRecord(error); process.exitCode = 1; }
report.completed_at = new Date().toISOString();
console.log(JSON.stringify(report, null, 2));
