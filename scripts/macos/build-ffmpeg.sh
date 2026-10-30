#!/usr/bin/env bash
# Native, local LGPL FFmpeg/FFprobe build. Never installs system-wide.
set -euo pipefail

readonly expected_commit=38b88335f99e76ed89ff3c93f877fdefce736c13
readonly deployment_target=15.0
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source_dir="$repo_root/target/macos-m0/ffmpeg"
build_dir="$repo_root/target/macos-m0/ffmpeg-build"
install_dir="$repo_root/target/macos-m0/ffmpeg-install"
jobs=4
configure_only=false
fail() { printf 'FFmpeg build: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'EOF'
Usage: build-ffmpeg.sh [--source DIR] [--build-dir DIR] [--install-dir DIR]
                       [--jobs N] [--configure-only]

Requires a clean isolated FFmpeg n8.1.2 checkout at
38b88335f99e76ed89ff3c93f877fdefce736c13 and native Apple Silicon Xcode tools.
All paths must be absolute and build/install must be outside the source tree.
Uses shared LGPL-2.1-or-later libraries, system zlib, local-file I/O and software
decoding. Produces build evidence; clean-machine and media acceptance are separate.
EOF
}
while (($#)); do
    case "$1" in
        --source|--build-dir|--install-dir|--jobs)
            (($# >= 2)) || fail "missing value for $1"
            case "$1" in
                --source) source_dir=$2 ;;
                --build-dir) build_dir=$2 ;;
                --install-dir) install_dir=$2 ;;
                --jobs) jobs=$2 ;;
            esac
            shift 2 ;;
        --configure-only) configure_only=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || fail '--jobs must be a positive integer'
for path in "$source_dir" "$build_dir" "$install_dir"; do
    [[ "$path" == /* ]] || fail 'all directories must be absolute'
done
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail 'requires native Apple Silicon macOS'
for tool in git python3 xcrun make otool lipo; do
    command -v "$tool" >/dev/null || fail "missing required build tool: $tool"
done
[[ -d "$source_dir/.git" ]] || fail 'source must be an isolated Git clone'
source_dir=$(cd "$source_dir" && pwd -P)
[[ $(git -C "$source_dir" rev-parse HEAD) == "$expected_commit" ]] || fail 'source does not match pinned FFmpeg 8.1.2'
[[ -z $(git -C "$source_dir" status --porcelain) ]] || fail 'source checkout contains changes; use a clean clone'
canonical_path() { python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$1"; }
build_dir=$(canonical_path "$build_dir")
install_dir=$(canonical_path "$install_dir")
# Reject both ancestor and descendant overlap before creating any directories.
python3 - "$source_dir" "$build_dir" "$install_dir" <<'PY'
from pathlib import Path
import sys
paths = [Path(p) for p in sys.argv[1:]]
for i, left in enumerate(paths):
    for right in paths[i + 1:]:
        if left == right or left in right.parents or right in left.parents:
            sys.exit('FFmpeg build: source, build and install directories must not overlap')
PY
compiler=$(xcrun --find clang)
cxx_compiler=$(xcrun --find clang++)
sdk_path=$(xcrun --sdk macosx --show-sdk-path)
mkdir -p "$build_dir" "$install_dir"
rm -f "$build_dir/build-info.json" "$build_dir/build-info.json.tmp"
export MACOSX_DEPLOYMENT_TARGET="$deployment_target"
args=(
    "--prefix=$install_dir" --arch=arm64 --target-os=darwin
    "--cc=$compiler" "--cxx=$cxx_compiler" "--host-cc=$compiler" "--sysroot=$sdk_path"
    "--host-cflags=-isysroot $sdk_path -mmacosx-version-min=$deployment_target"
    "--host-ldflags=-isysroot $sdk_path -mmacosx-version-min=$deployment_target"
    "--extra-cflags=-mmacosx-version-min=$deployment_target"
    "--extra-ldflags=-mmacosx-version-min=$deployment_target"
    '--extra-ldexeflags=-Wl,-rpath,@executable_path/../lib'
    '--extra-ldsoflags=-Wl,-rpath,@loader_path'
    --install-name-dir=@rpath --enable-shared --disable-static
    --disable-gpl --disable-nonfree --disable-version3 --disable-autodetect
    --enable-zlib --disable-network --disable-avdevice --disable-hwaccels
    --disable-videotoolbox --disable-audiotoolbox
    --disable-ffplay --disable-doc --disable-debug --disable-stripping
)
{
    printf 'source_commit=%s\ndeployment_target=%s\narchitecture=arm64\n' "$expected_commit" "$deployment_target"
    sw_vers
    "$compiler" --version
    xcrun --sdk macosx --show-sdk-version
    printf 'configure_command='
    printf '%q ' "$source_dir/configure" "${args[@]}"
    printf '\n'
} > "$build_dir/build-environment.txt"
cd "$build_dir"
"$source_dir/configure" "${args[@]}" 2>&1 | tee configure.log
$configure_only && exit 0
make -j "$jobs" 2>&1 | tee build.log
make install 2>&1 | tee install.log
mkdir -p "$install_dir/share/licenses/ffmpeg"
cp "$source_dir/COPYING.LGPLv2.1" "$source_dir/LICENSE.md" "$install_dir/share/licenses/ffmpeg/"
python3 "$repo_root/scripts/macos/verify_ffmpeg_build.py" \
    --install-dir "$install_dir" --build-dir "$build_dir" \
    --source-commit "$expected_commit" --deployment-target "$deployment_target"
printf 'Built FFmpeg/FFprobe: %s\nEvidence directory: %s\n' "$install_dir/bin" "$build_dir"
