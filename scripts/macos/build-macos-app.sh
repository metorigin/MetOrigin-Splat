#!/bin/bash
# Build and verify the app first, then package that exact bundle into a fresh DMG.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
test "$(uname -s)" = Darwin && test "$(uname -m)" = arm64

internal=()
pack_checks=(--require-distributable)
profile=release
build_options=()
make_dmg=true
notary_submit_only=false
signing_identity=""
team_id=""
notary_profile=""
engine_pack_override=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --internal-alpha) internal=(--internal-alpha); pack_checks=() ;;
    --debug) profile=debug; build_options+=(--debug) ;;
    --app-only) make_dmg=false ;;
    --notary-submit-only) notary_submit_only=true ;;
    --signing-identity|--team-id|--notary-profile|--engine-pack-root)
      option="$1"
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "Missing value for $option" >&2; exit 2
      fi
      case "$option" in
        --signing-identity) signing_identity="$2" ;;
        --team-id) team_id="$2" ;;
        --notary-profile) notary_profile="$2" ;;
        --engine-pack-root) engine_pack_override="$2" ;;
      esac
      shift ;;
    *) echo "Usage: $0 [--internal-alpha] [--debug] [--app-only] [--signing-identity SHA1 --team-id TEAM [--notary-profile PROFILE [--notary-submit-only]]] [--engine-pack-root DIRECTORY]" >&2; exit 2 ;;
  esac
  shift
done
if [[ -n "$signing_identity" || -n "$team_id" || -n "$notary_profile" ]]; then
  if [[ ! "$signing_identity" =~ ^[0-9A-Fa-f]{40}$ || ! "$team_id" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "Formal signing requires --signing-identity (certificate SHA-1) and --team-id." >&2; exit 2
  fi
  if [[ "$profile" != release ]]; then
    echo "Developer ID signing requires a release build." >&2; exit 2
  fi
fi
if [[ "$notary_submit_only" == true && ( -z "$notary_profile" || "$make_dmg" != true ) ]]; then
  echo "--notary-submit-only requires --notary-profile and a DMG build (not --app-only)." >&2; exit 2
fi
for tool in node pnpm cargo python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' was not found in PATH. See docs/macos-packaging.zh-CN.md." >&2
    exit 1
  fi
done
node_version="$(node --version)"
case "$node_version" in
  v26.*) ;;
  *) echo "Node.js 26.x is required; found '$node_version'." >&2; exit 1 ;;
esac
expected_pnpm="$(node -p 'require("./package.json").packageManager.split("@").pop()')"
actual_pnpm="$(pnpm --version)"
if [[ "$actual_pnpm" != "$expected_pnpm" ]]; then
  echo "pnpm $expected_pnpm is required; found '$actual_pnpm'." >&2
  exit 1
fi
pack_root="$(node scripts/shared/engine-paths.mjs --key distributionRoot)"
if [[ -n "$engine_pack_override" ]]; then
  pack_root="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve(strict=True))' "$engine_pack_override")"
fi
packages_root="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind packages)"
verification_root="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind verification)"
supersplat_source="$(node scripts/shared/cache-paths.mjs --kind source)"
# Bash 3.2 (the macOS default) treats empty arrays as unset with nounset.
python3 scripts/macos/verify-pack.py "$pack_root/engines" ${pack_checks[@]+"${pack_checks[@]}"}
test -f "$pack_root/release-status.json"
mkdir -p "$verification_root"
work="$(mktemp -d "$verification_root/build.XXXXXX")"
stage="$work/dmg-source"
latest_temporary=""
trap 'rm -rf "$stage"; if [[ -n "$latest_temporary" ]]; then rm -f "$latest_temporary"; fi' EXIT
license_root="$(node scripts/shared/artifact-paths.mjs --platform macos-arm64 --kind license-current)"
python3 scripts/macos/verify-app.py --check-app-license-evidence "$license_root" ${internal[@]+"${internal[@]}"} --report "$work/app-license-preflight.json"
# Bind notice collection to the dependency inputs selected by this build.
verify_notice_inputs() {
  local pair
  local inputs=(
    'Cargo.lock:Cargo.lock'
    'Cargo.toml:Cargo.toml'
    'apps/desktop/src-tauri/Cargo.toml:desktop-Cargo.toml'
    'apps/desktop/package.json:desktop-package.json'
    'pnpm-lock.yaml:pnpm-lock.yaml'
    'pnpm-workspace.yaml:pnpm-workspace.yaml'
    'integrations/supersplat/upstream.json:supersplat-upstream.json'
  )
  for pair in "${inputs[@]}"; do
    cmp "$repo_root/${pair%%:*}" "$license_root/build-inputs/${pair#*:}"
  done
  cmp "$supersplat_source/package-lock.json" "$license_root/build-inputs/supersplat-package-lock.json"
}
verify_notice_inputs
node scripts/macos/verify-supersplat-inputs.mjs --license-root "$license_root" --report "$work/supersplat-inputs-before.json"
node integrations/spark/verify-patch.mjs --license-root "$license_root" --report "$work/spark-patch-before.json"
node integrations/three/verify-patch.mjs --license-root "$license_root" --report "$work/three-patch-before.json"
python3 scripts/macos/verify-app-icon.py
if [[ -n "$signing_identity" ]]; then
  source_manifest="$(/usr/bin/shasum -a 256 "$pack_root/engines/engine-manifest.json" | cut -d ' ' -f 1)"
  source_status="$(/usr/bin/shasum -a 256 "$pack_root/release-status.json" | cut -d ' ' -f 1)"
  python3 scripts/macos/sign-engine-pack.py --source-pack "$pack_root/engines" \
    --expected-source-manifest-sha256 "$source_manifest" \
    --expected-source-release-status-sha256 "$source_status" \
    --output "$work/signed-engine-pack" --identity "$signing_identity" --team-id "$team_id" \
    > "$work/engine-signing.log" 2>&1
  pack_root="$work/signed-engine-pack"
  python3 scripts/macos/verify-pack.py "$pack_root/engines" ${pack_checks[@]+"${pack_checks[@]}"} \
    --relocate --report-dir "$work/signed-engine-relocation" > "$work/engine-relocation.log" 2>&1
fi
node scripts/macos/resource-config.mjs --engine-pack-root "$pack_root" > "$work/tauri-resources.conf.json"
before_licenses="$(/usr/bin/shasum -a 256 "$license_root/manifest.json" | cut -d ' ' -f 1)"
before_manifest="$(/usr/bin/shasum -a 256 "$pack_root/engines/engine-manifest.json" | cut -d ' ' -f 1)"
before_status="$(/usr/bin/shasum -a 256 "$pack_root/release-status.json" | cut -d ' ' -f 1)"
export MACOSX_DEPLOYMENT_TARGET=15.0
# Xcode 27 strip removes proc-macro LINKEDIT metadata and causes E0463.
# Keep final bytes stable; signing/hashes are verified after Tauri finishes.
export CARGO_PROFILE_RELEASE_STRIP=none
# Exercise the production release resolver against these exact frozen bytes.
# This ignored test hashes the whole pack without a cache or engine execution.
METORIGIN_TEST_ENGINE_PACK="$pack_root/engines" \
METORIGIN_TEST_ENGINE_MANIFEST_SHA256="$before_manifest" \
  cargo test --locked --target aarch64-apple-darwin -p splat-hardware --lib \
    locator::tests::frozen_macos_engine_pack_resolves_without_execution \
    -- --ignored --exact --nocapture 2>&1 | tee "$work/runtime-engine-locator.log"
# Run the same application adapter/version probes as startup (without Metal or UI).
METORIGIN_TEST_ENGINE_PACK="$pack_root/engines" \
METORIGIN_TEST_ENGINE_MANIFEST_SHA256="$before_manifest" \
  cargo test --locked --target aarch64-apple-darwin -p splat-desktop --lib \
    commands::system::tests::frozen_macos_engine_pack_passes_application_version_checks \
    -- --ignored --exact --nocapture 2>&1 | tee "$work/runtime-application-preflight.log"
# Tauri builds/copies the already-frozen engines; only this script may sign.
# Prevent a developer shell's Tauri credentials from re-signing nested binaries
# or submitting an unverified application before our explicit notarization step.
env -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
  -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY \
  -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  pnpm --dir apps/desktop tauri build --target aarch64-apple-darwin --bundles app --config "$work/tauri-resources.conf.json" ${build_options[@]+"${build_options[@]}"} -- --locked
after_manifest="$(/usr/bin/shasum -a 256 "$pack_root/engines/engine-manifest.json" | cut -d ' ' -f 1)"
after_status="$(/usr/bin/shasum -a 256 "$pack_root/release-status.json" | cut -d ' ' -f 1)"
test "$before_manifest" = "$after_manifest"
test "$before_status" = "$after_status"
after_licenses="$(/usr/bin/shasum -a 256 "$license_root/manifest.json" | cut -d ' ' -f 1)"
test "$before_licenses" = "$after_licenses"
verify_notice_inputs
node scripts/macos/verify-supersplat-inputs.mjs --license-root "$license_root" --dist --expected-report "$work/supersplat-inputs-before.json" --report "$work/supersplat-inputs-after.json"
node integrations/spark/verify-patch.mjs --license-root "$license_root" --expected-report "$work/spark-patch-before.json" --report "$work/spark-patch-after.json"
node integrations/three/verify-patch.mjs --license-root "$license_root" --expected-report "$work/three-patch-before.json" --report "$work/three-patch-after.json"
app_path="$repo_root/target/aarch64-apple-darwin/$profile/bundle/macos/MetOrigin Splat.app"
python3 scripts/macos/verify-app-icon.py --app "$app_path" > "$work/app-icon.json"
# Tauri leaves the linker signature when no signing identity is configured.
# Seal this explicitly requested internal build without rewriting nested engines.
if [[ -n "$signing_identity" ]]; then
  /usr/bin/codesign --force --sign "$signing_identity" --options runtime --timestamp "$app_path"
elif [[ "${internal[0]-}" == --internal-alpha ]]; then
  /usr/bin/codesign --force --sign - --timestamp=none "$app_path"
fi
verify_options=(${internal[@]+"${internal[@]}"} --expected-manifest-sha256 "$before_manifest" --expected-release-status-sha256 "$before_status" --expected-app-license-manifest-sha256 "$before_licenses" --frontend-input-report "$work/supersplat-inputs-after.json")
if [[ -n "$signing_identity" ]]; then
  verify_options+=(--expected-team-id "$team_id" --expected-signing-identity "$signing_identity")
fi
python3 scripts/macos/verify-app.py "$app_path" "${verify_options[@]}" --report "$work/verified-app.json"
if [[ -n "$notary_profile" && "$make_dmg" == false ]]; then
  # A standalone .app needs its own ticket. For DMG distribution Apple checks
  # the outermost signed container, so no separate ZIP submission is needed.
  cp "$work/verified-app.json" "$work/pre-notarization-app.json"
  /usr/bin/ditto -c -k --keepParent "$app_path" "$work/notarization-app.zip"
  python3 scripts/macos/notarize-artifact.py --submit-file "$work/notarization-app.zip" \
    --staple-target "$app_path" --keychain-profile "$notary_profile" --report-dir "$work/notary-app"
  verify_options+=(--require-notarized)
  # Stapling adds the standalone app's ticket. Establish its final inventory
  # now while requiring the same pre-submission executable and engine identity.
  python3 scripts/macos/verify-app.py "$app_path" "${verify_options[@]}" \
    --expected-code-report "$work/pre-notarization-app.json" --report "$work/verified-app.json"
fi
if [[ "$make_dmg" == true ]]; then
  mkdir -p "$stage" "$packages_root"
  /usr/bin/ditto "$app_path" "$stage/MetOrigin Splat.app"
  ln -s /Applications "$stage/Applications"
  dmg="$packages_root/MetOrigin-Splat-${profile}-${before_manifest:0:12}-${work##*/}.dmg"
  # Unique name, no overwrite and no glob: stale DMGs can never become evidence.
  /usr/bin/hdiutil create -volname 'MetOrigin Splat' -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg"
  if [[ -n "$signing_identity" ]]; then
    /usr/bin/codesign --force --sign "$signing_identity" --timestamp "$dmg"
    # Verify the signed DMG against the final app before uploading it. Its own
    # ticket does not exist yet, so defer only the notarization requirement.
    dmg_preflight_options=(${internal[@]+"${internal[@]}"} --expected-manifest-sha256 "$before_manifest" --expected-release-status-sha256 "$before_status" --expected-app-license-manifest-sha256 "$before_licenses" --frontend-input-report "$work/supersplat-inputs-after.json" --expected-team-id "$team_id" --expected-signing-identity "$signing_identity")
    python3 scripts/macos/verify-app.py "$app_path" "${dmg_preflight_options[@]}" \
      --dmg "$dmg" --report "$work/signed-dmg-preflight.json"
  fi
  if [[ -n "$notary_profile" ]]; then
    notary_options=()
    if [[ "$notary_submit_only" == true ]]; then
      notary_options+=(--submit-only)
    fi
    python3 scripts/macos/notarize-artifact.py --submit-file "$dmg" --staple-target "$dmg" \
      --keychain-profile "$notary_profile" --report-dir "$work/notary-dmg" ${notary_options[@]+"${notary_options[@]}"}
    if [[ "$notary_submit_only" == true ]]; then
      # A successful upload is a pending receipt, never a successful package.
      # Validate its binding before reporting the ID; leave latest/retention and
      # all accepted application/package reports unchanged until Apple accepts.
      python3 - "$dmg" "$work/signed-dmg-preflight.json" "$work/notary-dmg/submission.json" \
        "$work/pending-dmg.json" "$notary_profile" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
import uuid

dmg, verified, submitted, pending = [Path(value).resolve(strict=True) for value in sys.argv[1:4]] + [Path(sys.argv[4])]
profile = sys.argv[5]
def file_sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()

digest = file_sha256(dmg)
receipt = json.loads(submitted.read_text())
preflight = json.loads(verified.read_text())
identifier = str(uuid.UUID(receipt["id"]))
if (identifier != receipt["id"].lower() or Path(receipt["submit_file"]).resolve() != dmg
        or Path(receipt["staple_target"]).resolve() != dmg or receipt["keychain_profile"] != profile
        or receipt["submitted_sha256"] != digest or Path(preflight["dmg"]["path"]).resolve() != dmg
        or preflight["dmg"]["sha256"] != digest):
    raise SystemExit("Pending notarization receipt does not match the verified signed DMG.")
payload = {"schema_version": 1, "status": "submitted-awaiting-apple", "pending": True,
           "accepted": False, "notarization_verified": False, "submission_only": True,
           "dmg": {"path": str(dmg), "sha256": digest}, "submission_id": identifier,
           "submission_receipt": str(submitted), "signed_dmg_preflight_report": str(verified),
           "signed_dmg_preflight_sha256": file_sha256(verified),
           "scope": "Signed DMG submitted to Apple; no notarization, staple, latest or package publication acceptance."}
with pending.open("x", encoding="utf-8") as handle:
    handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
print("Apple notarization pending; no successful package was published.")
print("Pending DMG: " + str(dmg))
print("Pending notarization report: " + str(pending))
print("Notarization submission ID: " + identifier)
PY
      exit 0
    fi
    verify_options+=(--require-notarized-container)
  fi
  python3 scripts/macos/verify-app.py "$app_path" "${verify_options[@]}" --expected-app-report "$work/verified-app.json" --dmg "$dmg" --report "$work/final.json"
else
  cp "$work/verified-app.json" "$work/final.json"
fi
rm -rf "$stage"
# Registration must succeed before publishing latest. Keep its temporary copy
# outside the registered run so no report inventory changes after registration.
latest_temporary="$(mktemp "$verification_root/.latest.XXXXXX")"
cp "$work/final.json" "$latest_temporary"
if [[ "$make_dmg" == true ]]; then
  node scripts/shared/artifact-retention.mjs record --platform macos-arm64 --report "$work/final.json" --package "$dmg" --license-root "$license_root"
fi
mv -f "$latest_temporary" "$verification_root/latest.json"
latest_temporary=""
if [[ "$make_dmg" == true ]]; then
  # The old latest protected the previous successful package during record.
  # Prune only after publication; cleanup failure does not revoke acceptance.
  if ! node scripts/shared/artifact-retention.mjs apply --platform macos-arm64 --apply; then
    echo "Warning: artifact cleanup failed; the verified package remains registered and published." >&2
  fi
  echo "Verified DMG: $dmg"
fi
echo "Verified app packaging evidence: $work/final.json"
