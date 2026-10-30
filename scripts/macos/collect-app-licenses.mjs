#!/usr/bin/env node
// Offline application evidence only. Engine packs retain their independent audits.
import { createHash, randomUUID } from 'node:crypto';
import { collectCopiedUiEvidence } from '../shared/copied-ui-evidence.mjs';
import { findVerifiedNpmNotices } from '../shared/npm-notice-evidence.mjs';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayIdentity } from '../../integrations/supersplat/prepared-assets.mjs';
import { currentSupersplatEvidenceInputs, verifyCurrentVendoredIdentity } from '../shared/supersplat-evidence.mjs';
import { distributableSparkPatchReport, verifySparkPatch } from '../../integrations/spark/verify-patch.mjs';
import { distributableThreePatchReport, verifyThreePatch } from '../../integrations/three/verify-patch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, process.argv[2] ?? 'target/macos-m4/app-license-evidence/licenses');
const within = relative(join(root, 'target'), output);
if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Output must be a fresh child of target/.');
if (existsSync(output)) throw new Error('Evidence already exists; select a new output directory.');
const sparkPatch = await verifySparkPatch(root);
const threePatch = await verifyThreePatch(root);
const localDerivations = new Map([
  ['@sparkjsdev/spark', { report: sparkPatch, evidence: 'spark/installed-patch.json', description: 'Registered pnpm patch; Spark runtime modules and related declarations are locally derived, not original npm bytes.' }],
  ['three', { report: threePatch, evidence: 'three/installed-patch.json', description: 'Registered pnpm patch; OrbitControls event-root cleanup is locally derived, not original npm bytes.' }],
]);
const platform = 'aarch64-apple-darwin';
const slash = value => value.replaceAll('\\', '/');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 }).trim();
const cargo = process.env.CARGO ?? 'cargo';
const metadata = JSON.parse(run(cargo, ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', platform, '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml']));
const tree = run(cargo, ['tree', '--locked', '--offline', '--target', platform, '-p', 'splat-desktop', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}']);
const selectedCargo = new Set(tree.split('\n').map(line => line.match(/^(\S+) v(\S+)/)).filter(Boolean).map(match => `${match[1]}@${match[2]}`));
const version = readJson(join(root, 'package.json')).version;
const applicationRef = `pkg:generic/metorigin-splat@${version}`;
const components = new Map();
const dependencies = new Map([[applicationRef, new Set()]]);
const licenseRecords = [], missing = [], audit = [], unresolvedPeers = [], reusedNotices = [], pinnedNotices = [];
mkdirSync(output, { recursive: true });
const write = (name, data) => { const path = join(output, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const json = (name, data) => write(name, JSON.stringify(data, null, 2) + '\n');
function copy(source, name) {
  const destination = join(output, name);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination) && sha(source) !== sha(destination)) throw new Error(`Conflicting evidence: ${name}`);
  copyFileSync(source, destination);
  return { path: slash(name), sha256: sha(destination), size_bytes: statSync(destination).size };
}
function add(component) {
  const ref = component['bom-ref'];
  if (!components.has(ref)) components.set(ref, component);
  if (!dependencies.has(ref)) dependencies.set(ref, new Set());
  return ref;
}
function link(parent, ref) { if (parent !== ref) dependencies.get(parent).add(ref); }
function licenses(directory, ref, label, explicit = null) {
  const files = new Set();
  function visit(folder, depth) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isFile() && /^(licen[sc]e|copying|copyright|notice|ofl)([._-]|$)/i.test(entry.name) && !/\.(rs|c|h|cpp|cc|py|js|ts)$/i.test(entry.name)) files.add(path);
      if (entry.isDirectory() && depth < 2 && /^(licenses?|legal)$/i.test(entry.name)) visit(path, depth + 1);
    }
  }
  visit(directory, 0);
  if (explicit && existsSync(explicit) && statSync(explicit).isFile()) files.add(explicit);
  for (const file of [...files].sort()) {
    const suffix = relative(directory, file);
    const name = suffix.startsWith('..') || isAbsolute(suffix) ? `declared-license-${sha(file).slice(0, 12)}.txt` : slash(suffix);
    licenseRecords.push({ component: ref, ...copy(file, `dependencies/${label}/${name}`) });
  }
  return files.size;
}

// Reuse only manifest-bound original upstream text for the exact locked crate
// and immutable VCS revision. Ordinary source files such as copying.rs are not notices.
const packRoot = resolve(root, process.env.APP_LICENSE_ENGINE_PACK ?? 'target/distribution/macos-arm64/engines');
const packManifestPath = join(packRoot, 'engine-manifest.json');
const packManifest = existsSync(packManifestPath) ? readJson(packManifestPath) : null;
const packFiles = new Map(Object.values(packManifest?.engines ?? {}).flatMap(engine => engine.files).map(file => [file.path, file]));
function verifiedPackFile(name, digest) {
  const entry = packFiles.get(name);
  const file = resolve(packRoot, name);
  const inside = relative(packRoot, file);
  return entry && inside && !inside.startsWith('..') && !isAbsolute(inside) && entry.sha256 === digest && existsSync(file) && sha(file) === digest ? file : null;
}
const auditRecord = packFiles.get('brush/provenance/audit.json');
const oldAuditPath = auditRecord && verifiedPackFile(auditRecord.path, auditRecord.sha256);
const oldNotices = oldAuditPath ? readJson(oldAuditPath).components.flatMap(component => component.licenses ?? []) : [];
const checksums = new Map(readFileSync(join(root, 'Cargo.lock'), 'utf8').split('[[package]]').flatMap(section => {
  const fields = Object.fromEntries([...section.matchAll(/^(name|version|source|checksum) = ("[^"\n]*")$/gm)].map(match => [match[1], JSON.parse(match[2])]));
  return fields.checksum ? [[`${fields.name}@${fields.version}|${fields.source}`, fields.checksum]] : [];
}));
const noticeIndexPath = join(root, 'packaging/macos-arm64/licenses/app-upstream-notices.json');
const noticeIndex = readJson(noticeIndexPath);
const verifiedCargo = new Map();
function verifyCargoSource(pkg) {
  if (verifiedCargo.has(pkg.id)) return verifiedCargo.get(pkg.id);
  if (!pkg.source?.startsWith('registry+')) return null;
  const sourceDirectory = dirname(pkg.manifest_path);
  const registry = dirname(dirname(sourceDirectory));
  const archive = join(dirname(registry), 'cache', sourceDirectory.split('/').at(-2), `${pkg.name}-${pkg.version}.crate`);
  const checksum = checksums.get(`${pkg.name}@${pkg.version}|${pkg.source}`);
  if (!checksum || !existsSync(archive) || sha(archive) !== checksum) return null;
  const member = `${pkg.name}-${pkg.version}`;
  let vcs;
  try {
    vcs = JSON.parse(run('tar', ['-xOf', archive, `${member}/.cargo_vcs_info.json`]));
    const archivedManifest = execFileSync('tar', ['-xOf', archive, `${member}/Cargo.toml`]);
    if (createHash('sha256').update(archivedManifest).digest('hex') !== sha(pkg.manifest_path)) return null;
  } catch { return null; }
  if (!/^[0-9a-f]{40}$/.test(vcs.git?.sha1 ?? '')) return null;
  const repo = pkg.repository?.replace(/\.git$/, '').replace(/\/$/, '').replace(/^https:\/\/github\.com\//, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return null;
  const result = { sourceDirectory, archive, checksum, member, vcs, repo };
  verifiedCargo.set(pkg.id, result);
  return result;
}
// Some generated tables carry a data notice below src/, outside the ordinary
// top-level/legal directory scan. Read the original bytes from the locked crate.
function collectNestedCargoNotices(pkg, ref) {
  const paths = { 'regex-syntax@0.8.11': ['src/unicode_tables/LICENSE-UNICODE'] }[`${pkg.name}@${pkg.version}`];
  if (!paths) return;
  const source = verifyCargoSource(pkg);
  if (!source) throw new Error(`Unable to verify nested notice crate: ${ref}`);
  for (const name of paths) {
    const member = `${source.member}/${name}`;
    const bytes = execFileSync('tar', ['-xOf', source.archive, member]);
    const destination = `dependencies/cargo/${source.member}/${name}`;
    write(destination, bytes);
    licenseRecords.push({ component: ref, path: destination,
      sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
      kind: 'original-notice-from-checksum-bound-crate', source_member: member,
      crate_sha256: source.checksum, vcs_commit: source.vcs.git.sha1 });
  }
}
function recoverPinnedNotice(pkg, ref) {
  const pinned = noticeIndex.crates.find(entry => entry.name === pkg.name && entry.version === pkg.version);
  if (!pinned) return 0;
  const source = verifyCargoSource(pkg);
  if (!source || source.checksum !== pinned.crate_sha256 || source.repo !== pinned.repository || source.vcs.git.sha1 !== pinned.vcs_commit) throw new Error(`Pinned notice crate identity mismatch: ${ref}`);
  for (const name of pinned.notices) {
    const notice = noticeIndex.notices.find(entry => entry.local_path === name);
    const file = resolve(dirname(noticeIndexPath), name);
    const inside = relative(dirname(noticeIndexPath), file);
    if (!notice || !inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Invalid pinned notice: ${name}`);
    const bytes = readFileSync(file);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (sha(file) !== notice.sha256 || bytes.length !== notice.size_bytes || blob !== notice.git_blob_sha1) throw new Error(`Pinned notice byte identity mismatch: ${name}`);
    if (notice.kind !== 'standard-license-from-license-steward' && (notice.repository !== source.repo || notice.commit !== source.vcs.git.sha1)) throw new Error(`Pinned upstream revision mismatch: ${name}`);
    const record = { component: ref, ...copy(file, `dependencies/cargo/${pkg.name}-${pkg.version}/upstream-${file.split('/').at(-1)}`), url: notice.url,
      crate_sha256: source.checksum, vcs_commit: source.vcs.git.sha1, git_blob_sha1: notice.git_blob_sha1, kind: notice.kind ?? 'original-upstream-notice' };
    licenseRecords.push(record); pinnedNotices.push(record);
  }
  json(`dependencies/cargo/${pkg.name}-${pkg.version}/published-vcs.json`, source.vcs);
  if (pinned.source_notice_file) {
    const bytes = execFileSync('tar', ['-xOf', source.archive, `${source.member}/${pinned.source_notice_file}`]);
    if (createHash('sha256').update(bytes).digest('hex') !== pinned.source_notice_sha256) throw new Error(`Source notice mismatch: ${ref}`);
    write(`sources/${source.member}/${pinned.source_notice_file}`, bytes);
    copy(source.archive, `sources/${source.member}.crate`);
    json(`sources/${source.member}/evidence.json`, { component: ref, crate_sha256: source.checksum, source_notice_sha256: pinned.source_notice_sha256,
      kind: pinned.source_notice_kind, source_url: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`, vcs: source.vcs });
  }
  return pinned.notices.length;
}
function recoverCargoNotice(pkg, ref) {
  if (!oldAuditPath) return 0;
  const sourceIdentity = verifyCargoSource(pkg);
  if (!sourceIdentity) return 0;
  const { checksum, vcs, repo } = sourceIdentity;
  const prefix = `https://raw.githubusercontent.com/${repo}/${vcs.git.sha1}/`;
  const seen = new Set();
  for (const notice of oldNotices) {
    if (!notice.url?.startsWith(prefix) || /\.(rs|c|h|cpp|cc|py|js|ts)$/i.test(notice.path)) continue;
    const source = verifiedPackFile(`brush/${notice.path}`, notice.sha256);
    if (!source || seen.has(notice.sha256)) continue;
    seen.add(notice.sha256);
    const record = { component: ref, ...copy(source, `dependencies/cargo/${pkg.name}-${pkg.version}/upstream-${seen.size}-${notice.path.split('/').at(-1)}`),
      url: notice.url, crate_sha256: checksum, vcs_commit: vcs.git.sha1, upstream_engine_manifest_sha256: sha(packManifestPath), upstream_audit_sha256: auditRecord.sha256 };
    licenseRecords.push(record); reusedNotices.push(record);
  }
  if (seen.size) json(`dependencies/cargo/${pkg.name}-${pkg.version}/published-vcs.json`, vcs);
  return seen.size;
}

const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const cargoRefs = new Map();
function cargoVisit(id) {
  if (cargoRefs.has(id)) return cargoRefs.get(id);
  const pkg = packages.get(id);
  if (!selectedCargo.has(`${pkg.name}@${pkg.version}`)) return null;
  const ref = `pkg:cargo/${pkg.name}@${pkg.version}`;
  cargoRefs.set(id, ref);
  add({ type: 'library', 'bom-ref': ref, purl: ref, name: pkg.name, version: pkg.version,
    ...(pkg.license ? { licenses: [{ expression: pkg.license.replace(/\s*\/\s*/g, ' OR ') }] } : {}),
    properties: [{ name: 'metorigin:inventory-evidence', value: 'cargo-tree-normal-build-aarch64-apple-darwin-filtered-metadata' }] });
  const local = !pkg.source;
  if (!licenses(local ? root : dirname(pkg.manifest_path), ref, `cargo/${pkg.name}-${pkg.version}`, pkg.license_file) && !recoverPinnedNotice(pkg, ref) && !recoverCargoNotice(pkg, ref)) missing.push({ component: ref, reason: 'No verified original license/notice text found in the published source or matching immutable upstream evidence.' });
  collectNestedCargoNotices(pkg, ref);
  const item = { component: ref, source: pkg.source ?? 'workspace', declared_license: pkg.license, manifest_sha256: sha(pkg.manifest_path), features: nodes.get(id)?.features ?? [], dependencies: [] };
  audit.push(item);
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (!dep.dep_kinds.some(kind => kind.kind !== 'dev')) continue;
    const child = cargoVisit(dep.pkg);
    if (child) { link(ref, child); item.dependencies.push(child); }
  }
  return ref;
}
const app = metadata.packages.find(pkg => pkg.name === 'splat-desktop');
if (!app) throw new Error('Desktop Cargo root missing.');
link(applicationRef, cargoVisit(app.id));
const foundCargo = new Set([...cargoRefs.keys()].map(id => { const pkg = packages.get(id); return `${pkg.name}@${pkg.version}`; }));
for (const key of selectedCargo) if (!foundCargo.has(key)) throw new Error(`Selected Cargo package was not inventoried: ${key}`);

function resolveNpm(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(directory) === directory) return null;
  }
}
function recoverNpmNotices(directory, ref, label) {
  const notices = findVerifiedNpmNotices(root, directory);
  for (const notice of notices) {
    const { sourcePath, metadataPath, upstreamManifestPath, ...identity } = notice;
    const evidenceDirectory = `dependencies/${label}/fixed-publication`;
    const publicationEvidence = copy(metadataPath, `${evidenceDirectory}/registry-metadata.json`);
    const sourceManifest = copy(upstreamManifestPath, `${evidenceDirectory}/upstream-package.json`);
    const noticeIndex = copy(join(root, 'packaging/shared/licenses/npm-notice-index.json'), 'sources/npm-notice-index.json');
    const record = { ...identity, component: ref, ...copy(sourcePath, `${evidenceDirectory}/${notice.noticePath}`),
      publication_evidence: publicationEvidence, source_manifest: sourceManifest, notice_index: noticeIndex };
    licenseRecords.push(record);
    audit.push(record);
  }
  return notices.length;
}
const npmVisited = new Set();
function npmVisit(manifest, parent, evidence) {
  const pkg = readJson(manifest);
  const ref = `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`;
  const derivation = localDerivations.get(pkg.name);
  if (derivation && (pkg.version !== derivation.report.input_identity.package.version ||
      realpathSync(dirname(manifest)) !== derivation.report.installed_package_path)) {
    throw new Error(`A different, unverified ${pkg.name} installation entered the application dependency inventory.`);
  }
  if (!components.has(ref)) {
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    add({ type: 'library', 'bom-ref': ref, purl: ref, name: pkg.name, version: pkg.version,
      ...(license ? { licenses: [{ license: { name: license } }] } : {}),
      properties: [{ name: 'metorigin:inventory-evidence', value: evidence },
        ...(derivation ? [
          { name: 'metorigin:local-derivation', value: derivation.report.input_identity.id },
          { name: 'metorigin:patch-sha256', value: derivation.report.input_identity.patch.sha256 },
          { name: 'metorigin:patch-evidence', value: derivation.evidence },
          { name: 'metorigin:modified-distribution', value: derivation.description },
        ] : [])] });
    if (!licenses(dirname(manifest), ref, `npm/${pkg.name.replaceAll('/', '__')}-${pkg.version}`)
      && !recoverNpmNotices(dirname(manifest), ref, `npm/${pkg.name.replaceAll('/', '__')}-${pkg.version}`)) missing.push({component:ref,reason:'No verbatim license/notice file found in the installed package.'});
    audit.push({ component: ref, declared_license: license ?? null, package_json_sha256: sha(manifest), evidence,
      ...(derivation ? { local_derivation: derivation.report.input_identity.id, patch_evidence: derivation.evidence,
        modified_distribution_files: derivation.report.input_identity.files, original_npm_distribution_bytes_claimed: false } : {}) });
  }
  link(parent, ref);
  if (npmVisited.has(manifest)) return ref;
  npmVisited.add(manifest);
  const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  for (const name of names) {
    const child = resolveNpm(name, dirname(manifest));
    if (child) npmVisit(child, ref, 'installed-production-dependency-closure-before-tree-shaking');
    else if (pkg.peerDependencies?.[name]) unresolvedPeers.push({component:ref,peer:name,reason:'Declared peer is not installed in this package tree and is not claimed as bundled. SuperSplat source-map roots are inventoried separately.'});
    else if (!pkg.optionalDependencies?.[name]) missing.push({ component: ref, reason: `Required installed dependency ${name} was not found.` });
  }
  return ref;
}
const desktop = join(root, 'apps/desktop');
for (const name of Object.keys(readJson(join(desktop, 'package.json')).dependencies)) {
  const manifest = resolveNpm(name, desktop);
  if (!manifest) throw new Error(`Desktop runtime dependency missing: ${name}`);
  npmVisit(manifest, applicationRef, 'installed-desktop-production-root-before-tree-shaking');
}

// Copied UI source is outside the npm dependency closure. Preserve its exact
// notices and provenance separately, including hashes of the local adaptations.
const uiCollection = collectCopiedUiEvidence(root, output);
for (const record of uiCollection.components) {
  const ref = add({ type: 'library', 'bom-ref': record.component, name: `${record.project} copied UI sources`,
    licenses: [{ license: { id: record.declared_license } }],
    properties: [{ name: 'metorigin:inventory-evidence', value: 'ui/source-evidence.json' },
      { name: 'metorigin:distribution-kind', value: 'locally-adapted-copied-source' }] });
  link(applicationRef, ref);
  licenseRecords.push(...record.notices.map(notice => ({ component: ref, ...notice })));
  audit.push(record);
}

const { source: supersplatSource, publicRoot: supersplatPublic, upstream: pinned, overlayRoot,
  overlay, webpEvidence, bundledPackages, splatRef, sourceMapEvidence } = await currentSupersplatEvidenceInputs(root);
const superRef = npmVisit(join(supersplatSource, 'package.json'), applicationRef, 'pinned-supersplat-source-and-built-source-map');
for (const name of bundledPackages) npmVisit(join(supersplatSource, name, 'package.json'), superRef, 'package-observed-in-built-supersplat-source-map');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'build.json']) copy(join(supersplatPublic, name), `supersplat/${name}`);
const staticPayload = [];
function payload(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) payload(path);
    else if (entry.isFile()) staticPayload.push({ path: slash(relative(supersplatPublic, path)), sha256: sha(path), size_bytes: statSync(path).size });
  }
}
payload(join(supersplatPublic, 'static'));
json('supersplat/static-payload-inventory.json', staticPayload);
// Bind the repository-authored images and translations to its pinned MIT tree.
// The separately audited WebP payload is not covered by this assertion.
const upstreamLicense = execFileSync('git', ['-C', supersplatSource, 'show', `${pinned.commit}:LICENSE`]);
if (!upstreamLicense.equals(readFileSync(join(supersplatPublic, 'LICENSE')))
  || readJson(join(supersplatSource, 'package.json')).license !== 'MIT') throw new Error('Pinned SuperSplat MIT notice mismatch.');
const repositoryAssets = staticPayload.filter(file => /^static\/(icons|images|locales)\//.test(file.path));
const assetOrigins = repositoryAssets.map(file => {
  const bytes = execFileSync('git', ['-C', supersplatSource, 'show', `${pinned.commit}:${file.path}`], { maxBuffer: 16 * 1024 * 1024 });
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Pinned static asset mismatch: ${file.path}`);
  return { ...file, git_blob_sha1: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
});
json('supersplat/static-origin-evidence.json', { upstream: pinned, license: 'MIT',
  license_sha256: createHash('sha256').update(upstreamLicense).digest('hex'), assets: assetOrigins,
  scope: 'Original repository copyright notice retained; this does not claim trademark rights or upstream endorsement.' });
json('supersplat/source-map-package-evidence.json', sourceMapEvidence);

// Native C sources and non-JavaScript payloads do not appear as independent
// packages in Cargo or a JavaScript source map. Keep their evidence explicit.
const sqlite = metadata.packages.find(pkg => pkg.name === 'libsqlite3-sys' && cargoRefs.has(pkg.id));
if (!sqlite || !nodes.get(sqlite.id)?.features.includes('bundled')) throw new Error('Expected bundled SQLite dependency missing.');
const sqliteSource = verifyCargoSource(sqlite);
if (!sqliteSource) throw new Error('Unable to verify bundled SQLite crate source.');
const sqliteBytes = execFileSync('tar', ['-xOf', sqliteSource.archive, `${sqliteSource.member}/sqlite3/sqlite3.c`], { maxBuffer: 32 * 1024 * 1024 });
const sqliteText = sqliteBytes.toString('utf8');
const sqliteVersion = sqliteText.match(/^#define SQLITE_VERSION\s+"([^"]+)"/m)?.[1];
const sqliteSourceId = sqliteText.match(/^#define SQLITE_SOURCE_ID\s+"([^"]+)"/m)?.[1];
const sqliteNotice = sqliteText.match(/\/\*\n\*\* 2001 September 15[\s\S]*?\*\//)?.[0];
if (!sqliteVersion || !sqliteSourceId || !sqliteNotice) throw new Error('SQLite source identity or original public-domain notice missing.');
const sqliteRef = add({ type: 'library', 'bom-ref': `pkg:generic/sqlite@${sqliteVersion}`, purl: `pkg:generic/sqlite@${sqliteVersion}`, name: 'SQLite bundled amalgamation', version: sqliteVersion,
  licenses: [{ license: { name: 'Public domain — original source disclaimer retained' } }], properties: [{ name: 'metorigin:source-id', value: sqliteSourceId }] });
link(cargoRefs.get(sqlite.id), sqliteRef);
write('vendored/sqlite/SOURCE-NOTICE.txt', sqliteNotice + '\n');
licenseRecords.push({ component: sqliteRef, path: 'vendored/sqlite/SOURCE-NOTICE.txt', sha256: sha(join(output, 'vendored/sqlite/SOURCE-NOTICE.txt')), size_bytes: statSync(join(output, 'vendored/sqlite/SOURCE-NOTICE.txt')).size, kind: 'verbatim-source-comment' });
copy(sqliteSource.archive, `sources/${sqliteSource.member}.crate`);
json('vendored/sqlite/evidence.json', { component: sqliteRef, parent: cargoRefs.get(sqlite.id), version: sqliteVersion, source_id: sqliteSourceId,
  crate_sha256: sqliteSource.checksum, source_sha256: createHash('sha256').update(sqliteBytes).digest('hex'), vcs: sqliteSource.vcs,
  source_member: `${sqliteSource.member}/sqlite3/sqlite3.c`, declared_build_features: nodes.get(sqlite.id).features,
  scope: 'Bundled source selected by Cargo features. SQLCipher and wasm32-wasi-vfs are not claimed as macOS runtime components. Final binary binding is verified separately.' });

const vendoredIndexPath = join(root, 'packaging/macos-arm64/licenses/app-vendored-evidence.json');
const vendoredIndex = readJson(vendoredIndexPath);
verifyCurrentVendoredIdentity(vendoredIndex);
const vendoredRecords = [];
for (const file of vendoredIndex.files) {
  if (vendoredRecords.some(record => record.key === file.key)
    || !/^[0-9a-f]{40}$/.test(file.commit)
    || file.url !== `https://raw.githubusercontent.com/${file.repository}/${file.commit}/${file.path}`) throw new Error(`Invalid vendored source identity: ${file.key}`);
  const source = resolve(dirname(vendoredIndexPath), file.local_path);
  const inside = relative(dirname(vendoredIndexPath), source);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Invalid vendored evidence path.');
  const bytes = readFileSync(source);
  if (sha(source) !== file.sha256 || bytes.length !== file.size_bytes || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.git_blob_sha1) throw new Error(`Vendored evidence mismatch: ${file.local_path}`);
  vendoredRecords.push({ ...file, ...copy(source, `vendored/upstream/${file.local_path.replace(/^app-originals\//, '')}`) });
}

// The official 2017 CLDR-distributed Unicode license explicitly covers /Public/
// data. Bind it to the selected crate's own data version and the pinned UCD
// ReadMe; this is not a claim to have recovered the 2017 Unicode website.
const unicode = vendoredIndex.unicode;
const unicodePackage = metadata.packages.find(pkg => `${pkg.name}@${pkg.version}` === unicode.crate && cargoRefs.has(pkg.id));
if (!unicodePackage) throw new Error('Expected Unicode data dependency missing.');
const unicodeSource = verifyCargoSource(unicodePackage);
if (!unicodeSource || unicodeSource.repo !== 'open-i18n/rust-unic'
  || unicodeSource.checksum !== unicode.crate_sha256 || unicodeSource.vcs.git.sha1 !== unicode.crate_commit) throw new Error('Unicode data crate identity mismatch.');
if (unicode.crate_version_member !== 'tables/unicode_version.rsv') throw new Error('Unexpected Unicode version source member.');
const unicodeVersionBytes = execFileSync('tar', ['-xOf', unicodeSource.archive, `${unicodeSource.member}/${unicode.crate_version_member}`]);
const unicodeVersionSha = createHash('sha256').update(unicodeVersionBytes).digest('hex');
const unicodeVersion = unicodeVersionBytes.toString('utf8').match(/UnicodeVersion\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+),\s*micro:\s*(\d+)\s*\}/)?.slice(1).join('.');
if (unicodeVersionSha !== unicode.crate_version_member_sha256 || unicodeVersion !== unicode.version) throw new Error('Unicode data version mismatch.');
const unicodeReadme = vendoredRecords.find(file => file.key === unicode.readme_key);
const unicodeLicense = vendoredRecords.find(file => file.key === unicode.license_key);
if (!unicodeReadme || unicodeReadme.repository !== 'open-i18n/data-unicode-ucd' || unicodeReadme.commit !== unicode.gitlink_commit
  || !unicodeLicense || unicodeLicense.repository !== 'unicode-org/cldr' || unicodeLicense.kind !== 'official-historical-unicode-data-license'
  || unicode.license_scope !== 'unicode-public-data-excluding-pdf-code-charts') throw new Error('Unicode data notice source or scope mismatch.');
const unicodeReadmeText = readFileSync(join(output, unicodeReadme.path), 'utf8');
const unicodeLicenseText = readFileSync(join(output, unicodeLicense.path), 'utf8').replace(/\s+/g, ' ');
if (!unicodeReadmeText.includes(`for Version ${unicode.version} of the Unicode Standard.`)
  || !unicodeReadmeText.includes('http://www.unicode.org/terms_of_use.html')
  || !unicodeReadmeText.includes('© 2017 Unicode®, Inc.')
  || !unicodeLicenseText.includes('Unicode Data Files include all data files under the directories http://www.unicode.org/Public/')
  || !unicodeLicenseText.includes('Unicode Data Files do not include PDF online code charts under the directory http://www.unicode.org/Public/.')
  || !unicodeLicenseText.includes('Copyright © 1991-2017 Unicode, Inc. All rights reserved.')
  || !unicodeLicenseText.includes('Permission is hereby granted, free of charge, to any person obtaining a copy of the Unicode data files')
  || !unicodeLicenseText.includes('(b) this copyright and permission notice appear in associated Documentation.')) throw new Error('Unicode data license applicability mismatch.');
const unicodeRef = add({ type: 'data', 'bom-ref': `pkg:generic/unicode-ucd@${unicode.version}`, name: 'Unicode Character Database', version: unicode.version,
  licenses: [{ license: { name: 'Unicode, Inc. License Agreement — Data Files and Software (1991–2017)' } }] });
link(cargoRefs.get(unicodePackage.id), unicodeRef);
licenseRecords.push({ component: unicodeRef, path: unicodeLicense.path, sha256: unicodeLicense.sha256, size_bytes: unicodeLicense.size_bytes,
  url: unicodeLicense.url, git_blob_sha1: unicodeLicense.git_blob_sha1, kind: unicodeLicense.kind });
const unicodeVersionPath = `sources/${unicodeSource.member}/${unicode.crate_version_member}`;
write(unicodeVersionPath, unicodeVersionBytes);
copy(unicodeSource.archive, `sources/${unicodeSource.member}.crate`);
json('vendored/unicode/evidence.json', { component: unicodeRef, parent: cargoRefs.get(unicodePackage.id), version: unicode.version,
  verification_status: 'verified', crate_sha256: unicodeSource.checksum, vcs: unicodeSource.vcs,
  version_source: { path: unicodeVersionPath, sha256: unicodeVersionSha, source_member: `${unicodeSource.member}/${unicode.crate_version_member}` },
  upstream_gitlink: unicode.upstream_gitlink, gitlink_commit: unicode.gitlink_commit,
  data_readme: unicodeReadme, data_license: unicodeLicense, scope: unicode.license_scope, finding: unicode.finding });

const webpFile = join(supersplatPublic, 'static/lib/webp/webp.wasm');
const webpRef = add({ type: 'library', 'bom-ref': `webp-wasm:sha256:${sha(webpFile)}`, name: 'SuperSplat derived WebP WASM', hashes: [{ alg: 'SHA-256', content: sha(webpFile) }],
  properties: [{ name: 'metorigin:build-evidence', value: 'vendored/webp/build-evidence.json' },
    { name: 'metorigin:provenance-status', value: 'Fixed-source replacement; original prebuilt provenance remains unresolved.' }] });
link(superRef, webpRef);
const splatComponent = components.get(splatRef);
if (!splatComponent) throw new Error('Derived splat-transform is absent from source inventory.');
splatComponent.properties.push({ name: 'metorigin:distribution-kind', value: 'derived-fixed-webp-overlay' },
  { name: 'metorigin:webp-overlay-id', value: overlay.manifest.id },
  { name: 'metorigin:webp-overlay-manifest-sha256', value: overlay.digest });
audit.push({ component: splatRef, evidence: 'vendored/webp/evidence.json', distribution_kind: 'derived-fixed-webp-overlay',
  base_package_json_sha256: overlay.manifest.base.package_json_sha256,
  overlay: overlayIdentity(overlay), scope: 'Package identity is the pinned base; ten exact replacement paths include rebuilt codec and resource-cleanup changes. Not the original npm package bytes.' });
link(splatRef, webpRef);
const webpComponents = { 'splat-transform': splatRef };
for (const [name, version, license] of [
  ['libwebp', '1.6.0', 'BSD-3-Clause; original patent grant retained'],
  ['sharpyuv', '0.4.2', 'BSD-3-Clause; same libwebp source tree and patent grant'],
  ['emscripten-runtime', '4.0.21', 'MIT and original third-party notices in Emscripten LICENSE'],
  ['musl', 'emscripten-d6f4231', 'MIT and individual original source notices'],
  ['dlmalloc', 'emscripten-d6f4231', 'Public domain/CC0; original source statement retained'],
  ['compiler-rt', 'emscripten-d6f4231', 'Apache-2.0 WITH LLVM-exception'],
]) {
  const ref = `pkg:generic/${name}@${version}`;
  webpComponents[name] = add({ type: 'library', 'bom-ref': ref, name, version,
    licenses: [{ license: { name: license } }],
    properties: [{ name: 'metorigin:runtime-evidence', value: 'vendored/webp/evidence.json' }] });
  link(webpRef, ref);
}
const copiedEvidence = webpEvidence.files.map(file => copy(join(overlayRoot, file.path), `vendored/webp/${file.path}`));
copy(join(overlayRoot, 'manifest.json'), 'vendored/webp/manifest.json');
copy(join(overlayRoot, 'build-evidence.json'), 'vendored/webp/build-evidence.json');
const webpNotices = webpEvidence.notices.map(({ bytes, component, ...notice }) => ({ ...notice,
  path: `vendored/webp/${notice.path}`, component: webpComponents[component], runtime_component: component }));
for (const notice of webpNotices) {
  licenseRecords.push({ ...notice, kind: 'verbatim-fixed-source-runtime-notice' });
  if (notice.runtime_component === 'libwebp') licenseRecords.push({ ...notice,
    component: webpComponents.sharpyuv, runtime_component: 'sharpyuv', kind: 'verbatim-shared-libwebp-tree-notice' });
}
json('vendored/webp/evidence.json', { schema_version: 1, status: 'verified-derived-replacement',
  overlay: overlayIdentity(overlay), base: overlay.manifest.base, files: copiedEvidence, notices: webpNotices,
  runtime: { linked_members: webpEvidence.linked_members, sources: webpEvidence.sources },
  historical_prebuilt: { wasm_sha256: vendoredIndex.webp.wasm_sha256, status: 'provenance-unresolved' },
  scope: webpEvidence.scope });
// Preserve the old audit verbatim as history; it does not describe the replacement.
json('vendored/evidence.json', { ...vendoredIndex, files: vendoredRecords });
copy(vendoredIndexPath, 'build-inputs/app-vendored-evidence.json');

for (const [name, path] of [
  ['Cargo.lock', 'Cargo.lock'], ['Cargo.toml', 'Cargo.toml'], ['desktop-Cargo.toml', 'apps/desktop/src-tauri/Cargo.toml'],
  ['pnpm-lock.yaml', 'pnpm-lock.yaml'], ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
  ['desktop-package.json', 'apps/desktop/package.json'],
  ['supersplat-package-lock.json', 'target/supersplat-source/upstream/package-lock.json'],
  ['supersplat-upstream.json', 'integrations/supersplat/upstream.json'],
]) copy(join(root, path), `build-inputs/${name}`);
copy(join(root, 'integrations/spark/patch-manifest.json'), 'spark/patch-manifest.json');
copy(join(root, sparkPatch.input_identity.patch.path), 'spark/patch.patch');
json('spark/installed-patch.json', distributableSparkPatchReport(sparkPatch));
copy(join(root, 'integrations/three/patch-manifest.json'), 'three/patch-manifest.json');
copy(join(root, threePatch.input_identity.patch.path), 'three/patch.patch');
json('three/installed-patch.json', distributableThreePatchReport(threePatch));
// Detect a changed patch, installation or registration during collection, and
// verify that the newly copied notices bind the exact derivation we inspected.
await verifySparkPatch(root, { licenseRoot: output });
write('build-inputs/cargo-normal-build-tree.txt', tree.replaceAll(root, '$WORKSPACE') + '\n');
json('component-evidence.json', audit);
json('dependency-license-index.json', licenseRecords);
json('reused-upstream-notices.json', reusedNotices);
json('pinned-upstream-notices.json', pinnedNotices);
copy(noticeIndexPath, 'build-inputs/app-upstream-notices.json');
const revision = run('git', ['rev-parse', 'HEAD']);
const dirty = !!run('git', ['status', '--porcelain']);
const issues = [];
if (missing.length) issues.push({ id: 'missing-license-texts', detail: `${missing.length} components/dependency resolutions require manual review; see packages_needing_license_text_review.` });
const report = { schema_version: 1, platform: 'macos-arm64', release_ready: issues.length === 0, issues,
  resolved_findings: [{ id: 'unicode-data-license', evidence: 'vendored/unicode/evidence.json', detail: unicode.finding },
    { id: 'supersplat-webp-provenance', evidence: 'vendored/webp/evidence.json', resolution: 'replaced-with-fixed-source-build',
      detail: 'The shipped prebuilt codec was replaced by the recorded fixed-source libwebp 1.6.0 / sharpyuv 0.4.2 / Emscripten 4.0.21 build and its runtime notices. Original prebuilt compiler/library provenance remains unresolved.' }],
  source_revision: revision, working_tree_dirty: dirty,
  counts: { cargo_components: cargoRefs.size, npm_components: [...components.keys()].filter(k => k.startsWith('pkg:npm/')).length, license_texts: licenseRecords.length },
  packages_needing_license_text_review: missing, unresolved_peer_dependencies: unresolvedPeers,
  limitations: ['Cargo includes normal/build source dependencies for aarch64-apple-darwin and default desktop features; it does not claim every source crate is linked.', 'npm includes installed production dependencies before bundler tree shaking; SuperSplat runtime roots are additionally identified from its built source map.', 'This is a source dependency inventory, not a symbol-level binary SBOM. Tools and SDKs that are not redistributed are outside its scope; identified unresolved bundled components are named in issues. Engine pack evidence is separate.', 'SuperSplat images and translations match the pinned MIT repository tree; its original notice is retained. This is copyright-license provenance, not a trademark grant or endorsement claim.', 'Fontsource Inter and JetBrains Mono package original OFL texts are included through the production npm inventory.', 'Copied shadcn/ui MIT and Jan Apache-2.0 sources have separate notices, modification records and provenance in ui/; it is locally adapted source, not an npm package or unchanged upstream distribution.', 'Verbatim texts and declared licenses are evidence, not a completed redistribution clearance. No copyright statement is invented.', 'The app binary, signing, notarization and final bundle resource hashes must be bound by the independent app verification.'] };
json('release-readiness.json', report);
const bom = { bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: 'application', 'bom-ref': applicationRef, name: 'MetOrigin Splat', version }, properties: [{ name: 'metorigin:platform', value: platform }, { name: 'metorigin:source-revision', value: revision }, { name: 'metorigin:completeness', value: 'incomplete-see-release-readiness.json' }] },
  components: [...components.values()].sort((a,b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  dependencies: [...dependencies].map(([ref,deps]) => ({ ref, dependsOn: [...deps].sort() })),
  compositions: [{ aggregate: 'incomplete', assemblies: [applicationRef] }] };
const refs = new Set([applicationRef, ...components.keys()]);
for (const dep of bom.dependencies) if (!refs.has(dep.ref) || dep.dependsOn.some(ref => !refs.has(ref))) throw new Error('Dangling SBOM dependency.');
json('SBOM.cdx.json', bom);
// The Three derivation also binds its inventory/SBOM marker and original notice.
await verifyThreePatch(root, { licenseRoot: output });
write('DEPENDENCY-NOTICES.md', `# MetOrigin Splat macOS application dependency evidence\n\nTarget: ${platform}. Source revision: ${revision}; working tree dirty: ${dirty}.\n\nOriginal notices are copied verbatim from resolved Cargo and installed npm packages, the pinned SuperSplat payload, the production font packages, and copied shadcn/ui and Jan sources. See release-readiness.json for incomplete source/binary/static-asset scope. Engine pack evidence is separate. This inventory does not assert distribution clearance.\n\n` + licenseRecords.map(item => `- ${item.component}: [${item.path}](${item.path})`).join('\n') + '\n');
const files=[];
function inventory(folder) {
  for (const entry of readdirSync(folder, {withFileTypes:true})) {
    const path=join(folder,entry.name);
    if (entry.isDirectory()) inventory(path);
    else if (entry.isFile()) files.push({path:slash(relative(output,path)),size_bytes:statSync(path).size,sha256:sha(path)});
    else throw new Error(`Unexpected non-regular evidence entry: ${path}`);
  }
}
inventory(output);
json('manifest.json', {schema_version:1,platform:'macos-arm64',files:files.sort((a,b)=>a.path.localeCompare(b.path))});
console.log(JSON.stringify({output,...report.counts,missing:missing.length,files:files.length,release_ready:report.release_ready}));
