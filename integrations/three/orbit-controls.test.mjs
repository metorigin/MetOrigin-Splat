import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, key, listeners, sourceIdentity } from './orbit-controls-harness.mjs';

console.log('# OrbitControls source ' + JSON.stringify(sourceIdentity));
const down = (root, c) => listeners(root, 'keydown', c._interceptControlDown);
const up = (root, c) => listeners(root, 'keyup', c._interceptControlUp);
function clean(root, c) {
  assert.equal(down(root, c), 0, 'no registered keydown callback remains');
  assert.equal(up(root, c), 0, 'no registered keyup callback remains');
  assert.equal(c._controlActive, false, 'disconnect clears held Control state');
}

test('attached dispose removes the real Document listener', t => {
  const f = fixture(t), { canvas } = f.canvas(), c = f.control(canvas);
  assert.equal(down(f.document, c), 1);
  c.dispose(); clean(f.document, c);
  key(f.document, 'keydown'); assert.equal(c._controlActive, false);
});
test('ancestor detachment before dispose removes the original Document listener', t => {
  const f = fixture(t), { host, canvas } = f.canvas(), c = f.control(canvas);
  host.remove(); assert.equal(canvas.getRootNode(), host);
  c.dispose(); clean(f.document, c);
  key(f.document, 'keydown'); assert.equal(c._controlActive, false);
});
test('canvas removal before dispose removes the original Document listener', t => {
  const f = fixture(t), { canvas } = f.canvas(), c = f.control(canvas);
  canvas.remove(); c.dispose(); clean(f.document, c);
});
test('dispose while Control is held removes keyup and resets state', t => {
  const f = fixture(t), { canvas } = f.canvas(), c = f.control(canvas);
  key(f.document, 'keydown'); assert.equal(c._controlActive, true); assert.equal(up(f.document, c), 1);
  c.dispose(); clean(f.document, c);
});
test('detached dispose while Control is held clears both original-root callbacks', t => {
  const f = fixture(t), { host, canvas } = f.canvas(), c = f.control(canvas);
  key(f.document, 'keydown'); host.remove(); c.dispose(); clean(f.document, c); clean(host, c);
});
test('keyup after DOM detachment removes itself from the registered root', t => {
  const f = fixture(t), { host, canvas } = f.canvas(), c = f.control(canvas);
  key(f.document, 'keydown'); host.remove(); key(f.document, 'keyup');
  assert.equal(c._controlActive, false); assert.equal(up(f.document, c), 0);
  c.dispose(); clean(f.document, c);
});
test('Control keydown after cross-document movement still uses its registered root', t => {
  const f = fixture(t), { host, canvas } = f.canvas(), c = f.control(canvas), second = f.newDocument();
  second.body.appendChild(host); assert.equal(canvas.getRootNode(), second);
  key(f.document, 'keydown'); assert.equal(up(f.document, c), 1); assert.equal(up(second, c), 0);
  key(f.document, 'keyup'); assert.equal(c._controlActive, false); assert.equal(up(f.document, c), 0);
  c.dispose(); clean(f.document, c); clean(second, c);
});
test('keyup after moving into another document clears the original-root listener', t => {
  const f = fixture(t), { host, canvas } = f.canvas(), c = f.control(canvas), second = f.newDocument();
  key(f.document, 'keydown'); second.body.appendChild(host); key(f.document, 'keyup');
  assert.equal(up(f.document, c), 0); assert.equal(c._controlActive, false);
  c.dispose(); clean(f.document, c); clean(second, c);
});
test('same-element reconnect has exactly one active keydown and no stale keyup', t => {
  const f = fixture(t), { canvas } = f.canvas(), c = f.control(canvas);
  key(f.document, 'keydown'); c.connect(canvas);
  assert.equal(down(f.document, c), 1); assert.equal(up(f.document, c), 0); assert.equal(c._controlActive, false);
  c.dispose(); clean(f.document, c);
});
test('same-document reconnect to another canvas cleans a detached old connection', t => {
  const f = fixture(t), first = f.canvas(), second = f.canvas(), c = f.control(first.canvas);
  key(f.document, 'keydown'); first.host.remove(); c.connect(second.canvas);
  assert.equal(c.domElement, second.canvas); assert.equal(down(f.document, c), 1);
  assert.equal(up(f.document, c), 0); assert.equal(c._controlActive, false);
  c.dispose(); clean(f.document, c);
});
test('cross-document reconnect clears the old root before registering the new root', t => {
  const f = fixture(t), first = f.canvas(), other = f.newDocument(), second = f.canvas(other.body), c = f.control(first.canvas);
  key(f.document, 'keydown'); first.host.remove(); c.connect(second.canvas);
  clean(f.document, c); assert.equal(down(other, c), 1);
  key(other, 'keydown'); assert.equal(c._controlActive, true); key(other, 'keyup');
  c.dispose(); clean(other, c);
});
test('ShadowRoot registrations remain scoped to that root', t => {
  const f = fixture(t), root = f.shadow(), { canvas } = f.canvas(root), c = f.control(canvas);
  assert.equal(down(root, c), 1); assert.equal(down(f.document, c), 0);
  key(root, 'keydown'); assert.equal(up(root, c), 1);
  c.dispose(); clean(root, c); clean(f.document, c);
});
test('removing a canvas from ShadowRoot before dispose clears that ShadowRoot', t => {
  const f = fixture(t), root = f.shadow(), { canvas } = f.canvas(root), c = f.control(canvas);
  canvas.remove(); c.dispose(); clean(root, c);
});
test('document-to-ShadowRoot reconnect clears the old detached registration', t => {
  const f = fixture(t), first = f.canvas(), root = f.shadow(), second = f.canvas(root), c = f.control(first.canvas);
  key(f.document, 'keydown'); first.host.remove(); c.connect(second.canvas);
  clean(f.document, c); assert.equal(down(root, c), 1); c.dispose(); clean(root, c);
});
test('ShadowRoot-to-document reconnect clears the former shadow registration', t => {
  const f = fixture(t), root = f.shadow(), first = f.canvas(root), second = f.canvas(), c = f.control(first.canvas);
  key(root, 'keydown'); first.canvas.remove(); c.connect(second.canvas);
  clean(root, c); assert.equal(down(f.document, c), 1); c.dispose(); clean(f.document, c);
});
test('never-connected controls support disconnect and repeated dispose, then connect', t => {
  const f = fixture(t), c = f.control();
  assert.doesNotThrow(() => { c.disconnect(); c.dispose(); c.dispose(); });
  assert.equal(c._controlActive, false);
  const { canvas } = f.canvas(); c.connect(canvas); assert.equal(down(f.document, c), 1);
  c.dispose(); clean(f.document, c);
});
test('repeated disposal after detach remains safe and permits a later reconnect', t => {
  const f = fixture(t), first = f.canvas(), second = f.canvas(), c = f.control(first.canvas);
  first.host.remove(); c.dispose(); c.dispose(); c.disconnect(); clean(f.document, c);
  c.connect(second.canvas); assert.equal(down(f.document, c), 1); c.dispose(); clean(f.document, c);
});
test('ordinary Control keyup removes its temporary callback while keydown stays connected', t => {
  const f = fixture(t), { canvas } = f.canvas(), c = f.control(canvas);
  key(f.document, 'keydown'); key(f.document, 'keyup');
  assert.equal(c._controlActive, false); assert.equal(up(f.document, c), 0); assert.equal(down(f.document, c), 1);
  c.dispose(); clean(f.document, c);
});
