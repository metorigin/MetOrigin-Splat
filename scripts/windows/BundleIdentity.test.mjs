import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeBundleBytes } from './BundleIdentity.mjs';

test('NSIS expected payload identity changes only the unique framework marker and preserves raw input', () => {
  const raw = Buffer.from('MZ-prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0actual-code-and-assets');
  const original = Buffer.from(raw);
  const identity = describeBundleBytes(raw, 'nsis');
  const installed = Buffer.from('MZ-prefix\0__TAURI_BUNDLE_TYPE_VAR_NSS\0actual-code-and-assets');
  assert.equal(identity.expected_payload_sha256, createHash('sha256').update(installed).digest('hex'));
  assert.notEqual(identity.expected_payload_sha256, identity.raw_application_sha256);
  assert.equal(identity.transform.changed_bytes, 3);
  assert.deepEqual(raw, original);
  assert.equal(describeBundleBytes(raw, 'none').expected_payload_sha256, identity.raw_application_sha256);
});

test('unknown, missing, duplicate or already changed bundle markers are refused', () => {
  for (const bytes of ['MZ-unknown', '__TAURI_BUNDLE_TYPE_VAR_UNK __TAURI_BUNDLE_TYPE_VAR_UNK', '__TAURI_BUNDLE_TYPE_VAR_NSS']) {
    assert.throws(() => describeBundleBytes(Buffer.from(bytes), 'nsis'), /marker/);
  }
  assert.throws(() => describeBundleBytes(Buffer.from('MZ'), 'future'), /Unsupported/);
});
