import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const inside = (root, value) => {
  const suffix = relative(root, value);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const packageName = name => typeof name === 'string' && /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name)
  && name.split('/').every(part => part !== '.' && part !== '..');
export const unresolvedPeerReason = 'Declared peer is not installed in this package tree and is not claimed as bundled for this relationship. Actual SuperSplat source-map roots are inventoried separately.';

export function resolveNpmManifest(name, from, repositoryRoot) {
  assert(packageName(name), `Unsafe npm dependency name: ${name}`);
  const root = realpathSync(repositoryRoot);
  const start = realpathSync(from);
  assert(inside(root, start), 'Npm dependency search starts outside the repository.');
  // Keep an isolated checkout from borrowing an enclosing workspace's packages.
  for (let current = start; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name, 'package.json');
    let info;
    try { info = statSync(candidate); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (info) {
      assert(info.isFile(), `Npm package manifest is not a file: ${name}`);
      const manifest = realpathSync(candidate);
      assert(inside(root, manifest), `Npm dependency ${name} resolves outside the repository.`);
      return manifest;
    }
    if (current === root || relative(root, current) === '') return null;
  }
}

export function npmDependencyEdges(manifest, repositoryRoot) {
  manifest = realpathSync(manifest);
  assert(inside(realpathSync(repositoryRoot), manifest), 'Npm package manifest is outside the repository.');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
  const component = `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`;
  const installed = [], unresolvedPeers = [];
  const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  for (const name of names) {
    const child = resolveNpmManifest(name, dirname(manifest), repositoryRoot);
    if (child) installed.push({ name, manifest: child });
    // npm optionalDependencies override dependencies of the same name. Peer
    // metadata must never make an otherwise required dependency optional.
    else if (Object.hasOwn(pkg.optionalDependencies ?? {}, name)) continue;
    else if (Object.hasOwn(pkg.dependencies ?? {}, name)) throw new Error(`Installed dependency ${name} of ${pkg.name} is missing.`);
    else {
      assert(typeof pkg.peerDependencies[name] === 'string' && pkg.peerDependencies[name].trim(), `Invalid peer dependency range: ${name}`);
      unresolvedPeers.push({ component, peer: name, requested_version: pkg.peerDependencies[name],
        optional: pkg.peerDependenciesMeta?.[name]?.optional === true,
        installed_in_package_tree: false, claimed_as_bundled: false, reason: unresolvedPeerReason });
    }
  }
  return { installed, unresolvedPeers };
}

export function verifyUnresolvedNpmPeers(records, bom) {
  assert(Array.isArray(records), 'Missing unresolved npm peer inventory.');
  const components = new Map(bom.components.map(item => [item['bom-ref'], item]));
  const seen = new Set();
  for (const record of records) {
    const component = components.get(record.component);
    assert(component && record.component === `pkg:npm/${component.name.replace('@', '%40')}@${component.version}`, 'Unknown unresolved npm peer owner.');
    assert(packageName(record.peer), 'Invalid unresolved npm peer name.');
    assert(typeof record.requested_version === 'string' && record.requested_version.trim(), 'Missing unresolved npm peer range.');
    assert.equal(typeof record.optional, 'boolean', 'Missing unresolved npm peer optional flag.');
    assert.equal(record.installed_in_package_tree, false, 'Unresolved npm peer is marked installed.');
    assert.equal(record.claimed_as_bundled, false, 'Unresolved npm peer is claimed as bundled.');
    assert.equal(record.reason, unresolvedPeerReason, 'Missing unresolved npm peer scope.');
    const key = `${record.component}\0${record.peer}\0${record.requested_version}\0${record.optional}`;
    assert(!seen.has(key), 'Duplicate unresolved npm peer record.');
    seen.add(key);
  }
}
