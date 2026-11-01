# Rebuilding the native engine inputs

This directory preserves the repository layout of the build recipes, Python
modules, path configuration, patches and runtime-prefix policy. Run commands
from this directory. Flat copies elsewhere under `provenance/packaging/`,
`provenance/build/` or `provenance/build-brush.sh` are evidence snapshots;
execute the copies under `scripts/macos/` here.

The scripts do not install native tools. A build requires an Apple Silicon Mac,
Xcode command-line tools, Python 3 and Git. COLMAP also requires CMake, Ninja and
the exact dependency inputs recorded in its provenance. Brush requires the
recipe's Rust 1.95.0 toolchain and the recorded Cargo inputs. The repository's
application toolchain is separate.

Check the delivered entry points without compiling or downloading anything:

```bash
python3 scripts/macos/pack-engines.py --help
python3 scripts/macos/pack_licenses.py --help
python3 scripts/shared/engine_paths.py --key ffmpegBuild
bash scripts/macos/build-ffmpeg.sh --help
bash scripts/macos/build-colmap.sh --help
bash scripts/macos/build-brush.sh --help
```

The upstream source trees and dependency archives are separate from these
recipe inputs. Use each engine's `provenance/source-identity.json`,
`provenance/source.tar`, original build metadata, lockfiles and package/source
evidence to reconstruct its exact inputs. Native scripts require isolated Git
checkouts at their pinned commits; `source.tar` preserves tracked/patched files
but is not Git metadata. Reconstruct the detached checkout and verify the
delivered source and patch before building. Brush's excluded LPIPS data is not
part of the delivered source archive; its distribution policy remains explicit.

With those inputs prepared in this directory's `work/` tree, the native entry
points are:

```bash
bash scripts/macos/build-ffmpeg.sh --source "$PWD/work/sources/ffmpeg"
bash scripts/macos/build-colmap.sh --alpha-profile \
  --source "$PWD/work/sources/colmap" --deps-prefix "$PWD/work/colmap-deps"
bash scripts/macos/build-brush.sh --distribution-patch "$PWD/work/sources/brush"
```

Prepare the exact Conda package cache and dependency prefix separately from
their recorded package evidence; `colmap-m0-deps.explicit.txt` is the historical
development lock, not proof of a new distribution build. Build outputs default
to the fresh `native/` paths in `packaging/shared/engine-paths.json`. Imported
build evidence is kept in separate directories and must not be used as a fresh
build destination.

For a new pack, pass all fresh source, build, install, Conda and immutable Brush
artifact paths explicitly to `pack-engines.py` using its options above. Its
defaults identify imported local evidence, which is not included by merely
copying this recipe tree. Select a new output path and pack version. The pinned
runtime-prefix policy matches exact original source binaries and must be
re-audited for independently rebuilt bytes; do not change its hashes to bypass
that check. Building a new candidate does not grant release approval or replace
the preserved alpha.6 pack.
