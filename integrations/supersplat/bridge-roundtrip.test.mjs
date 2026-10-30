import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const integration = dirname(fileURLToPath(import.meta.url));
const root = resolve(integration, '../..');
const upstream = join(root, 'target/supersplat-source/upstream');
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));
const ts = desktopRequire('typescript');
const pin = JSON.parse(await readFile(join(integration, 'upstream.json'), 'utf8'));
assert.equal(pin.commit, 'b89029dd20911fd18905b61de2701094ac390a73');
assert.equal((await readFile(join(upstream, '.git/HEAD'), 'utf8')).trim(), pin.commit,
    'Prepare the fixed SuperSplat source before running the real serializer regression.');
assert.equal(JSON.parse(await readFile(join(upstream, 'node_modules/@playcanvas/splat-transform/package.json'), 'utf8')).version, '3.10.2');

const transform = await import(pathToFileURL(join(upstream, 'node_modules/@playcanvas/splat-transform/dist/index.mjs')));
const viewer = await import(pathToFileURL(join(upstream, 'node_modules/@playcanvas/splat-transform/dist/viewer-settings.mjs')));
const pcPackage = JSON.parse(await readFile(join(upstream, 'node_modules/playcanvas/package.json'), 'utf8'));
const pc = await import(pathToFileURL(join(upstream, 'node_modules/playcanvas', pcPackage.module)));
const compile = (text) => ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText;

const evaluate = (text, modules) => {
    const exports = {};
    new Function('exports', 'require', compile(text))(exports, (name) => {
        assert.ok(Object.hasOwn(modules, name), `Unexpected serializer module: ${name}`);
        return modules[name];
    });
    return exports;
};

const readUpstream = (name) => readFile(join(upstream, 'src', name), 'utf8');
const color = evaluate(await readUpstream('color-grade.ts'), {});
const sh = evaluate(await readUpstream('sh-utils.ts'), { playcanvas: pc });
const state = evaluate(await readUpstream('splat-state.ts'), {});
const serializerSource = await readUpstream('splat-serialize.ts');
assert.equal(createHash('sha256').update(serializerSource).digest('hex'),
    'dd9c4efeb9909c84abc5d1e31f6d82d4e67d84ac00e5e1c9e2a396804d6cf7f8');

// Run the actual upstream serializer and math. Only unused viewer/document
// boundaries are absent; plain PLY export requires no renderer or GPU device.
const serializer = evaluate(serializerSource, {
    '@playcanvas/splat-transform': transform,
    '@playcanvas/splat-transform/viewer-settings': viewer,
    playcanvas: pc,
    '../package.json': JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')),
    './color-grade': color,
    './gaussian-instances': {},
    './io': {},
    './sh-utils': sh,
    './splat-state': state
});

const bridgeSource = await readFile(join(integration, 'metorigin-bridge.ts'), 'utf8');

function fixture(bands) {
    const restCount = [0, 9, 24, 45][bands];
    const columns = {
        x: [1, 4, 7], y: [2, 5, 8], z: [3, 6, 9],
        rot_0: [1, 1, 1], rot_1: [0, 0, 0], rot_2: [0, 0, 0], rot_3: [0, 0, 0],
        scale_0: [-2, -2, -2], scale_1: [-2, -2, -2], scale_2: [-2, -2, -2],
        opacity: [0.2, 0.3, 0.4],
        f_dc_0: [0.1, 0.2, 0.3], f_dc_1: [0.3, 0.4, 0.5], f_dc_2: [0.5, 0.6, 0.7]
    };
    for (let i = 0; i < restCount; ++i) {
        columns[`f_rest_${i}`] = [0.01, 0.02, 0.03].map((value) => value * (i + 1));
    }
    const table = new transform.DataTable(Object.entries(columns)
    .map(([name, values]) => new transform.Column(name, Float32Array.from(values))), transform.Transform.PLY);
    const source = transform.dataTableToChunkSource(table);
    const world = new pc.Mat4().setTRS(new pc.Vec3(0.5, -1, 2),
        new pc.Quat().setFromEulerAngles(0, 0, 180), new pc.Vec3(1, 1, 1));
    const palette = new pc.Mat4().setTRS(new pc.Vec3(0.25, 0, 0), new pc.Quat(), new pc.Vec3(1, 1, 1));
    return {
        table, source,
        splat: {
            resource: { source, shBands: bands },
            entity: { getWorldTransform: () => world },
            // A deleted middle gaussian is absent and the live order is changed.
            // The second remaining instance also carries a palette translation.
            instances: {
                count: 2, sourceRow: new Uint32Array([2, 0]), flags: new Uint8Array([1, 0]),
                transformIndex: (index) => index, colorIndex: () => 0
            },
            transformPalette: { getTransform: (_index, result) => result.copy(palette) },
            colorPalette: { getEntry: (_index, result) => result }
        }
    };
}

function connect(splat) {
    let receive;
    const replies = new Map();
    const parent = { postMessage: (message) => replies.set(message.id, message) };
    const window = {
        parent, location: { origin: 'https://editor.test' },
        addEventListener: (_name, callback) => { receive = callback; }
    };
    let dirty = true;
    const savedEvents = [];
    const events = {
        functions: new Map([['render.image', async () => true]]),
        invoke: (name, callback) => {
            if (name === 'scene.splats') return [splat];
            if (name === 'scene.dirty') return dirty;
            if (name === 'queue') return callback();
            throw new Error(`Unexpected scene operation: ${name}`);
        },
        fire: (name) => { savedEvents.push(name); if (name === 'doc.saved') dirty = false; }
    };
    // Supply the same-origin Window boundary; the bridge itself and every
    // serialization call are production code, not a test implementation.
    const exports = {};
    new Function('exports', 'require', 'window', compile(bridgeSource))(exports, (name) => {
        if (name === '@playcanvas/splat-transform') return transform;
        if (name === 'playcanvas') return pc;
        if (name === './splat-serialize') return serializer;
        if (name === './ui/localization') return { i18n: { setLanguage: async () => undefined } };
        if (name === './ui/metorigin-theme') return {
            createEditorLanguageOwner: () => ({ fromEditor: async () => undefined }), applyEditorTheme: () => true
        };
        throw new Error(`Unexpected bridge module: ${name}`);
    }, window);
    exports.registerMetOriginBridge(events, { camera: {} });
    return {
        savedEvents,
        request: async (id, command, data) => {
            await receive({ source: parent, origin: window.location.origin,
                data: { channel: 'metorigin-supersplat-v1', id, command, data } });
            return replies.get(id);
        }
    };
}

for (const bands of [0, 1, 3]) {
    test(`actual editor bridge saves and rereads SH${bands} without padding, lost edits or false clean state`, async () => {
        const input = fixture(bands);
        const client = connect(input.splat);
        try {
            const exported = await client.request('export-1', 'export');
            assert.equal(exported.error, undefined);
            assert.ok(exported.result instanceof ArrayBuffer);
            const fs = new transform.MemoryReadFileSystem();
            fs.set('scene.ply', new Uint8Array(exported.result));
            const sources = await transform.readFile({ filename: 'scene.ply', inputFormat: 'ply', fileSystem: fs });
            assert.equal(sources.length, 1);
            const output = sources[0];
            const pool = transform.createChunkDataPool({ chunkSize: output.meta.chunkSize });
            try {
                assert.equal(output.meta.shBands, bands);
                assert.equal(output.meta.numGaussians, 2);
                const table = await transform.materializeToDataTable(output, pool);
                assert.equal(table.columnNames.filter((name) => name.startsWith('f_rest_')).length, [0, 9, 24, 45][bands]);
                for (const column of table.columns) {
                    assert.ok(Array.from(column.data).every(Number.isFinite), `Non-finite ${column.name}`);
                }
                const expectedPositions = [[6.5, 9, 11], [0.75, 3, 5]];
                for (let row = 0; row < 2; ++row) {
                    for (const [axis, name] of ['x', 'y', 'z'].entries()) {
                        assert.ok(Math.abs(table.getColumnByName(name).data[row] - expectedPositions[row][axis]) < 1e-5,
                            `Lost imported/world/palette transform for row ${row}, ${name}`);
                    }
                    for (let i = 0; i < [0, 9, 24, 45][bands]; ++i) {
                        const sourceRow = [2, 0][row];
                        assert.ok(Math.abs(table.getColumnByName(`f_rest_${i}`).data[row]
                            - input.table.getColumnByName(`f_rest_${i}`).data[sourceRow]) < 1e-5);
                    }
                }
                assert.deepEqual(Array.from(input.table.getColumnByName('x').data), [1, 4, 7]);
            } finally {
                pool.destroy();
                await output.close();
            }
            assert.equal((await client.request('dirty-before-save', 'dirty')).result, true);
            assert.match((await client.request('blocked', 'export')).error, /编辑器正在处理/);
            assert.match((await client.request('wrong-ack', 'saved', { saveId: 'other-export' })).error, /保存会话不匹配/);
            assert.equal((await client.request('failed', 'save-failed', { saveId: 'export-1' })).result, true);
            assert.equal((await client.request('dirty-after-failure', 'dirty')).result, true);
            const second = await client.request('export-2', 'export');
            assert.equal(second.error, undefined);
            assert.equal((await client.request('saved', 'saved', { saveId: 'export-2' })).result, true);
            assert.equal((await client.request('clean-after-ack', 'dirty')).result, false);
            assert.deepEqual(client.savedEvents, ['doc.saved']);
        } finally {
            await input.source.close();
        }
    });
}
