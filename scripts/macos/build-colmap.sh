#!/usr/bin/env bash
# Build the pinned COLMAP CPU CLI for the macOS M0 experiment.
set -euo pipefail

readonly expected_commit=fa8e3b3ff591552855f8ad2806723c80f963f69c
readonly deployment_target=15.0
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source_dir="$repo_root/target/macos-m0/colmap"
build_dir="$repo_root/target/macos-m0/colmap-build"
install_dir="$repo_root/target/macos-m0/colmap-install"
deps_prefix=""
jobs=4
configure_only=false
alpha_profile=false
dependency_sources=""

usage() {
    cat <<'EOF'
Usage: build-colmap.sh [--source DIR] [--build-dir DIR] [--install-dir DIR]
                       [--deps-prefix DIR] [--jobs N] [--configure-only]
                       [--alpha-profile] [--dependency-sources DIR]

Requires a clean, isolated checkout of COLMAP commit
fa8e3b3ff591552855f8ad2806723c80f963f69c, Xcode, CMake, Ninja and COLMAP's
CPU build dependencies. No checkout, dependency install or global setting is
changed. --deps-prefix optionally selects an existing local dependency prefix.
All DIR arguments must be absolute. Outputs are development artifacts: building
successfully does not establish SfM correctness or a redistributable dylib closure.
--alpha-profile disables LSD, CGAL, MVS and downloads for the SfM-only application.
Use a separate build/install directory to preserve earlier validation artifacts.
--dependency-sources reuses an existing _deps/{poselib,faiss}-src without downloads.
EOF
}

fail() { printf 'COLMAP build: %s\n' "$*" >&2; exit 1; }
while (($#)); do
    case "$1" in
        --source|--build-dir|--install-dir|--deps-prefix|--jobs|--dependency-sources)
            (($# >= 2)) || fail "missing value for $1"
            case "$1" in
                --source) source_dir=$2 ;;
                --build-dir) build_dir=$2 ;;
                --install-dir) install_dir=$2 ;;
                --deps-prefix) deps_prefix=$2 ;;
                --jobs) jobs=$2 ;;
                --dependency-sources) dependency_sources=$2 ;;
            esac
            shift 2 ;;
        --configure-only) configure_only=true; shift ;;
        --alpha-profile) alpha_profile=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || fail '--jobs must be a positive integer'
for path in "$source_dir" "$build_dir" "$install_dir"; do
    [[ "$path" == /* ]] || fail 'source, build and install paths must be absolute'
done
[[ -z "$deps_prefix" || "$deps_prefix" == /* ]] || fail 'dependency prefix must be absolute'
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail 'requires native Apple Silicon macOS'
command -v git >/dev/null || fail 'git is missing'
command -v python3 >/dev/null || fail 'python3 is required to validate output paths'
[[ -d "$source_dir/.git" ]] || fail 'source must be an isolated Git clone'
source_dir=$(cd "$source_dir" && pwd -P)
[[ $(git -C "$source_dir" rev-parse HEAD) == "$expected_commit" ]] || fail 'source commit does not match the pinned COLMAP 4.1.0 release'
[[ -z $(git -C "$source_dir" status --porcelain) ]] || fail 'source checkout contains changes; preserve them and use a clean clone'
# Resolve symlinked parents and '..' before mkdir, so rejected paths cannot
# create directories in the source checkout (including through /var aliases).
canonical_path() { python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$1"; }
build_dir=$(canonical_path "$build_dir")
install_dir=$(canonical_path "$install_dir")
if $alpha_profile; then
    [[ "$build_dir" != "$repo_root/target/macos-m0/colmap-build" &&
       "$install_dir" != "$repo_root/target/macos-m0/colmap-install" ]] ||
        fail '--alpha-profile requires separate build/install directories to preserve M0 evidence'
fi
for path in "$build_dir" "$install_dir"; do
    case "$path/" in "$source_dir/"*) fail 'build/install directories must be outside the source checkout' ;; esac
done

if [[ -n "$deps_prefix" ]]; then
    [[ -d "$deps_prefix" ]] || fail 'dependency prefix does not exist'
    deps_prefix=$(cd "$deps_prefix" && pwd -P)
    export PATH="$deps_prefix/bin:$PATH"
fi
for tool in cmake ninja xcrun shasum otool lipo; do
    command -v "$tool" >/dev/null || fail "missing required build tool: $tool"
done
sdk_path=$(xcrun --sdk macosx --show-sdk-path)
compiler=$(xcrun --find clang)
cxx_compiler=$(xcrun --find clang++)
mkdir -p "$build_dir" "$install_dir"
build_dir=$(cd "$build_dir" && pwd -P)
install_dir=$(cd "$install_dir" && pwd -P)
for path in "$build_dir" "$install_dir"; do
    case "$path/" in "$source_dir/"*) fail 'resolved build/install path is inside the source checkout' ;; esac
done
[[ "$build_dir" != "$install_dir" ]] || fail 'build and install directories must differ'
# These files belong to this recipe. A failed rebuild must never expose evidence
# from a prior successful attempt as if it described the new attempt.
rm -f "$build_dir/build-success.txt" "$build_dir/build-success.txt.tmp" \
    "$build_dir/build-info.json" "$build_dir/build-info.json.tmp" \
    "$build_dir/colmap.sha256" "$build_dir/colmap-dylibs.txt" \
    "$build_dir/colmap-load-commands.txt"
for command in colmap feature_extractor sequential_matcher exhaustive_matcher mapper global_mapper image_undistorter; do
    rm -f "$build_dir/help/$command.txt"
done

args=(
    -S "$source_dir" -B "$build_dir" -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    "-DCMAKE_INSTALL_PREFIX=$install_dir"
    "-DCMAKE_C_COMPILER=$compiler" "-DCMAKE_CXX_COMPILER=$cxx_compiler"
    "-DCMAKE_OSX_SYSROOT=$sdk_path"
    -DCMAKE_OSX_ARCHITECTURES=arm64
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=$deployment_target"
    -DCUDA_ENABLED=OFF -DGUI_ENABLED=OFF -DOPENGL_ENABLED=OFF
    -DONNX_ENABLED=OFF -DCASPAR_ENABLED=OFF -DTESTS_ENABLED=OFF
)
if $alpha_profile; then
    args+=(-DLSD_ENABLED=OFF -DCGAL_ENABLED=OFF -DMVS_ENABLED=OFF -DDOWNLOAD_ENABLED=OFF)
fi
if [[ -n "$dependency_sources" ]]; then
    [[ "$dependency_sources" == /* ]] || fail 'dependency sources must be absolute'
    for dependency in poselib faiss; do
        [[ -f "$dependency_sources/$dependency-src/CMakeLists.txt" ]] || fail "missing cached $dependency source"
    done
    args+=("-DFETCHCONTENT_SOURCE_DIR_POSELIB=$dependency_sources/poselib-src"
           "-DFETCHCONTENT_SOURCE_DIR_FAISS=$dependency_sources/faiss-src"
           -DFETCHCONTENT_FULLY_DISCONNECTED=ON)
fi
if [[ -n "$deps_prefix" ]]; then
    [[ -f "$deps_prefix/lib/libomp.dylib" && -f "$deps_prefix/include/omp.h" ]] || fail 'dependency prefix must provide lib/libomp.dylib and include/omp.h'
    args+=(
        "-DCMAKE_PREFIX_PATH=$deps_prefix"
        # M0 developer install only. M4 must replace this absolute development
        # rpath with a verified, bundled dylib closure before distribution.
        "-DCMAKE_INSTALL_RPATH=$deps_prefix/lib"
        '-DOpenMP_C_FLAGS=-Xpreprocessor -fopenmp'
        '-DOpenMP_CXX_FLAGS=-Xpreprocessor -fopenmp'
        -DOpenMP_C_LIB_NAMES=omp -DOpenMP_CXX_LIB_NAMES=omp
        "-DOpenMP_omp_LIBRARY=$deps_prefix/lib/libomp.dylib"
        "-DOpenMP_C_INCLUDE_DIR=$deps_prefix/include"
        "-DOpenMP_CXX_INCLUDE_DIR=$deps_prefix/include"
    )
fi
{
    printf 'source_commit=%s\ndeployment_target=%s\narchitecture=arm64\n' "$expected_commit" "$deployment_target"
    sw_vers
    "$compiler" --version
    xcrun --sdk macosx --show-sdk-version
    cmake --version
    ninja --version
    printf 'configure_command='
    printf '%q ' cmake "${args[@]}"
    printf '\n'
} > "$build_dir/build-environment.txt"

cmake "${args[@]}" 2>&1 | tee "$build_dir/configure.log"
$configure_only && exit 0
cmake --build "$build_dir" --parallel "$jobs" 2>&1 | tee "$build_dir/build.log"
cmake --install "$build_dir" 2>&1 | tee "$build_dir/install.log"
binary="$install_dir/bin/colmap"
[[ -x "$binary" ]] || fail 'install did not produce an executable bin/colmap'
[[ $(lipo -archs "$binary") == arm64 ]] || fail 'installed executable is not arm64-only'
shasum -a 256 "$binary" > "$build_dir/colmap.sha256"
otool -L "$binary" > "$build_dir/colmap-dylibs.txt"
otool -l "$binary" > "$build_dir/colmap-load-commands.txt"
mkdir -p "$build_dir/help"
"$binary" --help > "$build_dir/help/colmap.txt" 2>&1
for command in feature_extractor sequential_matcher exhaustive_matcher mapper global_mapper image_undistorter; do
    "$binary" "$command" --help > "$build_dir/help/$command.txt" 2>&1
done
python3 "$repo_root/scripts/macos/verify_colmap_help.py" "$build_dir/help"
python3 - "$binary" "$build_dir" "$expected_commit" "$deployment_target" "$alpha_profile" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

binary, build_dir, commit, deployment_target, alpha_profile = sys.argv[1:]
digest = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
record = {
    "schema_version": 1,
    "engine": "colmap",
    "version": "4.1.0",
    "source_commit": commit,
    "binary_sha256": digest,
    "target": "aarch64-apple-darwin",
    "deployment_target": deployment_target,
    "cpu_only": True,
    "cmake_options": {key: "OFF" for key in (
        "CUDA_ENABLED", "GUI_ENABLED", "OPENGL_ENABLED", "ONNX_ENABLED",
        "CASPAR_ENABLED", "TESTS_ENABLED",
    )},
}
if alpha_profile == "true":
    record["profile"] = "sfm-alpha"
    record["cmake_options"].update({key: "OFF" for key in (
        "LSD_ENABLED", "CGAL_ENABLED", "MVS_ENABLED", "DOWNLOAD_ENABLED",
    )})
temporary = Path(build_dir) / "build-info.json.tmp"
temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
temporary.replace(Path(build_dir) / "build-info.json")
PY
printf 'source_commit=%s\narchitecture=arm64\ndeployment_target=%s\ncli_help_passed=true\nsfm_smoke_passed=not_run\n' \
    "$expected_commit" "$deployment_target" > "$build_dir/build-success.txt.tmp"
mv "$build_dir/build-success.txt.tmp" "$build_dir/build-success.txt"
printf 'Built COLMAP CPU CLI: %s\nEvidence directory: %s\n' "$binary" "$build_dir"
