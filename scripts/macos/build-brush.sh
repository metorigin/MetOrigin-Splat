#!/bin/bash
# Build only the audited headless Brush target. Does not install global tools.
set -euo pipefail

readonly BRUSH_COMMIT=1388f74c6fe0236f68ee4915564bf00e9d2e3747
readonly RUST_VERSION=1.95.0
readonly TARGET=aarch64-apple-darwin

usage() {
  cat <<'EOF'
Usage: build-brush.sh [--diagnostics-patch|--machine-probe-patch|--training-contract-patch|--live-preview-patch|--distribution-patch|--lpips-policy-patch|--stock] SOURCE_CHECKOUT [OUTPUT_DIRECTORY]

SOURCE_CHECKOUT must be a clean, isolated checkout of the pinned Brush commit.
OUTPUT_DIRECTORY defaults to target/macos-m4/brush-v6-build for the distribution profile
and target/macos-m0/brush-build for historical research profiles.
Put the Rust 1.95.0 toolchain's bin directory on PATH before invoking this script.
Only the default WGPU features are built; no native MSL optimization is enabled.
Default: metorigin-macos.6; excludes LPIPS weights and unaudited optional dependencies.
This builds and captures CLI evidence; it does not certify Metal training.
--diagnostics-patch applies the pinned metorigin-macos.1 adapter-info patch.
--machine-probe-patch applies the cumulative metorigin-macos.2 machine-interface patch.
--training-contract-patch applies metorigin-macos.3 (loader threads, CLI overrides, atomic checkpoints).
--live-preview-patch applies metorigin-macos.4 (paired Slot snapshots and protocol-1 request/ACK).
--distribution-patch explicitly selects the default metorigin-macos.6 profile.
--lpips-policy-patch reproduces historical metorigin-macos.5 (LPIPS weight exclusion).
--stock and older patch flags reproduce historical research builds, not release candidates.
It requires a detached checkout and refuses any other source changes.
EOF
}

fail() { printf 'Brush build: %s\n' "$*" >&2; exit 1; }

if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
patch_id=metorigin-macos.6
patch_sha256=1e342de3d80fc9ae3ac38873814b17b9bc6d8ce067159ad3eae02ef3148353d2
if [[ ${1:-} == --distribution-patch ]]; then
  shift
elif [[ ${1:-} == --lpips-policy-patch ]]; then
  patch_id=metorigin-macos.5
  patch_sha256=1034676b02f2c42624368bb7183a315dc787037d8605cdbb7fde16c6e0b13249
  shift
elif [[ ${1:-} == --stock ]]; then
  patch_id=stock
  patch_sha256=
  shift
elif [[ ${1:-} == --diagnostics-patch ]]; then
  patch_id=metorigin-macos.1
  patch_sha256=00f507d8d14290232f2ddc02d5cffed88f127044a0bb3bd9e19ea9055929aadb
  shift
elif [[ ${1:-} == --machine-probe-patch ]]; then
  patch_id=metorigin-macos.2
  patch_sha256=0bd728c9f1048372791eb28923a7af5dd10d3ad1dd9b5cbf62ae5de57182cfc7
  shift
elif [[ ${1:-} == --training-contract-patch ]]; then
  patch_id=metorigin-macos.3
  patch_sha256=f2e0853ba495e492fa5ebb890ed8d2a7886ce54752740daacbc67aff3c228cc8
  shift
elif [[ ${1:-} == --live-preview-patch ]]; then
  patch_id=metorigin-macos.4
  patch_sha256=95e56aaa6b253fa21174d8ef002e95eba4a79f684d3b75a3b565f10141ccf631
  shift
fi
if [[ $# -lt 1 || $# -gt 2 ]]; then usage >&2; exit 2; fi
[[ -d $1 ]] || fail 'Source checkout does not exist.'
source_dir=$(cd "$1" && pwd -P)
git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'Source must be a Git checkout.'
[[ $(git -C "$source_dir" rev-parse HEAD) == "$BRUSH_COMMIT" ]] || fail "Source must be pinned to $BRUSH_COMMIT."
if [[ $patch_id == stock ]]; then
  [[ -z $(git -C "$source_dir" status --porcelain --untracked-files=normal) ]] || fail 'Source checkout must be clean.'
fi
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail 'Build requires a native Apple Silicon macOS host.'
for tool in cargo rustc xcrun xcodebuild shasum lipo otool python3; do
  command -v "$tool" >/dev/null || fail "Missing required tool: $tool."
done
[[ $(rustc --version) == "rustc $RUST_VERSION "* ]] || fail "Rust $RUST_VERSION is required; put its bin directory on PATH."
[[ $(cargo --version) == "cargo $RUST_VERSION "* ]] || fail "Cargo $RUST_VERSION is required."
[[ -z ${RUSTFLAGS:-} && -z ${CARGO_ENCODED_RUSTFLAGS:-} ]] || fail 'Unset custom RUSTFLAGS for the baseline build.'
[[ -f "$source_dir/Cargo.lock" ]] || fail 'Pinned source is missing Cargo.lock.'

app_root=$(cd "$(dirname "$0")/../.." && pwd -P)
default_output="$app_root/target/macos-m0/brush-build"
if [[ $patch_id == metorigin-macos.6 ]]; then default_output="$app_root/target/macos-m4/brush-v6-build"; fi
if [[ $patch_id == metorigin-macos.5 ]]; then default_output="$app_root/target/macos-m4/brush-build"; fi
output_dir=${2:-"$default_output"}
resolve_output_path() {
  python3 - "$source_dir" "$1" <<'PY'
from pathlib import Path
import sys
source, output = (Path(value).resolve() for value in sys.argv[1:])
if source == output or source in output.parents or output in source.parents:
    sys.exit("Brush build: Output/cache paths must not overlap the source checkout.")
print(output)
PY
}
output_dir=$(resolve_output_path "$output_dir")
export CARGO_HOME
CARGO_HOME=$(resolve_output_path "${CARGO_HOME:-"$output_dir/cargo-home"}")
export CARGO_TARGET_DIR
CARGO_TARGET_DIR=$(resolve_output_path "${CARGO_TARGET_DIR:-"$output_dir/target"}")
[[ ! -L "$output_dir/evidence" ]] || fail 'Evidence directory must not be a symlink.'
if [[ $patch_id != stock ]]; then
  python3 "$app_root/scripts/macos/prepare-brush-source.py" "$source_dir" --profile "$patch_id"
fi
mkdir -p "$output_dir/evidence"
# Do not leave a previous successful build's verification beside a failed retry.
rm -f "$output_dir/evidence/version.txt" "$output_dir/evidence/help.txt" \
  "$output_dir/evidence/dynamic-libraries.txt" "$output_dir/evidence/load-commands.txt" \
  "$output_dir/evidence/binary.sha256" "$output_dir/evidence/build-info.json" \
  "$output_dir/evidence/distribution-policy.json" "$output_dir/evidence/cargo-target-tree.txt"
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
# Xcode 27's stripped proc-macro dylibs fail dyld LINKEDIT alignment checks.
# Keep symbols during compilation; any distribution stripping precedes signing.
export CARGO_PROFILE_RELEASE_STRIP=none
export MACOSX_DEPLOYMENT_TARGET=15.0
export SDKROOT
SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
lock_hash=$(shasum -a 256 "$source_dir/Cargo.lock" | cut -d ' ' -f 1)

{
  printf 'source_commit=%s\n' "$BRUSH_COMMIT"
  printf 'cargo_lock_sha256=%s\n' "$lock_hash"
  printf 'target=%s\ndeployment_target=15.0\nfeatures=default\n' "$TARGET"
  printf 'build_jobs=%s\n' "$CARGO_BUILD_JOBS"
  printf 'release_strip=none\n'
  printf 'patch_id=%s\npatch_sha256=%s\n' "$patch_id" "$patch_sha256"
  rustc -vV
  cargo --version
  xcodebuild -version
  xcrun --sdk macosx --show-sdk-version
  printf 'command=cargo build --locked --release -p brush-cli --target %s\n' "$TARGET"
} > "$output_dir/evidence/build-info.txt"

# Running in the checkout avoids inheriting an application-level Cargo config.
(
  cd "$source_dir"
  cargo build --locked --release -p brush-cli --target "$TARGET"
) 2>&1 | tee "$output_dir/evidence/build.log"
[[ $(shasum -a 256 "$source_dir/Cargo.lock" | cut -d ' ' -f 1) == "$lock_hash" ]] || fail 'Cargo.lock changed during a locked build.'
if [[ $patch_id == stock ]]; then
  [[ -z $(git -C "$source_dir" status --porcelain --untracked-files=normal) ]] || fail 'Source changed during build.'
else
  python3 "$app_root/scripts/macos/prepare-brush-source.py" "$source_dir" --profile "$patch_id" --verify
fi

binary="$CARGO_TARGET_DIR/$TARGET/release/brush-cli"
[[ -x "$binary" ]] || fail 'Build did not produce an executable brush-cli.'
[[ $(lipo -archs "$binary") == arm64 ]] || fail 'Expected an arm64-only binary.'
"$binary" --version > "$output_dir/evidence/version.txt"
"$binary" --help > "$output_dir/evidence/help.txt"
for option in total-train-iters max-resolution max-splats max-scene-batch-cache-size lod-levels export-path export-name; do
  grep -F -- "--$option" "$output_dir/evidence/help.txt" >/dev/null || fail "Built CLI is missing --$option."
done
otool -L "$binary" > "$output_dir/evidence/dynamic-libraries.txt"
otool -l "$binary" > "$output_dir/evidence/load-commands.txt"
shasum -a 256 "$binary" > "$output_dir/evidence/binary.sha256"
if [[ $patch_id == metorigin-macos.5 || $patch_id == metorigin-macos.6 ]]; then
  (cd "$source_dir" && cargo tree --locked -p brush-cli --target "$TARGET" -e normal,build --format '{p} {l}') \
    > "$output_dir/evidence/cargo-target-tree.txt"
  python3 "$app_root/scripts/macos/check-brush-distribution.py" --brush "$binary" \
    --source "$source_dir" --dependency-tree "$output_dir/evidence/cargo-target-tree.txt" \
    --output "$output_dir/evidence/distribution-policy.json"
fi
python3 - "$binary" "$output_dir/evidence" "$BRUSH_COMMIT" "$lock_hash" "$RUST_VERSION" "$patch_id" "$patch_sha256" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

binary, evidence, commit, lock_hash, rust_version, patch_id, patch_sha256 = sys.argv[1:]
evidence = Path(evidence)
digest = hashlib.sha256()
with open(binary, "rb") as source:
    for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
record = {
    "schema_version": 1,
    "source_commit": commit,
    "binary_sha256": digest.hexdigest(),
    "cargo_lock_sha256": lock_hash,
    "target": "aarch64-apple-darwin",
    "deployment_target": "15.0",
    "features": ["default"],
    "target_graph_sha256": hashlib.sha256((evidence / "cargo-target-tree.txt").read_bytes()).hexdigest()
        if (evidence / "cargo-target-tree.txt").exists() else None,
    "rust_version": rust_version,
    "release_strip": "none",
    "patch_id": patch_id,
    "patch_sha256": patch_sha256 or None,
    "cli_version": (evidence / "version.txt").read_text().strip(),
    "metal_training_validated": False,
    "lpips_weights_embedded": False if patch_id in {"metorigin-macos.5", "metorigin-macos.6"} else None,
    "distribution_policy": ("optional_dependencies_excluded" if patch_id == "metorigin-macos.6"
                            else "lpips_weights_excluded" if patch_id == "metorigin-macos.5" else "research_only"),
    "native_rerun_enabled": False if patch_id == "metorigin-macos.6" else None,
    "excluded_dependencies": ["hex-slice", "indicatif-log-bridge"] if patch_id == "metorigin-macos.6" else [],

}
with tempfile.NamedTemporaryFile("w", dir=evidence, delete=False) as output:
    try:
        json.dump(record, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
        os.replace(output.name, evidence / "build-info.json")
    except BaseException:
        Path(output.name).unlink(missing_ok=True)
        raise
PY
printf 'Built %s\nCLI evidence: %s/evidence\nMetal training remains to be validated.\n' "$binary" "$output_dir"
