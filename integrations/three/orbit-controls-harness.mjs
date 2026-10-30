import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'apps/desktop');
const requireApp = createRequire(path.join(app, 'package.json'));
const threeRoot = fs.realpathSync(path.join(app, 'node_modules/three'));
const threeUrl = pathToFileURL(path.join(threeRoot, 'build/three.module.js')).href;
const installedSource = path.join(threeRoot, 'examples/jsm/controls/OrbitControls.js');
const sourcePath = process.env.METORIGIN_THREE_ORBIT_SOURCE
  ? path.resolve(process.env.METORIGIN_THREE_ORBIT_SOURCE) : installedSource;
const source = fs.readFileSync(sourcePath, 'utf8');
const { JSDOM } = requireApp('jsdom');
const jsdomRoot = path.dirname(requireApp.resolve('jsdom/package.json'));
const { implForWrapper } = requireApp(path.join(jsdomRoot, 'lib/jsdom/living/generated/utils.js'));
const { PerspectiveCamera } = await import(threeUrl);
let orbitModule;
if (sourcePath === installedSource) {
  orbitModule = await import(pathToFileURL(installedSource).href);
} else {
  // Scratch derivatives retain the actual implementation. Only resolve their
  // one bare import to the same installed Three module; no DOM/controls stubs.
  const importText = "from 'three';";
  if (source.split(importText).length !== 2) throw new Error('Unexpected OrbitControls import shape');
  const resolved = source.replace(importText, `from ${JSON.stringify(threeUrl)};`);
  orbitModule = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
}
export const sourceIdentity = {
  path: sourcePath, sha256: createHash('sha256').update(source).digest('hex'),
  size_bytes: Buffer.byteLength(source), mode: sourcePath === installedSource ? 'installed-module' : 'scratch-source-with-import-resolution-only',
  three_version: JSON.parse(fs.readFileSync(path.join(threeRoot, 'package.json'), 'utf8')).version,
  jsdom_version: JSON.parse(fs.readFileSync(path.join(jsdomRoot, 'package.json'), 'utf8')).version,
};

export function listeners(target, type, callback) {
  return (implForWrapper(target)._eventListeners[type] ?? [])
    .filter(entry => entry.callback.objectReference === callback && entry.options.capture === true).length;
}
export function key(target, type, value = 'Control') {
  const document = target.nodeType === 9 ? target : target.ownerDocument;
  target.dispatchEvent(new document.defaultView.KeyboardEvent(type, { key: value }));
}
export function fixture(t) {
  const windows = [], controls = [], roots = new Set();
  function document() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    windows.push(dom.window); roots.add(dom.window.document);
    return dom.window.document;
  }
  const doc = document();
  function canvas(parent = doc.body) {
    const d = parent.ownerDocument;
    const host = d.createElement('div'), element = d.createElement('canvas');
    host.appendChild(element); parent.appendChild(host);
    roots.add(parent.getRootNode()); roots.add(host); roots.add(element);
    return { host, canvas: element };
  }
  function shadow(d = doc) {
    const host = d.createElement('div'); d.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); roots.add(root);
    return root;
  }
  function control(element = null) {
    const camera = new PerspectiveCamera(52, 1, 0.01, 10000);
    const value = new orbitModule.OrbitControls(camera, element); controls.push(value);
    return value;
  }
  t.after(() => {
    // Tests deliberately retain targets while asserting actual listener effects;
    // this is not a collection or native-memory test. Clean failures as well.
    for (const value of controls) for (const root of roots) {
      root.removeEventListener('keydown', value._interceptControlDown, { capture: true });
      root.removeEventListener('keyup', value._interceptControlUp, { capture: true });
    }
    for (const window of windows) window.close();
  });
  return { document: doc, newDocument: document, canvas, shadow, control };
}
