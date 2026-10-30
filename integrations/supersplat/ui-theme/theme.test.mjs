import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adaptCompiledCss, applyThemeSources, themeInputs } from './apply.mjs';
import { preparationSignature } from '../prepared-assets.mjs';

const integration = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(integration, '../..');
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('../../../apps/desktop/node_modules/vite/package.json'));
const parse = viteRequire('postcss').parse;
const theme = JSON.parse(await readFile(join(root, 'integrations/jan/theme.json'), 'utf8'));

async function presentationMigration() {
  const ts = require('../../../apps/desktop/node_modules/typescript');
  const source = await readFile(join(integration, 'ui-theme/presentation.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const exports = {};
  const window = { parent: {} };
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('Storage is inaccessible'); } });
  new Function('exports', 'window', compiled)(exports, window);
  return exports.migrateEmbeddedOverlayDefaults;
}

const preferenceKey = 'supersplat:preferences';
const overlayMigrationKey = 'metorigin:supersplat:overlay-defaults:v1';
function preferenceStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data, writes,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); data.set(key, value); }
  };
}

test('embedded overlay defaults migrate once while other preferences and later user choices survive', async () => {
  const migrate = await presentationMigration();
  const original = { version: 1, retained: { note: 'keep metadata' }, values: {
    'camera.showInfo': true, 'view.perfOverlay': true, 'grid.visible': false,
    'camera.fov': 73, 'view.stochastic': 'movement', bgClr: [0.1, 0.2, 0.3, 1]
  } };
  const storage = preferenceStorage({ [preferenceKey]: JSON.stringify(original) });
  migrate(true, storage);
  const migrated = JSON.parse(storage.getItem(preferenceKey));
  assert.deepEqual(migrated, { ...original, values: { ...original.values,
    'camera.showInfo': false, 'view.perfOverlay': false
  } });
  assert.deepEqual(storage.writes, [preferenceKey, overlayMigrationKey]);
  assert.equal(storage.getItem(overlayMigrationKey), '1');

  // Simulate a later manual toggle persisted by the real upstream owner.
  const manuallyEnabled = JSON.stringify({ ...migrated, values: { ...migrated.values,
    'camera.showInfo': true, 'view.perfOverlay': true
  } });
  storage.data.set(preferenceKey, manuallyEnabled);
  migrate(true, storage);
  assert.equal(storage.getItem(preferenceKey), manuallyEnabled);
  assert.deepEqual(storage.writes, [preferenceKey, overlayMigrationKey]);

  const fresh = preferenceStorage();
  migrate(true, fresh);
  assert.deepEqual(JSON.parse(fresh.getItem(preferenceKey)), { version: 1, values: {
    'camera.showInfo': false, 'view.perfOverlay': false
  } });
  assert.equal(fresh.getItem(overlayMigrationKey), '1');
});

test('overlay migration preserves malformed or future preferences and stays retryable after storage failures', async () => {
  const migrate = await presentationMigration();
  for (const raw of ['broken json', JSON.stringify({ version: 2, values: {} }),
    JSON.stringify({ version: 1, values: [] }), JSON.stringify({ version: 1, values: null }),
    JSON.stringify({ version: 1, values: 42 })]) {
    const storage = preferenceStorage({ [preferenceKey]: raw });
    assert.doesNotThrow(() => migrate(true, storage));
    assert.equal(storage.getItem(preferenceKey), raw);
    assert.equal(storage.getItem(overlayMigrationKey), null);
    assert.deepEqual(storage.writes, []);
  }
  assert.doesNotThrow(() => migrate(true));
  assert.doesNotThrow(() => migrate(true, {
    getItem: () => { throw new Error('Read denied'); },
    setItem: () => assert.fail('An unreadable store must not be overwritten')
  }));

  for (const failedKey of [preferenceKey, overlayMigrationKey]) {
    const original = JSON.stringify({ version: 1, values: { 'camera.showInfo': true, 'camera.fov': 73 } });
    const storage = preferenceStorage({ [preferenceKey]: original });
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === failedKey) throw new Error('Write denied');
      setItem(key, value);
    };
    assert.doesNotThrow(() => migrate(true, storage));
    assert.equal(storage.getItem(overlayMigrationKey), null);
    assert.equal(JSON.parse(storage.getItem(preferenceKey)).values['camera.fov'], 73);
    if (failedKey === preferenceKey) assert.equal(storage.getItem(preferenceKey), original);
    storage.setItem = setItem;
    migrate(true, storage);
    assert.equal(storage.getItem(overlayMigrationKey), '1');
    assert.equal(JSON.parse(storage.getItem(preferenceKey)).values['camera.showInfo'], false);
  }
});

test('standalone overlay migration never reads or changes browser storage', async () => {
  const migrate = await presentationMigration();
  const forbidden = () => assert.fail('Standalone preferences must be untouched');
  assert.doesNotThrow(() => migrate(false, { getItem: forbidden, setItem: forbidden }));
  assert.doesNotThrow(() => migrate(false));
});

test('PCUI neutral/active/error states share the host palette while data and viewport selection colors stay unchanged', () => {
  const source = '.menu {color:#fff;background-color:#333;border:1px solid #aaa}' +
    '.menu:hover {color:#f60}.menu.pcui-error {color:#fb222f}' +
    '.tool-svg circle {fill:#f60;stroke:#fff}.pcui-color-input {background:linear-gradient(#fff,#000)}' +
    '.picker-color .pick-rect .white {background:linear-gradient(to right,#fff,rgba(255, 255, 255, 0.01))}';
  const css = adaptCompiledCss(source, parse, theme);
  assert.match(css, /--mo-primary: #be4c30/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /color:var\(--mo-foreground\);background-color:var\(--mo-card\)/);
  assert.match(css, /color:var\(--mo-primary\)/);
  assert.match(css, /color:var\(--mo-destructive\)/);
  assert.match(css, /\.tool-svg circle \{fill:#f60;stroke:#fff\}/);
  assert.match(css, /linear-gradient\(#fff,#000\)/);
  assert.match(css, /linear-gradient\(to right,#fff,rgba\(255, 255, 255, 0.01\)\)/);
  assert.equal(adaptCompiledCss(source, parse, theme), css);
});

test('embedded language row stays hidden despite upstream ID-scoped display flex', async () => {
  const { JSDOM } = require('../../../apps/desktop/node_modules/jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="settings-panel"><div class="settings-panel-row pcui-hidden"></div></div></body></html>');
  const style = dom.window.document.createElement('style');
  // This is the actual compiled upstream cascade that overrode PCUI hidden.
  style.textContent = '.pcui-hidden{display:none}#settings-panel>.settings-panel-row{display:flex}\n' +
    await readFile(join(integration, 'ui-theme/controls.css'), 'utf8');
  dom.window.document.head.append(style);
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('.settings-panel-row')).display, 'none');
  dom.window.close();
});

test('source patching fails closed on a different fixed upstream source', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'supersplat-theme-source-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'src/ui'), { recursive: true });
  await writeFile(join(path, 'src/ui/histogram.ts'), 'unrecognized upstream');
  await assert.rejects(applyThemeSources(integration, path), /Pinned SuperSplat UI input differs/);
});

test('3.10.2 loader and fixed evidence profile changes invalidate the preparation cache', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'supersplat-current-overlay-inputs-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const local = join(temporary, 'integrations/supersplat');
  await mkdir(local, { recursive: true });
  for (const name of ['prepare.mjs', 'prepared-assets.mjs', 'webp-overlay.mjs', 'webp-evidence.mjs', 'ui-theme']) {
    await cp(join(integration, name), join(local, name), { recursive: true });
  }
  for (const input of (await themeInputs(integration)).filter((entry) => !entry.path.startsWith('integrations/supersplat/'))) {
    const path = join(temporary, input.path);
    await mkdir(dirname(path), { recursive: true });
    await cp(join(root, input.path), path);
  }
  const helpers = ['overlay.mjs', 'verify-evidence.mjs', 'profile.mjs'];
  const directory = join(local, 'webp-overlay-3.10.2');
  await mkdir(directory);
  for (const name of helpers) await cp(join(integration, 'webp-overlay-3.10.2', name), join(directory, name));
  const overlay = { manifest: { id: 'current-profile', base: { version: '3.10.2' }, build_evidence_sha256: 'e'.repeat(64) }, digest: 'a'.repeat(64) };
  const signature = () => preparationSignature(local, { commit: 'fixed' }, 'bridge', overlay);
  const baseline = await signature();
  for (const name of helpers) {
    const path = join(directory, name);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\nchanged')]));
    assert.notEqual(await signature(), baseline, name);
    await writeFile(path, original);
  }
  await rm(join(directory, 'profile.mjs'));
  await assert.rejects(signature(), /ENOENT/);
});

test('all theme, paint, font and helper inputs change the preparation identity; missing inputs fail', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'supersplat-theme-inputs-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const local = join(temporary, 'integrations/supersplat');
  await mkdir(local, { recursive: true });
  for (const name of ['prepare.mjs', 'prepared-assets.mjs', 'webp-overlay.mjs', 'webp-evidence.mjs', 'ui-theme']) {
    await cp(join(integration, name), join(local, name), { recursive: true });
  }
  const inputs = await themeInputs(integration);
  for (const input of inputs.filter((entry) => !entry.path.startsWith('integrations/supersplat/'))) {
    const path = join(temporary, input.path);
    await mkdir(dirname(path), { recursive: true });
    await cp(join(root, input.path), path);
  }
  const overlay = { manifest: { id: 'theme-test', build_evidence_sha256: 'e'.repeat(64) }, digest: 'a'.repeat(64) };
  const signature = () => preparationSignature(local, { commit: 'fixed' }, 'bridge', overlay);
  const baseline = await signature();
  for (const path of ['integrations/jan/theme.json', 'integrations/supersplat/ui-theme/runtime.ts',
    'integrations/supersplat/ui-theme/controls.css', 'integrations/supersplat/ui-theme/apply.mjs',
    'apps/desktop/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2']) {
    const original = await readFile(join(temporary, path));
    await writeFile(join(temporary, path), Buffer.concat([original, Buffer.from('\nchanged')]));
    assert.notEqual(await signature(), baseline, path);
    await writeFile(join(temporary, path), original);
  }
  await rm(join(local, 'ui-theme/controls.css'));
  // The manifest must explicitly require the adapter; removing it cannot silently
  // turn this into an upstream-only UI with a fresh cache signature.
  await assert.rejects(themeInputs(local), /ENOENT|Missing/);
});
