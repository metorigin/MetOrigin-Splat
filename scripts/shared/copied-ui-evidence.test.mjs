import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectCopiedUiEvidence } from './copied-ui-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'copied-ui-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = join(root, 'apps/desktop');
  mkdirSync(desktop, { recursive: true });
  const license = readFileSync(new URL('../../apps/desktop/src/components/ui/licenses/Apache-2.0.txt', import.meta.url));
  writeFileSync(join(desktop, 'LICENSE'), license);
  writeFileSync(join(desktop, 'MODIFICATIONS'), 'Adapted for MetOrigin');
  writeFileSync(join(desktop, 'button.tsx'), 'adapted source');
  writeFileSync(join(root, 'original.tsx'), 'upstream source');
  const manifest = { schemaVersion: 2, sourceGroups: [{ id: 'jan', project: 'Jan', license: 'Apache-2.0', licenseFiles: ['LICENSE'], noticeFiles: ['MODIFICATIONS'], fileSha256: { LICENSE: createHash('sha256').update(license).digest('hex'), MODIFICATIONS: createHash('sha256').update('Adapted for MetOrigin').digest('hex') } }], components: [{ project: 'Jan', license: 'Apache-2.0', repository: 'https://github.com/janhq/jan', commit: 'b8d58255baf6d9e870025d3f0c60a5b80a63143b', upstreamPath: 'web-app/src/components/ui/button.tsx', upstreamLocalPath: 'original.tsx', upstreamSha256: createHash('sha256').update('upstream source').digest('hex'), localPath: 'button.tsx', localChanges: ['Preserve local button contract'] }] };
  const save = () => writeFileSync(join(desktop, 'ui-sources.json'), JSON.stringify(manifest));
  save();
  return { root, desktop, manifest, save };
}

test('both platforms collect identical original notices and distinguish adapted bytes', t => {
  const f = fixture(t);
  const mac = collectCopiedUiEvidence(f.root, join(f.root, 'mac'));
  const windows = collectCopiedUiEvidence(f.root, join(f.root, 'windows'));
  assert.deepEqual(mac, windows);
  const file = mac.components[0].files[0];
  assert.notEqual(file.sha256, file.upstream_source_sha256);
  assert.equal(readFileSync(join(f.root, 'mac', mac.components[0].notices[0].path), 'utf8'), readFileSync(join(f.desktop, 'LICENSE'), 'utf8'));
});

test('rejects corrupt original source and missing local source', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'original.tsx'), 'corrupt');
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /hash mismatch/);
  writeFileSync(join(f.root, 'original.tsx'), 'upstream source');
  rmSync(join(f.desktop, 'button.tsx'));
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')));
});

test('rejects path traversal, absolute paths and symlink escape', t => {
  const f = fixture(t);
  for (const path of ['../../original.tsx', '/etc/passwd', '..\\original.tsx']) {
    f.manifest.components[0].localPath = path;
    f.save();
    assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')));
  }
  symlinkSync(join(f.root, 'original.tsx'), join(f.desktop, 'escape.tsx'));
  f.manifest.components[0].localPath = 'escape.tsx'; f.save();
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /escapes/);
});

test('rejects undeclared groups, non-fixed commit and incorrect license text', t => {
  const f = fixture(t);
  f.manifest.components[0].commit = 'main'; f.save();
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /fixed upstream/);
  f.manifest.components[0].commit = 'b8d58255baf6d9e870025d3f0c60a5b80a63143b';
  f.manifest.components.push({ ...f.manifest.components[0], project: 'Unknown' }); f.save();
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /no matching license group/);
  f.manifest.components.pop(); f.save();
  writeFileSync(join(f.desktop, 'LICENSE'), 'MIT');
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /hash mismatch/);
});

test('rejects truncated licenses and modified attribution even when files still exist', t => {
  const f = fixture(t);
  writeFileSync(join(f.desktop, 'LICENSE'), 'Apache License\nVersion 2.0\n');
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /hash mismatch/);
  const shortened = readFileSync(join(f.desktop, 'LICENSE'));
  f.manifest.sourceGroups[0].fileSha256.LICENSE = createHash('sha256').update(shortened).digest('hex'); f.save();
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /Invalid Apache-2.0/);
});

test('rejects a changed modification notice before accepting license evidence', t => {
  const f = fixture(t);
  writeFileSync(join(f.desktop, 'MODIFICATIONS'), 'Changed attribution');
  assert.throws(() => collectCopiedUiEvidence(f.root, join(f.root, 'output')), /hash mismatch/);
});
