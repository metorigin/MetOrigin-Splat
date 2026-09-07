import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const staging = resolve(root, process.argv[2] ?? 'target/distribution/windows-x64');
const stagingRelative = relative(resolve(root, 'target/distribution'), staging);
if (!stagingRelative || stagingRelative.startsWith('..') || isAbsolute(stagingRelative)) {
  throw new Error('Evidence output must be a child of target/distribution.');
}
const output = join(staging, 'licenses');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const slash = path => path.replaceAll('\\', '/');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const write = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const version = readJson(join(root, 'package.json')).version;
const revision = run('git', ['rev-parse', 'HEAD']);
const applicationRef = `pkg:generic/metorigin-splat@${version}`;
const components = new Map();
const dependencies = new Map([[applicationRef, new Set()]]);
const missing = [];
const licenseRecords = [];

function add(component) {
  components.set(component['bom-ref'], component);
  if (!dependencies.has(component['bom-ref'])) dependencies.set(component['bom-ref'], new Set());
  return component['bom-ref'];
}

function link(from, to) {
  if (from !== to) dependencies.get(from).add(to);
}

function collectLicenses(directory, packageRef, label) {
  const files = [];
  const visit = (folder, depth) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isFile() && /^(licen[sc]e|copying|copyright|notice|ofl)([._-]|$)/i.test(entry.name)) files.push(path);
      if (entry.isDirectory() && depth < 2 && /^(licenses?|legal)$/i.test(entry.name)) visit(path, depth + 1);
    }
  };
  visit(directory, 0);
  for (const source of files) {
    const suffix = slash(relative(directory, source));
    const destination = join(output, 'dependencies', label, suffix);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    licenseRecords.push({ component: packageRef, path: slash(relative(output, destination)), sha256: hash(destination) });
  }
  if (!files.length) missing.push({ component: packageRef, reason: 'No license/notice text found in installed package; manual review required.' });
}

// Cargo metadata is a conservative Windows source dependency graph, including build
// dependencies. It is not a claim that every crate is linked into the executable.
function collectCargo(manifest, rootName, parent) {
  const metadataArgs = ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', manifest];
  if (process.argv.includes('--offline')) metadataArgs.push('--offline');
  const metadata = JSON.parse(run('cargo', metadataArgs));
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const start = metadata.packages.find(pkg => pkg.name === rootName);
  if (!start) throw new Error(`Cargo root ${rootName} is missing.`);
  const visited = new Map();
  function visit(id) {
    if (visited.has(id)) return visited.get(id);
    const pkg = packages.get(id);
    const ref = `pkg:cargo/${pkg.name}@${pkg.version}`;
    visited.set(id, ref);
    if (!components.has(ref)) {
      add({ type: 'library', 'bom-ref': ref, name: pkg.name, version: pkg.version, purl: ref,
        ...(pkg.license ? { licenses: [{ license: { name: pkg.license } }] } : {}),
        properties: [{ name: 'metorigin:inventory-evidence', value: 'cargo-metadata-windows-source-graph-including-build-dependencies' }] });
      if (pkg.source) collectLicenses(dirname(pkg.manifest_path), ref, `cargo/${pkg.name}-${pkg.version}`);
    }
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) link(ref, visit(dep.pkg));
    }
    return ref;
  }
  link(parent, visit(start.id));
}

function resolveNpm(name, from) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(current) === current) return null;
  }
}

const npmVisited = new Set();
function collectNpm(manifest, parent) {
  const pkg = readJson(manifest);
  const ref = `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`;
  if (!components.has(ref)) {
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    add({ type: 'library', 'bom-ref': ref, name: pkg.name, version: pkg.version, purl: ref,
      ...(license ? { licenses: [{ license: { name: license } }] } : {}),
      properties: [{ name: 'metorigin:inventory-evidence', value: 'installed-production-dependency-graph-before-bundler-tree-shaking' }] });
    collectLicenses(dirname(manifest), ref, `npm/${pkg.name.replaceAll('/', '__')}-${pkg.version}`);
  }
  link(parent, ref);
  if (npmVisited.has(manifest)) return;
  npmVisited.add(manifest);
  const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  for (const name of names) {
    const child = resolveNpm(name, dirname(manifest));
    if (child) collectNpm(child, ref);
    else if (!pkg.optionalDependencies?.[name] && !pkg.peerDependenciesMeta?.[name]?.optional) {
      throw new Error(`Installed dependency ${name} of ${pkg.name} is missing.`);
    }
  }
}

collectCargo(join(root, 'Cargo.toml'), 'splat-desktop', applicationRef);
const desktop = readJson(join(root, 'apps/desktop/package.json'));
for (const name of Object.keys(desktop.dependencies)) {
  const manifest = resolveNpm(name, join(root, 'apps/desktop'));
  if (!manifest) throw new Error(`Desktop dependency ${name} is not installed.`);
  collectNpm(manifest, applicationRef);
}

const lock = readJson(join(root, 'packaging/windows-x64/engine-lock.json'));
for (const [id, component] of Object.entries(lock.components)) {
  const ref = add({ type: 'application', 'bom-ref': `engine:${id}`, name: id, version: component.version,
    hashes: [{ alg: 'SHA-256', content: component.sha256.toLowerCase() }],
    externalReferences: [{ type: 'distribution', url: component.source_url }],
    properties: [{ name: 'metorigin:hash-subject', value: component.archive_filename }, { name: 'metorigin:inventory-evidence', value: 'locked-upstream-binary-archive' }] });
  link(applicationRef, ref);
}

const companion = join(staging, 'engines/brush/brush_live.exe');
if (!existsSync(companion)) throw new Error('Build the current Brush companion before generating release evidence.');
const companionRef = add({ type: 'application', 'bom-ref': 'engine:brush-live', name: 'MetOrigin Brush live preview', version: '0.3.0+metorigin-live.1',
  hashes: [{ alg: 'SHA-256', content: hash(companion) }], licenses: [{ license: { id: 'Apache-2.0' } }] });
link(applicationRef, companionRef);
collectCargo(join(root, 'target/brush-live-source/brush-0.3.0/Cargo.toml'), 'brush-cli', companionRef);

const inventory = [];
function visitPayload(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) visitPayload(path);
    else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
      const relativePath = slash(relative(staging, path));
      const record = { path: relativePath, size_bytes: statSync(path).size, sha256: hash(path) };
      inventory.push(record);
      const ref = add({ type: 'file', 'bom-ref': `file:${relativePath}`, name: relativePath, hashes: [{ alg: 'SHA-256', content: record.sha256 }] });
      const owner = relativePath.startsWith('engines/colmap/') ? 'engine:colmap'
        : relativePath.startsWith('engines/ffmpeg/') ? 'engine:ffmpeg'
        : relativePath.startsWith('engines/brush/') ? 'engine:brush' : 'engine:vcredist';
      link(owner, ref);
    }
  }
}
visitPayload(join(staging, 'engines'));
visitPayload(join(staging, 'installer'));

const weights = join(root, 'target/brush-live-source/brush-0.3.0/crates/lpips/burn_mapped.bin');
if (!existsSync(weights)) throw new Error('Pinned Brush weight payload is missing.');
const weightRef = add({ type: 'file', 'bom-ref': 'weights:brush-v0.3.0-lpips-vgg', name: 'Brush v0.3.0 LPIPS/VGG burn_mapped.bin',
  hashes: [{ alg: 'SHA-256', content: hash(weights) }],
  properties: [{ name: 'metorigin:license-review', value: 'unresolved-weight-provenance; upstream code license is not independent weight evidence' }] });
link('engine:brush', weightRef);
link(companionRef, weightRef);

const report = {
  schema_version: 1, source_revision: revision, public_distribution_ready: false,
  signing: { mode: 'unsigned-alpha', public_github_release_requires_signature: false, warning: 'Windows may warn or block execution according to reputation and device policy.' },
  evidence: { native_payload_files: inventory.length, source_components: components.size, collected_license_texts: licenseRecords.length },
  blockers: [
    { id: 'ffmpeg-corresponding-source', detail: 'Archive the exact FFmpeg source plus corresponding static dependency sources, patches and build scripts. Binary download URLs are not source archives. GPLv3 section 6(d) is the intended online source-delivery route; a separate written offer is not automatically required for that route.' },
    { id: 'colmap-dependency-notices', detail: 'Map every bundled DLL and statically linked library to its exact upstream version and license; include license texts and applicable corresponding sources/relinking materials. COLMAP COPYING alone does not cover its dependencies.' },
    { id: 'brush-weight-provenance', detail: 'Document the exact LPIPS and VGG checkpoints, conversion procedure and redistribution terms corresponding to the recorded weight hash.' },
    { id: 'upstream-binary-sbom', detail: 'Resolve static/transitive components inside prebuilt FFmpeg, COLMAP and stock Brush. The source graphs and hashed payload list are a review inventory, not a complete binary SBOM.' },
    { id: 'runtime-and-installer-notices', detail: 'Review Microsoft VC Runtime/WebView2 redistribution terms, record the exact WebView2 payload used by the bundler, and retain NSIS/bundler notices.' },
    { id: 'compatibility-validation', detail: 'Run clean-machine installation, upgrade, uninstall and reconstruction checks against this exact candidate; historical runs are not current-candidate evidence.' },
    { id: 'security-review', detail: 'Review Tauri capabilities and production content security policy; current configuration has csp=null.' },
  ],
  packages_needing_license_text_review: missing,
  limitations: ['Source graphs conservatively include build dependencies and pre-tree-shaking frontend dependencies.', 'Native hashes identify staged payloads, not their license grants.', 'The final installer hash and signature result must be supplied by build metadata.'],
};
if (missing.length) report.blockers.push({ id: 'dependency-license-texts', detail: `${missing.length} source packages need manual license-text review; see packages_needing_license_text_review.` });
const bom = { bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: 'application', 'bom-ref': applicationRef, name: 'MetOrigin Splat', version },
    properties: [{ name: 'metorigin:source-revision', value: revision }, { name: 'metorigin:completeness', value: 'incomplete-see-release-readiness.json' }] },
  components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  dependencies: [...dependencies].map(([ref, deps]) => ({ ref, dependsOn: [...deps].sort() })),
  compositions: [{ aggregate: 'incomplete', assemblies: [applicationRef] }],
};
for (const [name, path] of [
  ['application-Cargo.lock', join(root, 'Cargo.lock')],
  ['application-pnpm-lock.yaml', join(root, 'pnpm-lock.yaml')],
  ['brush-live-Cargo.lock', join(root, 'target/brush-live-source/brush-0.3.0/Cargo.lock')],
  ['brush-cli-Cargo.toml', join(root, 'target/brush-live-source/brush-0.3.0/crates/brush-cli/Cargo.toml')],
]) write(join(output, 'build-inputs', name), readFileSync(path));
const knownRefs = new Set([applicationRef, ...components.keys()]);
for (const { ref, dependsOn } of bom.dependencies) {
  if (!knownRefs.has(ref) || dependsOn.some(dep => !knownRefs.has(dep))) throw new Error('Dangling SBOM dependency.');
}
write(join(output, 'SBOM.cdx.json'), JSON.stringify(bom, null, 2) + '\n');
write(join(output, 'release-readiness.json'), JSON.stringify(report, null, 2) + '\n');
write(join(output, 'native-payload-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
write(join(output, 'dependency-license-index.json'), JSON.stringify(licenseRecords, null, 2) + '\n');
write(join(output, 'DEPENDENCY-NOTICES.md'), `# Dependency evidence for MetOrigin Splat ${version}\n\nSource revision: ${revision}\n\nThis collection contains verbatim license/notice files from the locally resolved Windows Cargo graph (including build dependencies), the Brush companion graph, and installed production npm dependencies. Declared licenses are recorded without making a legal conclusion. Missing texts and unresolved binary/weight provenance are listed in release-readiness.json. SBOM.cdx.json explicitly declares incomplete composition. Do not describe this inventory as completed redistribution clearance.\n\n` + licenseRecords.map(item => `- ${item.component}: [${item.path}](${item.path})`).join('\n') + '\n');
console.log(`Release evidence: ${components.size} components, ${inventory.length} native files, ${licenseRecords.length} license texts, ${missing.length} license-text gaps.`);
