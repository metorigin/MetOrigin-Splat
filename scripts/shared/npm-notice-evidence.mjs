// Read-only, offline recovery of notices omitted from exact npm publications.
// Installed files remain untouched. Publication archives were inspected during
// evidence preparation; their original member hashes bind the installed bytes.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const blob = value => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const commit = value => /^[a-f0-9]{40}$/.test(value ?? '');
function validPath(name) {
  return typeof name === 'string' && name.length > 0 && !isAbsolute(name) && !name.includes('\\') && !/^[A-Za-z]:/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..');
}
function confined(root, name) {
  if (!validPath(name)) throw new Error('Invalid npm notice evidence path');
  const path = resolve(root, name);
  const inside = relative(realpathSync(root), realpathSync(path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !statSync(path).isFile()) throw new Error('npm notice evidence path escapes its root');
  return path;
}
function verifiedEvidence(root, record) {
  if (!digest(record?.sha256)) throw new Error('Missing npm notice evidence hash');
  const prefix = 'packaging/shared/licenses/';
  if (!record.path?.startsWith(prefix)) throw new Error('npm notice evidence must stay in the shared license collection');
  const path = confined(resolve(root, prefix), record.path.slice(prefix.length));
  const bytes = readFileSync(path);
  if (sha(bytes) !== record.sha256) throw new Error(`npm notice evidence hash mismatch: ${record.path}`);
  if (record.git_blob_sha1 && (!commit(record.git_blob_sha1) || blob(bytes) !== record.git_blob_sha1)) throw new Error('npm notice Git blob mismatch');
  return { path, bytes };
}
function lockedIntegrity(root, name, version) {
  const lines = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${name}@${version}:`);
  if (start < 0) throw new Error(`npm notice version is not locked: ${name}@${version}`);
  let end = start + 1;
  while (end < lines.length && !/^  \S/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n').match(/resolution:\s*\{[^}]*integrity:\s*['"]?([^'"},\s]+)/)?.[1];
}
const repository = value => (typeof value === 'string' ? value : value?.url)?.replace(/^git\+/, '').replace(/\.git$/, '');

/** Return exact original notice files for this installed package, or [] for a
 * version with no verified recovery. Corrupt or mismatched evidence fails shut. */
export function findVerifiedNpmNotices(root, packageDirectory) {
  const evidenceRoot = resolve(root, 'packaging/shared/licenses');
  const indexPath = confined(evidenceRoot, 'npm-notice-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (index.schema_version !== 1 || !Array.isArray(index.packages) || !Array.isArray(index.unresolved)) throw new Error('Invalid npm notice index');
  if (new Set(index.packages.map(entry => `${entry.name}@${entry.version}`)).size !== index.packages.length) throw new Error('Ambiguous npm notice index');
  const installed = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
  const entry = index.packages.find(item => item.name === installed.name && item.version === installed.version);
  if (!entry) {
    const unresolved = index.unresolved.find(item => item.name === installed.name && item.version === installed.version);
    if (unresolved) verifiedEvidence(root, { path: unresolved.evidence_path, sha256: unresolved.sha256 });
    return [];
  }
  if (!commit(entry.commit) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.repository ?? '')
    || !commit(entry.upstream_manifest?.git_blob_sha1) || !validPath(entry.upstream_manifest?.upstream_path)
    || !Array.isArray(entry.notices) || !entry.notices.length || !Array.isArray(entry.publication?.files) || !entry.publication.files.length) throw new Error('Incomplete fixed npm publication identity');
  const metadataEvidence = verifiedEvidence(root, entry.metadata);
  const metadata = JSON.parse(metadataEvidence.bytes);
  const publication = entry.publication;
  if (metadata.name !== entry.name || metadata.version !== entry.version || metadata.gitHead !== entry.commit
    || repository(metadata.repository) !== entry.repository || metadata.license !== entry.license || installed.license !== entry.license
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(publication.integrity ?? '') || !digest(publication.sha256) || !commit(publication.sha1)
    || metadata.dist?.integrity !== publication.integrity || metadata.dist?.shasum !== publication.sha1 || metadata.dist?.tarball !== publication.url
    || !publication.url?.startsWith(`https://registry.npmjs.org/${entry.name}/-/`) || lockedIntegrity(root, entry.name, entry.version) !== publication.integrity) throw new Error('npm notice publication identity or lock mismatch');
  const sourceManifest = verifiedEvidence(root, entry.upstream_manifest);
  const original = JSON.parse(sourceManifest.bytes);
  if (original.name !== entry.name || original.version !== entry.version || original.license !== entry.license || repository(original.repository) !== entry.repository) throw new Error('npm notice upstream manifest mismatch');
  const paths = new Set();
  let bytes = 0;
  for (const file of publication.files) {
    if (!validPath(file.path) || paths.has(file.path) || !digest(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid npm publication file inventory');
    paths.add(file.path);
    const installedFile = confined(packageDirectory, file.path);
    const data = readFileSync(installedFile);
    if (data.length !== file.bytes || sha(data) !== file.sha256) throw new Error(`Installed npm publication bytes differ: ${file.path}`);
    if (file.path === 'package.json' && file.sha256 !== entry.upstream_manifest.sha256) throw new Error('Published package.json differs from the fixed upstream commit');
    bytes += file.bytes;
  }
  if (!paths.has('package.json') || paths.size !== publication.file_count || paths.size !== metadata.dist.fileCount || bytes !== publication.unpacked_size || bytes !== metadata.dist.unpackedSize) throw new Error('Incomplete npm publication file inventory');
  return entry.notices.map(notice => {
    const verified = verifiedEvidence(root, notice);
    if (!validPath(notice.upstream_path) || !commit(notice.git_blob_sha1)
      || notice.url !== `${entry.repository}/blob/${entry.commit}/${notice.upstream_path}`) throw new Error('npm notice is not bound to the fixed publication commit');
    return {
      sourcePath: verified.path, noticePath: notice.upstream_path, sha256: notice.sha256,
      packageName: entry.name, packageVersion: entry.version, declaredLicense: entry.license,
      repository: entry.repository, commit: entry.commit, sourceUrl: notice.url,
      publishedTarballUrl: publication.url, publishedTarballIntegrity: publication.integrity, publishedTarballSha256: publication.sha256,
      metadataPath: metadataEvidence.path, metadataSha256: entry.metadata.sha256,
      upstreamManifestPath: sourceManifest.path, upstreamManifestSha256: entry.upstream_manifest.sha256,
      matchedPublicationFiles: paths.size, kind: 'original-notice-from-fixed-npm-publication-commit',
      scope: 'Original upstream notice omitted from the npm archive; exact installed publication bytes verified offline. No unchanged upstream source or full distribution-clearance claim.',
    };
  });
}
