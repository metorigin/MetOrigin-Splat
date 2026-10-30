// Copied UI is not part of the npm graph. Both platform collectors use this
// offline verifier; provenance and current adapted bytes are separate identities.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
function confined(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\')) throw new Error('Invalid UI evidence path');
  const path = resolve(root, name);
  const inside = relative(realpathSync(root), realpathSync(path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !statSync(path).isFile()) throw new Error(`UI evidence path escapes source root: ${name}`);
  return path;
}

export function collectCopiedUiEvidence(root, output) {
  const desktop = resolve(root, 'apps/desktop');
  const manifestPath = confined(desktop, 'ui-sources.json');
  const manifestBytes = readFileSync(manifestPath);
  const sources = JSON.parse(manifestBytes);
  if (!Array.isArray(sources.components) || !sources.components.length) throw new Error('Copied UI sources are empty');
  const groups = sources.sourceGroups ?? [
    { id: 'shadcn', project: 'shadcn/ui', license: 'MIT', licenseFiles: ['src/components/ui/LICENSE'] },
  ];
  if (!Array.isArray(groups) || !groups.length) throw new Error('Copied UI license groups are empty');
  const copied = new Map();
  const copy = (source, name) => {
    const bytes = readFileSync(source);
    const record = { path: slash(name), sha256: sha(bytes), size_bytes: bytes.length };
    if (copied.has(name) && copied.get(name) !== record.sha256) throw new Error('Conflicting UI notice destination');
    copied.set(name, record.sha256);
    const destination = resolve(output, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return record;
  };
  const manifest = copy(manifestPath, 'ui/ui-sources.json');
  const ids = new Set();
  const covered = new Set();
  const components = groups.map(group => {
    if (!/^[a-z0-9-]+$/.test(group.id ?? '') || ids.has(group.id) || !['MIT', 'Apache-2.0'].includes(group.license) || !Array.isArray(group.licenseFiles) || !group.licenseFiles.length) throw new Error('Invalid copied UI license group');
    ids.add(group.id);
    const entries = sources.components.filter(entry => entry.project === group.project);
    if (!entries.length) throw new Error(`Copied UI group has no source: ${group.project}`);
    const notices = [...group.licenseFiles, ...(group.noticeFiles ?? [])].map((name, index) => {
      const source = confined(desktop, name);
      const text = readFileSync(source, 'utf8');
      const expected = group.fileSha256?.[name];
      if (!digest(expected) || sha(readFileSync(source)) !== expected) throw new Error(`UI license/notice hash mismatch: ${name}`);
      if (index < group.licenseFiles.length && !(group.license === 'MIT' ? /Permission is hereby granted/.test(text) : /Apache License/.test(text) && /Version 2\.0/.test(text) && /9\. Accepting Warranty/.test(text) && /END OF TERMS AND CONDITIONS/.test(text))) throw new Error(`Invalid ${group.license} text: ${name}`);
      return { ...copy(source, `ui/${group.id}/${index}-${name.split('/').at(-1)}`), kind: 'verbatim-notice-or-recorded-modifications' };
    });
    const files = entries.map(entry => {
      covered.add(entry);
      const upstreamSha256 = entry.upstreamSha256 ?? entry.sha256;
      if (!digest(upstreamSha256) || entry.license !== group.license || !Array.isArray(entry.localChanges) || !entry.localChanges.length) throw new Error(`Invalid copied UI source provenance: ${entry.localPath}`);
      const source = confined(desktop, entry.localPath);
      if (entry.repository) {
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.repository) || !/^[a-f0-9]{40}$/.test(entry.commit ?? '') || !entry.upstreamPath || !entry.upstreamLocalPath) throw new Error('Incomplete fixed upstream UI identity');
        const original = confined(root, entry.upstreamLocalPath);
        if (sha(readFileSync(original)) !== upstreamSha256) throw new Error(`Upstream UI hash mismatch: ${entry.upstreamPath}`);
      }
      return { path: entry.localPath, sha256: sha(readFileSync(source)), upstream_source_sha256: upstreamSha256,
        ...(entry.registry ? { registry: entry.registry } : {}),
        ...(entry.repository ? { repository: entry.repository, commit: entry.commit, upstream_path: entry.upstreamPath } : {}), local_changes: entry.localChanges };
    });
    for (const adapter of sources.projectAdapters ?? []) {
      if (!group.licenseFiles.includes(adapter.licenseFile)) continue;
      const file = confined(desktop, adapter.localPath);
      files.push({ path: adapter.localPath, sha256: sha(readFileSync(file)), local_changes: [adapter.note ?? 'Local adapter'] });
    }
    return { component: `ui-source:${group.id}:${manifest.sha256}`, project: group.project, declared_license: group.license, manifest, notices, files,
      scope: 'Locally adapted copied source; upstream hashes identify original inputs and local hashes identify this build. No unchanged-distribution claim.' };
  });
  if (covered.size !== sources.components.length) throw new Error('Copied UI source has no matching license group');
  const evidence = { schema_version: 2, manifest, components };
  mkdirSync(resolve(output, 'ui'), { recursive: true });
  writeFileSync(resolve(output, 'ui/source-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
