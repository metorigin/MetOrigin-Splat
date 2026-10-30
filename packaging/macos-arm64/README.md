# macOS arm64 engine pack

`scripts/macos/pack-engines.py` builds a local engine candidate from pinned native
artifacts. `scripts/macos/verify-pack.py` checks the finished bytes. The runtime is
kept in the ignored `target/distribution/macos-arm64/engines` directory.

The active full-app input is Brush `.6`, engine manifest SHA-256
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.
Its engine audits and engine-only distribution/relocation checks are complete,
subject to application acceptance. The latest full application is `a2146f95` /
`build.OX71fC`, with verified app/DMG bytes and a complete application license
collection. Earlier `.6` builds have native generation evidence, including the
311-image workload and Chinese/space paths; those results retain their original
build identities. The latest candidate has bounded Spark display, exit and
project-integrity evidence, while memory stability and complete M3/M4 acceptance
remain open. This is an internal Alpha, without Developer ID/notarization or
clean macOS 15 / 16 GB / Windows acceptance.
See the [current package and validation status](../../docs/validation/macos-engine-pack.md).
The earlier runtime-admission and version-preflight failures remain historical
records; the builder now checks both gates before packaging.

```text
macos-arm64/
  engines/
    engine-manifest.json              # schema 1, all final file hashes
    ffmpeg/{bin,lib,licenses,provenance}/
    colmap/{bin,lib,licenses,provenance}/
    brush/{bin,licenses,provenance}/
  release-status.json                 # bound to the exact manifest SHA-256
  engines-verification.json
  verification/latest-relocation-report.json
```

Each engine's `provenance/audit.json` records exact licenses, source locators,
package/archive checksums, delivered notices and unresolved evidence.
`provenance/sbom.spdx.json` is its SPDX 2.3 inventory. `source.tar` identifies the
actual local source by the manifest's `source_sha256`; `source-identity.json`
records the base commit and patch. It is not a hash of a remote URL's response.
Cargo `.crate` archives are checked against Cargo.lock. Conda source archives are
checked against the exact rendered binary-package recipe, with recipe patches
preserved separately.

The independent FFmpeg engine is 8.1.2 with GPL/nonfree/version3 disabled. COLMAP's
OpenImageIO closure separately includes a GPLv3 FFmpeg 9 build and other copyleft
libraries. The two sets are isolated in their respective `lib` directories.
COLMAP must never be described as BSD-only. The Alpha COLMAP build disables
LSD, CGAL, MVS and downloads; the original M0 evidence remains under `licenses/`.
The Alpha runtime still includes GPL/LGPL dependencies and their obligations.

Brush `.5` introduced the exclusion of LPIPS dependencies and the embedded model;
active `.6` retains this policy and removes the default Rerun/logging notice gaps.
The patched-source archive omits `crates/lpips/burn_mapped.bpk`, `apple.png` and
`pear.png`; their licensing provenance is not established. The default build does
not require them. See [LPIPS audit](../../integrations/brush-macos/LPIPS-AUDIT.md).

## Build and verify

Use an independent COLMAP build directory so the original SfM evidence remains
reproducible. The following is the historical `.5` recipe: its
`brush-build-final` and `0b057872...` artifact paths must not be described as
active `.6` inputs. For the promoted `.6` identity and completed relocation,
see the [active pack record](../../docs/validation/macos-engine-pack.md#active-6-pack-and-relocation).

```sh
bash scripts/macos/build-colmap.sh --alpha-profile \
  --source "$PWD/target/macos-m0/colmap" \
  --build-dir "$PWD/target/macos-m4/colmap-build" \
  --install-dir "$PWD/target/macos-m4/colmap-install" \
  --deps-prefix "$PWD/target/macos-m0/colmap-deps" \
  --dependency-sources "$PWD/target/macos-m0/colmap-build/_deps" --jobs 3

python3 scripts/macos/pack_brush_licenses.py \
  --source target/macos-m4/brush \
  --tree target/macos-m4/brush-build-final/evidence/cargo-target-tree.txt \
  --cargo-home target/macos-m0/cargo-home \
  --output target/macos-m4/brush-license-audit

python3 scripts/macos/pack-brush-notices.py \
  --evidence target/macos-m4/brush-license-audit \
  --cargo-home target/macos-m0/cargo-home

python3 scripts/macos/pack-engines.py \
  --brush-artifact target/macos-m4/brush-artifacts/0b0578720e6e131cb64f2436012f014cab64d01b20fc1c59d7ad082fd295df86 \
  --brush-evidence target/macos-m4/brush-license-audit \
  --source-cache target/macos-m4/source-cache

python3 scripts/macos/verify-pack.py target/distribution/macos-arm64/engines --relocate
python3 scripts/macos/verify-pack.py target/distribution/macos-arm64/engines --require-distributable
```

`--require-distributable` checks the exact engine pack's release status; it fails
when that status has unresolved blockers. The active `.6` engine pack passed this
gate, which does not grant application or public-release acceptance. Existing
pack destinations are never overwritten. Select a new `--output` when
regenerating evidence.

## Closure and verification rules

The builder recursively resolves actual Mach-O load commands, copies canonical
library files, and rejects libraries outside the declared input prefixes.
Every non-system load is rewritten to an engine-local `@loader_path` reference.
All LC_RPATH commands are removed. Files must be arm64-only, target macOS, and
declare minimum OS ≤15.0. Only `/usr/lib/` and `/System/Library/` remain external.
All mutations happen before ad-hoc signing and final hashing. Original artifact
hashes are checked again after packing.

Several transitive libraries have optional plugin/config/data defaults compiled
against the developer Conda prefix. Schema 2 of `runtime-prefix-fields.json` pins
11 original library hashes and 27 NUL-terminated field offsets, lengths and hashes,
plus the prefix length/hash and every prefix offset within each field. It records
no private path literals. The postprocess reads the reviewed bytes from the exact
original binary, checks field boundaries/hashes and every prefix span, and rejects
missing, overlapping or out-of-bounds spans before writing any bytes.
The postprocess disables only these reviewed fields using equal-width replacement
before load-command rewriting and signing; diagnostic/configure strings are left
intact. Each original, rewritten and signed hash is recorded in
`provenance/embedded-prefix-rewrites.json`, and the exact postprocess code/spec is
shipped in `provenance/packaging/`. Unknown binary identities or changed fields
fail closed. Runtime support is the tested offline JPEG/PNG SfM flow; HEIC,
optional external codecs, font catalogs and dynamically discovered plugins are
not claimed supported by this pack.

The verifier rejects unsafe paths, case-insensitive duplicates, symlinks,
undeclared files, hash mismatches, missing dependencies, invalid signatures and
nonconforming Mach-O metadata. The relocation check copies every byte to a new
Chinese/space path, verifies separate inodes and every hash, then runs with an
empty PATH, a fresh HOME and no DYLD variables. It executes version/help checks,
CPU PNG decoding/probing and real CPU COLMAP feature extraction; no shell wrapper
or global dependency installation is used.

These are same-host checks. A clean macOS 15 machine without the development
prefixes, native application acceptance, Developer ID signing/notarization and Gatekeeper
acceptance remain separate release evidence. Ad-hoc signatures only establish
local load integrity.

## Full application candidate

`bash scripts/macos/build-macos-app.sh --internal-alpha` verifies the selected
engine and application-license manifests, builds the app, ad-hoc signs only its
outer bundle, verifies the final embedded bytes, then creates and verifies a
uniquely named DMG. The final report must match the first signed-app report's
executable and full bundle inventory hashes. Embedded engines are never
re-signed or silently re-hashed by this step.

Before building the app, the script also runs the production Rust release
resolver against the selected pack without an integrity cache or engine
execution. To run this explicit integration check separately with the configured
Rust 1.97 toolchain:

```sh
METORIGIN_TEST_ENGINE_PACK="$PWD/target/distribution/macos-arm64/engines" \
METORIGIN_TEST_ENGINE_MANIFEST_SHA256=590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40 \
  cargo test --locked --target aarch64-apple-darwin -p splat-hardware --lib \
    locator::tests::frozen_macos_engine_pack_resolves_without_execution \
    -- --ignored --exact --nocapture
```

The following gate uses the same application's PendingWork-protected adapter and
version checks, including FFprobe and the complete Brush build identity:

```sh
METORIGIN_TEST_ENGINE_PACK="$PWD/target/distribution/macos-arm64/engines" \
METORIGIN_TEST_ENGINE_MANIFEST_SHA256=590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40 \
  cargo test --locked --target aarch64-apple-darwin -p splat-desktop --lib \
    commands::system::tests::frozen_macos_engine_pack_passes_application_version_checks \
    -- --ignored --exact --nocapture
```

It executes version/help probes only, requires zero pending work afterward and
does not run UI, Metal or training. Either gate failing stops the full build.
macOS COLMAP `-h` uses a 45-second execution deadline for first-path startup;
all other synchronous probes retain ten seconds. Both use the fixed 64 KiB
capture limit and the same process cleanup, with one attempt and no retry.
This deadline excludes spawn and cleanup wall time. The
[prior ten-second gate failure](../../target/macos-m4/release-package-preflight-fixed-20261027.g7bvscrt/failure-summary.json),
[bounded startup measurements](../../target/macos-m4/colmap-startup-timing-20261027.sr9c71c6/timings.json)
and [new physical-path application gate](../../target/macos-m4/colmap-help-budget-20261027.fTRuYP/summary.json)
are retained; the last result is same-host evidence, not cold-host acceptance.

The current complete internal Alpha run is
[release-package-colmap-budget-20261027.tof2i_g1](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/acceptance-summary.json).
The script ran from the beginning and exited 0 after both real prebuild gates,
frontend/release compilation, outer ad-hoc signing and exact read-only DMG
verification; see [build.07osYS/final.json](../../target/macos-m4/app-verification/build.07osYS/final.json).
Its app executable SHA-256 is
`8656d4e02678cd6d2f30fb92a2c19a26a5ef38ada8af93cb3f93b9b0bb9d03a3`;
the [new DMG](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.07osYS.dmg)
is 659,933,464 bytes with SHA-256
`77e5c8e411873037e64d8cb4e988377788a7b393a197a99262cbb4bc99402bf0`.
All 363 source fingerprints, frozen manifests and seven license-build inputs
remained unchanged. Native application and external release acceptance remain
separate gates.

The historical runtime-fixed run is recorded in
[release-package-runtime-fixed-20261027.j7gwp494](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/acceptance-summary.json),
with the actual prebuild Rust gate and
[build.PPc41I/final.json](../../target/macos-m4/app-verification/build.PPc41I/final.json).
The complete script exited 0, but subsequent native version preflight rejected
that candidate; its preserved DMG SHA-256 is:
`852180d7ba7de5d712f95abef9244494bd10c4502cc86f6f1e22be2f5c803d4b`.

The historical restoration-fixed run is recorded in
[release-package-restored-20261027.15oy4nui](../../target/macos-m4/release-package-restored-20261027.15oy4nui/acceptance-summary.json);
the script-generated report is
[build.M4Le6Y/final.json](../../target/macos-m4/app-verification/build.M4Le6Y/final.json).
It finished from the beginning with exit 0 and no manual continuation, but later
failed native runtime admission; it is not an accepted app candidate. That
DMG SHA-256 is
`54f132601ca10815070d9010ed6312c6be5b2f446a257369ab7597635ba08d17`.

This is internal Alpha packaging integrity evidence. Native release execution,
the 311-image balanced load, clean macOS 15/16 GB acceptance, Windows regression,
Developer ID/notarization and public application-license clearance remain open.
The [restore/export rejection](../../target/macos-m4/release-package-20261027.o90SDO/candidate-status-known-restore-export-bug.json),
[native runtime rejection](../../target/macos-m4/release-package-restored-20261027.15oy4nui/candidate-status-runtime-fat-rejection.json)
and [application version rejection](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/candidate-status-application-version-rejection.json),
plus all original app/DMG evidence sets, are preserved unchanged.

## Sources and redistribution evidence

Use `pack_licenses.py` to regenerate the audit from the actual library closure,
then `pack_sources.py AUDIT --cache DIR --copyleft-only` to acquire exact source
archives. The downloader never extracts or executes remote content. Failed
downloads retain their URLs and errors, and checksum mismatches are not accepted.
`--mirrors packaging/macos-arm64/source-mirrors.json` adds public mirror locations
without changing any expected archive hash.
`--source-cache` copies only hash-verified archives into a new pack and updates
component status. Keep exact patches, configuration, notices and a rebuild route
along with the sources. LGPL libraries remain replaceable standalone dylibs.

Do not infer release readiness from a package's declared license alone, from a
URL pointing to upstream, or from the existence of a Conda binary lock. Review
the actual component evidence and resolve every manifest-bound release blocker.
