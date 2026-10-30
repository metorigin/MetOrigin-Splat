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
for option in "$@"; do
  case "$option" in
    --internal-alpha) internal=(--internal-alpha); pack_checks=() ;;
    --debug) profile=debug; build_options+=(--debug) ;;
    --app-only) make_dmg=false ;;
    *) echo "Usage: $0 [--internal-alpha] [--debug] [--app-only]" >&2; exit 2 ;;
  esac
done
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
pack_root="$repo_root/target/distribution/macos-arm64"
# Bash 3.2 (the macOS default) treats empty arrays as unset with nounset.
python3 scripts/macos/verify-pack.py "$pack_root/engines" ${pack_checks[@]+"${pack_checks[@]}"}
test -f "$pack_root/release-status.json"
verification_root="$repo_root/target/macos-m4/app-verification"
mkdir -p "$verification_root"
work="$(mktemp -d "$verification_root/build.XXXXXX")"
stage="$work/dmg-source"
trap 'rm -rf "$stage"' EXIT
license_root="$repo_root/target/macos-m4/app-license-evidence/licenses"
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
    'target/supersplat-source/upstream/package-lock.json:supersplat-package-lock.json'
  )
  for pair in "${inputs[@]}"; do
    cmp "$repo_root/${pair%%:*}" "$license_root/build-inputs/${pair#*:}"
  done
}
verify_notice_inputs
node scripts/macos/verify-supersplat-inputs.mjs --license-root "$license_root" --report "$work/supersplat-inputs-before.json"
node integrations/spark/verify-patch.mjs --license-root "$license_root" --report "$work/spark-patch-before.json"
node integrations/three/verify-patch.mjs --license-root "$license_root" --report "$work/three-patch-before.json"
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
pnpm --dir apps/desktop tauri build --target aarch64-apple-darwin --bundles app --config src-tauri/tauri.macos.full.conf.json ${build_options[@]+"${build_options[@]}"} -- --locked
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
# Tauri leaves the linker signature when no signing identity is configured.
# Seal this explicitly requested internal build without rewriting nested engines.
if [[ "${internal[0]-}" == --internal-alpha ]]; then
  /usr/bin/codesign --force --sign - --timestamp=none "$app_path"
fi
verify_options=(${internal[@]+"${internal[@]}"} --expected-manifest-sha256 "$before_manifest" --expected-release-status-sha256 "$before_status" --expected-app-license-manifest-sha256 "$before_licenses" --frontend-input-report "$work/supersplat-inputs-after.json")
python3 scripts/macos/verify-app.py "$app_path" "${verify_options[@]}" --report "$work/verified-app.json"
if [[ "$make_dmg" == true ]]; then
  mkdir -p "$stage" "$repo_root/target/aarch64-apple-darwin/$profile/bundle/dmg"
  /usr/bin/ditto "$app_path" "$stage/MetOrigin Splat.app"
  ln -s /Applications "$stage/Applications"
  dmg="$repo_root/target/aarch64-apple-darwin/$profile/bundle/dmg/MetOrigin-Splat-${profile}-${before_manifest:0:12}-${work##*/}.dmg"
  # Unique name, no overwrite and no glob: stale DMGs can never become evidence.
  /usr/bin/hdiutil create -volname 'MetOrigin Splat' -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg"
  python3 scripts/macos/verify-app.py "$app_path" "${verify_options[@]}" --expected-app-report "$work/verified-app.json" --dmg "$dmg" --report "$work/final.json"
else
  cp "$work/verified-app.json" "$work/final.json"
fi
# A failed build keeps the previous successful report and leaves this run's evidence.
cp "$work/final.json" "$verification_root/latest.json"
echo "Verified app packaging evidence: $work/final.json"
