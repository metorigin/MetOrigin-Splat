import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { npmDependencyEdges, resolveNpmManifest, unresolvedPeerReason, verifyUnresolvedNpmPeers } from './NpmDependencyGraph.mjs';

async function fixture(t, declarations = {}) {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'npm evidence 中文 ')));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const root = join(outer, 'checkout');
  const source = join(root, '.cache/supersplat');
  const put = async (directory, pkg) => {
    await mkdir(directory, { recursive: true });
    const manifest = join(directory, 'package.json');
    await writeFile(manifest, JSON.stringify(pkg));
    return manifest;
  };
  const pkg = { name: '@playcanvas/pcui', version: '6.1.4', ...declarations };
  const manifest = await put(source, pkg);
  return { outer, root, source, pkg, manifest, put,
    inspect: () => npmDependencyEdges(manifest, root),
    bom: { components: [{ 'bom-ref': 'pkg:npm/%40playcanvas/pcui@6.1.4', name: pkg.name, version: pkg.version }] } };
}

test('missing pure peers retain declaration details without installed edges or bundled claims', async t => {
  const f = await fixture(t, { peerDependencies: { react: '^18.3.1 || ^19.0.0', 'react-dom': '^18.3.1 || ^19.0.0' },
    peerDependenciesMeta: { 'react-dom': { optional: true } } });
  const result = f.inspect();
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.unresolvedPeers, [false, true].map((optional, index) => ({
    component: 'pkg:npm/%40playcanvas/pcui@6.1.4', peer: index ? 'react-dom' : 'react',
    requested_version: '^18.3.1 || ^19.0.0', optional,
    installed_in_package_tree: false, claimed_as_bundled: false, reason: unresolvedPeerReason,
  })));
  verifyUnresolvedNpmPeers(result.unresolvedPeers, f.bom);
});

test('missing required dependencies remain fatal even with an optional same-name peer', async t => {
  for (const peerOptional of [false, true]) await t.test(`peer optional ${peerOptional}`, async t => {
    const f = await fixture(t, { dependencies: { react: '^19.0.0' }, peerDependencies: { react: '*' },
      peerDependenciesMeta: { react: { optional: peerOptional } } });
    assert.throws(f.inspect, /Installed dependency react of @playcanvas\/pcui is missing/);
  });
  const f = await fixture(t, { dependencies: { required: '^1.0.0' } });
  assert.throws(f.inspect, /Installed dependency required/);
});

test('optional dependencies override same-name declarations and dev dependencies stay outside the graph', async t => {
  const f = await fixture(t, { dependencies: { optional: '^1.0.0' }, optionalDependencies: { optional: '^1.0.0' },
    peerDependencies: { optional: '^1.0.0' }, devDependencies: { development: '^1.0.0' } });
  assert.deepEqual(f.inspect(), { installed: [], unresolvedPeers: [] });
});

test('flat npm installations resolve installed regular, optional and peer packages within the root', async t => {
  const f = await fixture(t, { dependencies: { '@playcanvas/observer': '^1.5.1' },
    optionalDependencies: { optional: '*' }, peerDependencies: { react: '*' } });
  const expected = [];
  for (const name of ['@playcanvas/observer', 'optional', 'react']) {
    const manifest = await f.put(join(f.root, 'node_modules', name), { name, version: '1.0.0' });
    expected.push({ name, manifest: await realpath(manifest) });
  }
  assert.deepEqual(f.inspect(), { installed: expected, unresolvedPeers: [] });
});

test('a nested checkout never borrows an enclosing workspace package', async t => {
  const f = await fixture(t, { peerDependencies: { react: '*' } });
  await f.put(join(f.outer, 'node_modules/react'), { name: 'react', version: '19.0.0' });
  assert.equal(resolveNpmManifest('react', f.source, f.root), null);
  assert.equal(f.inspect().unresolvedPeers[0].claimed_as_bundled, false);
  await f.put(f.source, { ...f.pkg, dependencies: { react: '*' } });
  assert.throws(f.inspect, /Installed dependency react/);
});

test('pnpm package junctions resolve to their real manifests inside the repository', async t => {
  const f = await fixture(t, { dependencies: { react: '*' } });
  const installed = join(f.root, 'node_modules/.pnpm/react@19.0.0/node_modules/react');
  const manifest = await f.put(installed, { name: 'react', version: '19.0.0' });
  await mkdir(join(f.source, 'node_modules'), { recursive: true });
  await symlink(installed, join(f.source, 'node_modules/react'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(f.inspect().installed, [{ name: 'react', manifest: await realpath(manifest) }]);
});

test('external package junctions and similarly prefixed foreign roots are rejected', async t => {
  const f = await fixture(t, { peerDependencies: { react: '*' } });
  const external = join(f.outer, 'checkout-other/node_modules/react');
  await f.put(external, { name: 'react', version: '19.0.0' });
  await mkdir(join(f.root, 'node_modules'), { recursive: true });
  await symlink(external, join(f.root, 'node_modules/react'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.inspect, /resolves outside the repository/);
  assert.throws(() => resolveNpmManifest('react', external, f.root), /starts outside the repository/);
  assert.throws(() => npmDependencyEdges(join(external, 'package.json'), f.root), /manifest is outside the repository/);
  assert.throws(() => resolveNpmManifest('../react', f.source, f.root), /Unsafe npm dependency name/);
});

test('same-version pnpm peer contexts remain separate by physical manifest location', async t => {
  const f = await fixture(t);
  const manifests = [];
  for (const context of ['with-react', 'without-react']) {
    const directory = join(f.root, 'node_modules/.pnpm', context, 'node_modules/pcui');
    manifests.push(await f.put(directory, { name: 'pcui', version: '1.0.0', peerDependencies: { react: '*' } }));
    if (context === 'with-react') await f.put(join(dirname(directory), 'react'), { name: 'react', version: '19.0.0' });
  }
  assert.equal(npmDependencyEdges(manifests[0], f.root).installed.length, 1);
  assert.equal(npmDependencyEdges(manifests[1], f.root).unresolvedPeers.length, 1);
});

test('malformed package manifests cannot be converted into missing-peer records', async t => {
  const f = await fixture(t, { peerDependencies: { react: '*' } });
  const manifest = await f.put(join(f.root, 'node_modules/react'), { name: 'react', version: '19.0.0' });
  await writeFile(manifest, '{');
  assert.throws(() => npmDependencyEdges(resolveNpmManifest('react', f.source, f.root), f.root), SyntaxError);
  assert.equal((await readFile(f.manifest, 'utf8')).includes('peerDependencies'), true);
});

test('unresolved-peer report verification rejects missing inventory, dangling owners and false bundle claims', async t => {
  const f = await fixture(t, { peerDependencies: { react: '*' } });
  const records = f.inspect().unresolvedPeers;
  verifyUnresolvedNpmPeers(records, f.bom);
  assert.throws(() => verifyUnresolvedNpmPeers(undefined, f.bom), /Missing unresolved/);
  for (const change of [
    record => { record.component = 'pkg:npm/unknown@1.0.0'; },
    record => { record.peer = '../react'; },
    record => { record.requested_version = ''; },
    record => { record.optional = 'true'; },
    record => { record.installed_in_package_tree = true; },
    record => { record.claimed_as_bundled = true; },
    record => { record.reason = 'Assumed bundled'; },
  ]) {
    const changed = structuredClone(records); change(changed[0]);
    assert.throws(() => verifyUnresolvedNpmPeers(changed, f.bom));
  }
  assert.throws(() => verifyUnresolvedNpmPeers([...records, ...records], f.bom), /Duplicate unresolved/);
});
