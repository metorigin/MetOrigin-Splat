# macOS arm64 engine pack validation

Validated on 2026-10-27 and 2026-10-28, native arm64, macOS 27.0.1. This is same-host relocation
evidence, not acceptance on a clean macOS 15 machine.

The latest complete package is the 2026-10-28 `a2146f95` application and
`build.OX71fC` DMG. It adds version-pinned Three OrbitControls registration-root
cleanup while preserving the Spark sort-disposal and resource-ownership fixes.
The [package receipt](../../target/macos-m4/orbit-controls-root-fix-20261028/acceptance-summary.json)
binds the app/DMG, 597 matching recorded source inputs and a 729-listed-file
license collection with zero findings. The subsequent six-pair native Spark/Home
run has 13 independently reviewed visual checkpoints, normal quit action,
all eight observed process instances absent with ESRCH and 439 unchanged project
files. The [native closeout](../../target/macos-m4/native-orbit-root-cycles-20261028/native/closeout.json)
and independent resource audit are complete; memory stability remains unproven.
Pressure and swap are unknown throughout the 460-sample run because their sysctl
reads were denied. M3 memory, M4 and public release acceptance remain false. Earlier
`ee0f0bea`/`6a5c7be6` resource findings and `0f85` image-export results retain
their original builds and scope; they are not replaced by passing module tests.

A later [VM-category diagnostic](../../target/macos-m4/native-orbit-category-20261028/native/closeout.json)
used this unchanged a214 package and completed six Spark/Home pairs. All 490
pressure samples were normal; system swap used stayed at 1460.38M. Its 13 visual
checkpoints, eight-instance exit and 439-file integrity evidence passed
independent review. WebContent growth is narrowed to categories, not causal
owners. This was a diagnostic, with no new production edit, build, broad test,
DMG remount or acceptance pass. The executable was rehashed after exit and still
matches a214; the original package report continues to bind the DMG. See the
[category findings](macos-m3-resources.md#2026-10-28-unchanged-release-vm-category-diagnostic).

Historical pre-rebuild artifact check (2026-10-28): the `ee0f0bea` Release `.app`
was no longer present at its build output path, cause unknown. At that check,
the `build.Lotfbt` DMG remained and its SHA-256 matched `0ee24a97…`; no app
restoration or rebuild was performed as part of that check. The later `a2146f95`
build below is separate. Earlier package receipts remain historical evidence. The temporary
`478f67f4` developer census app is not a replacement Release candidate. See
[artifact status](../../target/macos-m4/native-retention-census-20261028/native/release-artifact-status.json)
and the [completed bounded retention diagnosis](macos-m3-resources.md#2026-10-28-developer-census-and-orbitcontrols-root-mismatch).

## 2026-10-28 a214 OrbitControls root cleanup package

Application SHA-256 is `a2146f9544baf9dde30c4dbfd43371b296796b3c41c2495822024998175251c8`;
bundle inventory is `9a3d7029283ec463a7e84b21a20bdf9906ebb7be6fdf1608bf7005dbf842d2df`.
The [final verification](../../target/macos-m4/app-verification/build.OX71fC/final.json)
binds `MetOrigin-Splat-release-590102d22902-build.OX71fC.dmg`, SHA-256
`3f2ce450159bd3f264cf454f3970da7069a893e8ad449d9f0ddb2fec2db33b0f`.
The complete internal-Alpha builder exited 0; read-only DMG mounting, matching
bundle and final signatures passed. This remains ad-hoc signed, with Developer
ID and notarization unaccepted. The engine manifest remains
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.

The Three 0.185.1 patch saves the root where OrbitControls registered listeners
and removes both Control-keydown and pending keyup listeners from that root,
including after DOM detachment, disposal or reconnect. Its only dependency
runtime change is `examples/jsm/controls/OrbitControls.js`. The patch SHA-256 is
`4765f6245907ce0a33d47d041a912c0990b064d6688648d93266369f5cc0f5ef`;
the installed derived file is
`90198b33aff15d9ae8da304dbfe4940d5b85157077ddd2ce1c81cfd06a8805b2`.
Actual-module regressions changed from 2 passed / 16 failed on the original to
18 passed on the installed derivative. Four unchanged real-React teardown
cases also changed from failed to passed. These establish the listener-cleanup
mechanism, not its native byte contribution or memory acceptance.

The [consolidated gates](../../target/macos-m4/orbit-controls-root-fix-20261028/gates.json)
record fresh 296 frontend tests in 36 files, 60 Spark checks, 39 Three checks
(18 lifecycle plus 21 provenance), typecheck, lint, the complete app/DMG build
and two frozen-pack runtime prechecks. The standalone 18 and React 4 regressions
are included in the full suites and must not be counted twice. Rust 738 passed /
15 ignored plus fmt/Clippy, and 36 schema outcomes, are historical results reused
within reviewed input scope. Toolchain/cache/environment equivalence is not
independently proven, and schema reuse does not claim strict identity of every
broad metadata input.

The before-gates, after-gates and after-build snapshots contain the same 597
source records. They have no embedded capture timestamps; equality is verified,
while temporal bracketing is parent-observed. Spark and Three installed-input
identities match the build's before/after reports. The license manifest is
`d711098f7ef5d87086b728cf9c243dc46ceb58dee28eb1cd4ef5a203dd0d1e07`,
with 729 listed files and zero issues, including Three's MIT notice and local
derivation evidence. The [independent package review](../../target/macos-m4/orbit-controls-root-fix-20261028/independent-package-review.json)
passed 66 offline receipt/log checks without rescanning or rebuilding the bundle.

The subsequent [native operator record](../../target/macos-m4/native-orbit-root-cycles-20261028/native/root-native-observation.json)
records six Spark/Home pairs. The [independent visual review](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-native-visual-review.json)
checked all 13 original JPEG/AX captures and all 26 payload identities. Each
Spark capture shows 614,263 Gaussians and recognizable shoes/carpet; each return
shows the project center, without a current error, modal or open editor. The
normal CUA ⌘Q action was followed by ESRCH for all eight observed process
instances. Collector exit was 0; the application's OS exit code is unknown.
The 439 project files / 1,047,169,524 bytes were unchanged.

The [resource summary](../../target/macos-m4/native-orbit-root-cycles-20261028/native/resource-summary.json)
records 460 samples. All system-pressure and swap observations are unknown
because the corresponding sysctl reads were denied; they must not be reported
as normal pressure or zero swap. The [independent resource assessment](../../target/macos-m4/native-orbit-root-cycles-20261028/native/independent-resource-audit.json)
recomputes the statistics without mismatches, but does not establish stability:
Home footprint is nonmonotonic while Home RSS continues increasing in steps.
The [post-native package status](../../target/macos-m4/orbit-controls-root-fix-20261028/post-native-acceptance.json)
binds the frozen closeout. `m3_memory_accepted=false`, `m4_accepted=false` and
`public_release_ready=false` remain in force. The immutable package summary
retains native-pending as its creation-time fact. This run did not exercise
editing/saving, training, Inspector/forced GC, induced pressure, context loss,
Dock/minimize, offline Finder or user-deferred true sleep, and transfers no
earlier native acceptance to this executable.

## 2026-10-28 ee0f Spark resource ownership package

Application SHA-256 is `ee0f0beaae735811eaee41c068204e434d1208a4422afc1e7e2704fd9a65d1cd`;
bundle inventory is `84ccd5742214e77710c74f329c240147cd2ef4c2c36132bc79dfc6715a1a638f`.
The [final verification](../../target/macos-m4/app-verification/build.Lotfbt/final.json)
binds `MetOrigin-Splat-release-590102d22902-build.Lotfbt.dmg`, SHA-256
`0ee24a97cfd2ffc0858b03c28a7d839ff803a191cf0bcd96cb789f03236aa617`.
Read-only mounting, bundle equality and final signatures passed. The app is
ad-hoc signed; Developer ID, notarization and public distribution remain open.
The engine manifest remains unchanged at
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.

The [gates](../../target/macos-m4/spark-resource-ownership-fix-20261028/gates.json)
record fresh 58 Spark checks (14 lifecycle, 27 resource ownership, 17 provenance),
292 frontend tests, typecheck, full lint, production frontend build and two
runtime prechecks. Rust 738 passed / 15 ignored plus fmt/Clippy, and 36 schema
checks, are historical results reused through reviewed input bindings, not
fresh reruns. Schema reuse does not claim strict identity of every broad input.
All 589 bound source inputs, including the patch and 118 overlay files, matched
before the checks and after the build. The license manifest is
`1664a91001e6e4a7958f6c79927fb912c9a4e775c7f9747ca0997ad634d25fea`.

The previous `6a5c7be6` app was preserved separately, as was its DMG. No earlier
native result transfers to this new executable. See the [resource correction
and test boundaries](macos-m3-resources.md#2026-10-28-renderer-resource-ownership-patch-awaiting-native-retest).

The subsequent [native closeout](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/closeout.json)
records six Spark/Home pairs at 614,263 Gaussians, 13 original captures and
438 complete resource samples with normal system pressure. Final Home lasted
129.859 seconds (65 complete samples); WebContent footprint remained above
baseline, so memory acceptance is still false. CUA returned `App quit` after
normal ⌘Q and all eight observed process identities were absent with ESRCH;
the application's OS exit code is unknown, separate from collector exit 0.
The 439 project files / 1,047,169,524 bytes were unchanged. See the [native
resource result and comparison limits](macos-m3-resources.md#2026-10-28-ee0f-native-spark-only-closeout-with-retention-unresolved).
The immutable package receipts retain native-pending as their creation-time
fact. This bounded result does not transfer prior generation/edit/save/export
acceptance or establish a causal leak or controlled improvement over `6a5`.
At that closeout, the later-diagnosed OrbitControls mechanism was still unrepaired.
The subsequent `a2146f95` production patch and bounded native retest are recorded
above; they do not retroactively change this `ee0f0bea` result.

## 2026-10-28 6a5c Spark lifecycle package

Application SHA-256 is `6a5c7be6e3f40130779674ab1903374da7f9ef4def2ecca5794786a3b7458b8f`;
bundle inventory is `22637a0820bbc3530d1d84037c10b1eaf34a3d0a918a907ffa885185f9f855d2`.
The [final verification](../../target/macos-m4/app-verification/build.Vw47qp/final.json)
binds DMG SHA-256 `b11f5700f1185e8f4fbd340d76a88c2613b3b7e4825c484beaae4635010d945c`,
read-only mounting, matching bundle and valid signatures. The engine manifest
remains `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.
The two frozen-pack runtime prechecks and production frontend build ran afresh;
587 source inputs and the installed Spark derivation matched before/after.
The [gates](../../target/macos-m4/spark-lifecycle-fix-20261028/gates.json) distinguish
fresh frontend/Spark/schema checks from reused Rust results. A first preflight
attempt was stopped to correct a local path in the new license evidence; the
successful package uses the corrected collection. No native result, minimum-OS,
clean-host, Windows or public-distribution acceptance is added by this build.
The earlier candidate sections below retain their historical identities and scope.

The subsequent [native closeout](../../target/macos-m4/native-spark-lifecycle-cycles-20261028/native/closeout.json)
binds 13 loaded captures, six clean cycles, a 142.856-second Home dwell, eight
observed process identities absent after normal Cmd+Q, and 439 unchanged project
files. Attributed WebContent footprint still grows across cycles; M3 memory
remains unaccepted. The immutable packaging receipt keeps its original pending
state and is supplemented by this separately recorded result.

## Application version preflight repair

The `2968a3a9...` candidate passed resource admission but was rejected by native
application preflight. Its pinned and reported Brush versions were both
`brush-cli 1.0.0+metorigin-macos.6`; the old matcher compared the whole pin against
separated numeric tokens. A separate generic FFprobe scanner could select the
compiler's `21.0.0` version from command output instead of FFprobe's `8.1.2`.

Version matching now ignores tool prefixes and an optional leading `v`, while
preserving explicitly pinned `+`, `-` and `_` build identities. `.5`, `.60`,
extra build suffixes and numeric `8.1.20` do not match the selected `.6` or
`8.1.2` pins. Plain numeric pins retain FFmpeg distribution-suffix and Windows
Brush 0.3 compatibility. FFprobe detection now uses the existing FFmpeg adapter's
version parser; unknown/empty versions fail the check.

The full builder runs two explicit Rust gates before compiling the app: resource
resolution, then the production application's PendingWork-protected adapter and
version checks. Both use the selected manifest digest, Release resolution and
no integrity cache. The application gate executes only engine version/help
probes; it does not run Tauri UI, Metal or training, and requires the pending-work
count to return to zero. The actual embedded frozen pack failed before the
FFprobe repair and passed afterward, including the complete Brush `.6` identity.

Evidence: [version-matcher checks](../../target/macos-m4/runtime-version-match-20261027.EyOLWd/summary.json),
[production application before/after checks](../../target/macos-m4/runtime-app-version-20261027.dLXFpv/summary.json)
and [actual passing adapter/version output](../../target/macos-m4/runtime-app-version-20261027.dLXFpv/runtime-after.log).
Hardware tests passed 32 with one ignored real-pack check; focused application
tests passed 10 with one ignored real-pack check; FFmpeg adapter tests passed 5.
The separately invoked real-pack checks passed, and fmt plus all-target,
all-feature Clippy passed. Packaging tests passed 24, including either gate
failing before packaging can begin. Frozen engines, manifest/license hashes and
production dependency inputs remain unchanged.

The first complete build after those parser repairs stopped before Tauri because
the application gate exceeded COLMAP's original ten-second help-probe deadline.
Its [failed run](../../target/macos-m4/release-package-preflight-fixed-20261027.g7bvscrt/failure-summary.json)
retains exit 101 and created no app or DMG. Six bounded, serial measurements on
the active pack and two new Chinese/space paths recorded first calls of 25.265,
16.923 and 9.601 seconds, with immediate repeats of 0.071, 0.073 and 0.075 seconds.
See [timing evidence](../../target/macos-m4/colmap-startup-timing-20261027.sr9c71c6/timings.json).

Only macOS COLMAP `-h` probes now receive a 45-second, single-attempt execution
deadline. The default ten seconds, fixed 64 KiB capture limit, process-scope
cleanup, cleanup grace periods and failed-cleanup registry remain unchanged.
There is no automatic retry; the deadline does not include spawn and cleanup
wall time. Process tests passed 57, COLMAP tests passed 127, and focused Clippy
and formatting checks passed. A full, physically copied pack at a new
Chinese/space path then passed the real application gate: all three checks were
available/resource/valid, with no integrity cache and zero pending work.
[Fresh-path gate evidence](../../target/macos-m4/colmap-help-budget-20261027.fTRuYP/summary.json)
records 83.80 seconds for the whole test, including complete pack hashing. No
engine was pre-executed at that path and no OS cache was purged; this is same-host
evidence, not cold-host acceptance.

A new complete build with both prebuild gates passed as recorded below. Native
release UI, Chinese/space-path execution, 311-image balanced load and the external
release gates remain unaccepted by this packaging record. The previous candidate's
[version-preflight rejection](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/candidate-status-application-version-rejection.json)
and original evidence are preserved.

## Historical internal Alpha candidate: application preflight passed

The new `release-package-colmap-budget-20261027.tof2i_g1` run completed the entire
builder from the beginning with exit 0 and no manual continuation. It used Rust
1.97.0, Node 22.23.2, pnpm 11.12.0, two Cargo jobs and deployment target 15.0.
The actual resource locator and application adapter/version gates each executed
one passing test before Tauri, using all 2,999 files of the selected frozen pack
with no integrity cache. The application reported FFmpeg 8.1.2, COLMAP 4.1.0 and
`brush-cli 1.0.0+metorigin-macos.6`, all available/resource/valid, and zero pending
work. FFprobe is validated within the FFmpeg application check.

| Current artifact / identity | Path or SHA-256 |
| --- | --- |
| App | [MetOrigin Splat.app](<../../target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app>) |
| App executable | `8656d4e02678cd6d2f30fb92a2c19a26a5ef38ada8af93cb3f93b9b0bb9d03a3` |
| Complete bundle inventory | `6bebd19a3f770c3f60ce1af796bac26da3e3e05b16159f735a69dc4541baf188` |
| DMG | [MetOrigin-Splat-release-590102d22902-build.07osYS.dmg](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.07osYS.dmg), 659,933,464 bytes |
| DMG SHA-256 | `77e5c8e411873037e64d8cb4e988377788a7b393a197a99262cbb4bc99402bf0` |

The app contains 3,618 regular files totaling 1,019,635,576 bytes. Initial and
final signed-app hashes match; the read-only mounted DMG contains the exact same
file hashes, permissions and internal symlink targets, with strict deep signature
verification. Only the outer app was ad-hoc signed. All 363 captured source files,
the three frozen manifests and seven application-license build inputs remained
unchanged. The three historical rejected apps/DMGs and the failed pre-Tauri run
were independently rechecked and preserved. No app was launched by the packaging
agent; this candidate still requires native and external acceptance.

Evidence: [acceptance summary](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/acceptance-summary.json),
[full build log](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/build.log),
[resource gate](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/runtime-engine-locator.log),
[application gate](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/runtime-application-preflight.log),
[final report](../../target/macos-m4/app-verification/build.07osYS/final.json),
[source fingerprint](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/source-fingerprint.json),
[bundle inventory](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/bundle-inventory.json),
[historical artifact audit](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/historical-artifact-audit.json)
and [checksums](../../target/macos-m4/release-package-colmap-budget-20261027.tof2i_g1/SHA256SUMS.txt).

## Runtime admission repair and rejected historical candidate

Native preflight of the restoration-fixed `f7eb82fd...` app rejected
`colmap/lib/libgcc_s.1.1.dylib` before any engine resolution or Metal probe.
The frozen file is a valid `MH_DYLIB` (type 6), not `MH_DYLIB_STUB`: its fat
header contains exactly one ARM64_ALL slice at offset 16,384, size 162,976,
alignment 2^14. Python's `lipo`/`otool` inspection accepted this layout, while the
old Rust runtime validator assumed every file had a thin header at offset zero.

The runtime now accepts thin arm64 files or a standard big-endian fat32/fat64
container with exactly one ARM64_ALL slice. It checks the outer and inner CPU
and subtype, table separation, slice size and checked end bounds, alignment,
fat64 reserved field, and the inner `MH_EXECUTE`/`MH_DYLIB` type. Multi-architecture,
arm64e, stub, swapped-fat, truncated and malformed files remain rejected. Frozen
engine bytes, engine manifests, Cargo dependencies and application license
inputs were not changed.

The [repair diagnosis and native header evidence](../../target/macos-m4/runtime-macho-admission-20261027.2SWM5E/diagnosis.json)
retains the original resolver failure and the successful fix. Hardware tests
passed 29 with one explicitly ignored integration check; hardware Clippy passed.
The actual frozen pack and the rejected app's embedded copy each passed the
public Rust `EngineLocator` in Release mode without an integrity cache: all 2,999
files verified, all four logical engines resolved from resources, no engines
executed. See [frozen pack](../../target/macos-m4/runtime-macho-admission-20261027.2SWM5E/runtime-frozen-pack-after-fix.log)
and [embedded pack](../../target/macos-m4/runtime-macho-admission-20261027.2SWM5E/runtime-embedded-pack-after-fix.log)
logs. The focused packaging suite now passes 24 tests, including real Bash
success/failure propagation for the runtime gate.

The full builder now runs that exact Rust resolver check before Tauri compilation,
with explicit pack and manifest inputs, `--locked`, the arm64 target and no cache.
A failure stops packaging. The complete runtime-fixed build finished with exit
0 on 2026-10-27 at 06:31 UTC, including that actual Rust check, frontend/release
compilation, outer ad-hoc signing, unique DMG creation, read-only mount and strict
signature/inventory acceptance. It used Rust 1.97.0, Node 22.23.2 and two Cargo
jobs; no manual continuation was needed.

| Archived runtime-fixed artifact / identity | Path or SHA-256 |
| --- | --- |
| App | [MetOrigin Splat.app](<../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/historical-app/MetOrigin Splat.app>) |
| App executable | `2968a3a986d71e5c8f647b38e6e4fee6b69cc7e2a5eb5910e584e99683cb3ee3` |
| Complete bundle inventory | `b6a0598455dfc4222819cf5f28d6622701275b8cd39ed7cb88eeb24fbcb07445` |
| DMG | [MetOrigin-Splat-release-590102d22902-build.PPc41I.dmg](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.PPc41I.dmg), 659,918,135 bytes |
| DMG SHA-256 | `852180d7ba7de5d712f95abef9244494bd10c4502cc86f6f1e22be2f5c803d4b` |

That historical bundle contains 3,618 regular files totaling 1,019,614,024 bytes. Its
initial/final app hashes and read-only mounted inventory match, all 363 captured
source hashes remained unchanged through the build, and the frozen engine and
application-license manifest hashes remain `590102d2...bc40` and
`7de8b1ee...f2df` respectively (full values are listed in the reports).

Evidence: [acceptance summary](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/acceptance-summary.json),
[full build log](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/build.log),
[Rust resolver gate](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/runtime-engine-locator.log),
[script-generated final report](../../target/macos-m4/app-verification/build.PPc41I/final.json),
[source fingerprint](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/source-fingerprint.json),
[bundle inventory](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/bundle-inventory.json)
and [SHA256SUMS](../../target/macos-m4/release-package-runtime-fixed-20261027.j7gwp494/SHA256SUMS.txt).

This candidate passed packaging integrity and runtime resource admission, then
failed native application version preflight as described above. It did not pass
the 311-image balanced workload. It and the two earlier rejected apps/DMGs remain
preserved and must not be reused as accepted application evidence. All
clean-host, minimum-OS, hardware, Windows and public-release gates remain open.

## Restoration-fixed historical candidate: native preflight rejected

On 2026-10-27 at 06:08 UTC, the complete
`bash scripts/macos/build-macos-app.sh --internal-alpha` run finished with exit
code 0. It used Rust 1.97.0, Node 22.23.2, two Cargo jobs, deployment target 15.0
and `CARGO_PROFILE_RELEASE_STRIP=none`. This run rebuilt the frontend and Rust
release app, sealed the outer app with an ad-hoc signature, created a new DMG,
mounted it read-only, verified its app and detached it. No manual continuation or
application launch was used for this run.

This candidate passed packaging integrity, then **failed native engine preflight**
as described above. The 311-image balanced workload did not start. The earlier successful
debug restoration check used development Brush `.5`; its result does not stand
in for those release checks.

| Artifact / identity | Path or SHA-256 |
| --- | --- |
| Archived restoration-fixed app | [MetOrigin Splat.app](<../../target/macos-m4/release-package-restored-20261027.15oy4nui/historical-app/MetOrigin Splat.app>) |
| App executable | `f7eb82fd1221b22e98e8021a66767c50a99b6007e36b2e933f7446233ddf8549` |
| Complete bundle inventory | `c02029fc34e2867c29d827d3ad6ce5b380b0d13636aab5294adcc337aecb0ae2` |
| Archived restoration-fixed DMG | [MetOrigin-Splat-release-590102d22902-build.M4Le6Y.dmg](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.M4Le6Y.dmg), 659,967,926 bytes |
| DMG | `54f132601ca10815070d9010ed6312c6be5b2f446a257369ab7597635ba08d17` |
| Embedded engine manifest | `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40` |
| Embedded application license manifest | `7de8b1ee0ffceda57eea3408c97432237c5f0164cd4b160a5482a6b2ab19f2df` |

The initial and final signed app reports have identical executable and bundle
inventory hashes. All 3,618 regular app files (1,019,612,408 bytes), including
2,999 declared engine files and 612 application license files, were checked.
The DMG's app has exactly the same file hashes, modes and internal symlink targets
as the initially verified app; strict deep signature verification passed. The
source app was checked again after DMG inspection. All 363 fingerprinted source
files remained unchanged through the build and final verification.

Retained local evidence (under ignored `target/`):

- [Acceptance summary](../../target/macos-m4/release-package-restored-20261027.15oy4nui/acceptance-summary.json)
  and [candidate scope](../../target/macos-m4/release-package-restored-20261027.15oy4nui/CANDIDATE_STATUS.md).
- [Complete build log](../../target/macos-m4/release-package-restored-20261027.15oy4nui/build.log),
  [environment](../../target/macos-m4/release-package-restored-20261027.15oy4nui/environment.json),
  and [script-generated final report](../../target/macos-m4/app-verification/build.M4Le6Y/final.json).
- [Bundle inventory](../../target/macos-m4/release-package-restored-20261027.15oy4nui/bundle-inventory.json),
  [source fingerprint](../../target/macos-m4/release-package-restored-20261027.15oy4nui/source-fingerprint.json),
  and [SHA256SUMS](../../target/macos-m4/release-package-restored-20261027.15oy4nui/SHA256SUMS.txt).
- [Prebuild debug restoration evidence and scope](../../target/macos-m4/release-package-restored-20261027.15oy4nui/prebuild-authorization-context.json).
- [Subsequent native-preflight rejection](../../target/macos-m4/release-package-restored-20261027.15oy4nui/candidate-status-runtime-fat-rejection.json).

The full builder supports macOS Bash 3.2 empty-array expansion, signs only the
outer app for explicit internal Alpha builds, and never deep-signs the frozen
engines. Its final verifier binds both app hashes to the initial signed-app
report and rejects source-app changes during DMG inspection. The focused verifier
regression suite passed 23 tests; three Bash 3.2 argument cases and shell syntax
checks passed before this unchanged script's successful complete run.

### Rejected historical application candidate

The earlier `release-package-20261027.o90SDO` candidate passed packaging
integrity but was subsequently **rejected for final functional acceptance**.
Native restoration testing found a new 149,219-point checkpoint while
`output/scene.ply` still held the previous 155,469-point export (SHA-256 prefix
`d4279`): resetting downstream states alone had allowed stale Export cache reuse.
The corrected build above follows the restore-artifact invalidation and UI
completion-route fixes; it must still pass its own release-native workload.

The rejected candidate's [archived app](<../../target/macos-m4/release-package-20261027.o90SDO/historical-app/MetOrigin Splat.app>)
has executable SHA-256
`3cecdc5933df9fe1af73e5446ead88de59a87013f4ee0b6bf693488faae37afb`.
Its [historical DMG](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-release-package-20261027.o90SDO.dmg)
remains unchanged at SHA-256
`a34674585b563087769f12f1f9a0a92544ac1061a02feabb8ca061ca9cae0f5f`.
The [rejection record](../../target/macos-m4/release-package-20261027.o90SDO/candidate-status-known-restore-export-bug.json),
original reports and hashes are preserved. A passed integrity check does not
override this functional rejection.

### Remaining application and release gates

The `.6` release app's Chinese/space-path execution and 311-image balanced native
run remain pending. Clean-machine installation/runtime/uninstall, actual macOS
15, 16 GB hardware, Windows regression for these changes, Developer ID signing,
notarization and Gatekeeper acceptance are not passed by this packaging run.
Ad-hoc signature integrity passed; publisher identity and public-distribution
approval did not. Application license evidence still lists five unresolved
categories, detailed in [application license evidence](macos-app-licenses.md).
Configured CI is not evidence that its jobs executed.

## Archived `.5` candidate

- Pack: `target/distribution/macos-arm64-archive-macos5-1a257513a680-20261027T045148Z/engines`
- Manifest SHA-256: `1a257513a6806775a620a28c837d7079cafc44a1105793ba58624fedc93579d6`
- 3,890 declared files; 1,009,510,195 bytes including corresponding-source archives.
- 123 arm64 Mach-O files: 4 executables and 119 dylibs.
- COLMAP closure: 113 dylibs, down from 125 in the original M0 build.
- Remaining Mach-O minimum OS declarations: 11.0 and 15.0; none exceed 15.0.
- Every non-system dylib load uses an engine-local `@loader_path` reference;
  no LC_RPATH remains. Every Mach-O file passes strict ad-hoc signature validation.

| Executable | SHA-256 after relocation/signing |
| --- | --- |
| `ffmpeg/bin/ffmpeg` | `254cf3ef679ff627d027ef4537d3c8c9663c1764338b7ac64679c5f4b647e723` |
| `ffmpeg/bin/ffprobe` | `75fb210106cbd57d05a63a8c16c4fab25ed115beaa0fda0cb6fe179145b13f2b` |
| `colmap/bin/colmap` | `bfd28a4abfc6aad219fbe73e0cc065277604cfa5bdfe68d762c14164478c5443` |
| `brush/bin/brush` | `17058bf9949f46d190a4f15b505a14a123bf84093b1b5ef25e07f62954daef63` |

The original development binary hashes are retained in each engine's
`provenance/relocation-map.json` and were checked again after packaging. Signing
changes hashes; application profiles must use the manifest's final hashes.

## Actual relocation execution

The pack was physically copied to
`target/distribution/macos-arm64-archive-macos5-1a257513a680-20261027T045148Z/verification-portable/引擎 重定位 y5a9v9_j/完整 引擎`.
Every copied file has a separate inode and the same declared hash. Children ran
with empty PATH, a fresh HOME and no DYLD variables.

All 14 commands passed: FFmpeg/FFprobe/Brush version, Brush/COLMAP help, six
required COLMAP command helps, FFmpeg CPU PNG decode, FFprobe image metadata,
and CPU COLMAP feature extraction. The generated 512×512 PNG produced one
database image and 1,447 SIFT keypoints using two CPU threads and
`FeatureExtraction.use_gpu=0`. Logs, exact argv, timing and database evidence are
in `verification/latest-relocation-report.json` and its referenced directory.

The Alpha COLMAP build disables LSD, CGAL, MVS and downloads. Required SIFT,
matching, mapping, global mapping and undistortion command contracts passed.
After identifying compiled optional runtime paths, 27 exact reviewed
NUL-terminated fields in 11 libraries were neutralized with equal-width changes;
source-file hashes, field hashes, offsets, original text, transformed text and
final signatures are retained. Diagnostic/configure strings were not rewritten.
Only the tested offline JPEG/PNG flow is supported; optional external plugins,
HEIC codecs, font catalogs and network configuration are outside this evidence.

The transformed, physically relocated runtime then completed the full CPU SfM
flow on 40 locked JPEG photos, each carrying EXIF: 21.013 s feature extraction,
23.674 s exhaustive matching, 24.692 s incremental mapping and 17.959 s
undistortion. All 40 photos registered, yielding 36,903 sparse points, 188,047
observations and 0.520474 px mean reprojection error. The database's camera has
`prior_focal_length=1`, confirming the EXIF focal prior was read. The source photos
were unchanged; 45 normalized dataset files were produced. Full commands and
logs are under `verification-portable/CPU 全链路 JPEG EXIF`, with a compact
`verification/cpu-sfm-summary.json` bound to the final manifest hash.

## License/source evidence and distribution gate

The pack contains per-engine SPDX 2.3 inventories and full evidence audits.
COLMAP has 89 inventoried components and 83 actual Conda runtime package owners.
Brush's locked arm64 normal/build Cargo graph has 619 components; it includes
build dependencies and is not a symbol-level inventory. All Cargo source
archives and git revisions were checked against their locked identities.

All 23 distinct required copyleft upstream archives passed the exact recipe
SHA-256 checks; the cached PoseLib and FAISS source archives were also verified
and delivered. Exact recipes, patches, notices, native build configuration and
main-engine patched source archives accompany the binaries. Final source delivery
is recorded for 30 COLMAP component records, with shared archives deduplicated.

The independent FFmpeg 8.1.2 is LGPL-2.1-or-later. COLMAP's separate OpenImageIO
closure includes a GPLv3 FFmpeg 9 build, x264/x265 and SuiteSparse GPL components.
The exact GCC source proves that bundled libquadmath has an LGPL-2.0-or-later
grant; the broader libgcc package's runtime-exception label alone is insufficient.
The original M0 AGPL LSD and CGAL GPL code are excluded from the Alpha build.

Brush `.5` excludes LPIPS weights from its binary and the default dependency
graph. Its source archive omits the unprovenanced BPK and two LPIPS test images.
The binary distribution policy and detailed LPIPS audit are included.

`release-status.json` is bound to the final manifest digest. It permits internal
Alpha validation and has `distributable: false` because complete MIT notices for
`hex-slice 0.1.4` and `indicatif-log-bridge 0.2.3` remain unavailable. Their declared
licenses, author metadata and complete locked sources are preserved; no copyright
statement was invented. `verify-pack.py --require-distributable` rejects this
candidate and checks the manifest-hashed audits as well as the status flag.

Clean macOS 15 validation, app resource integration, Developer ID signing,
notarization and Gatekeeper acceptance remain separate app/release evidence.

## Script verification

Eleven focused packing tests cover Mach-O parsing, minimum OS, architecture,
unresolved/escaped dependencies, path traversal, symlinks, case-insensitive
collisions, file tampering, undeclared files, scoped literal rewrites and SPDX
expression preservation. Fifteen COLMAP recipe/CLI contract
tests pass, including the Alpha feature flags. Python compilation and diff checks
pass. Network failures were retried with recorded, checksum-preserving mirrors;
downloads were never executed or globally installed.

See [pack recipe](../../packaging/macos-arm64/README.md),
[frozen Alpha source index](../../packaging/macos-arm64/alpha-source-index.json),
and [distribution status schema](../../packaging/macos-arm64/release-status.schema.json).

## Post-freeze packaging review

The frozen `.5` audit linked `objc2-foundation` to two `copying.rs` files, which
implement/test NSCopying and are not legal notices. The collector now excludes
ordinary source files. Corrected `.6` evidence instead uses the upstream root
`LICENSE.md` from exact published Git revision
`7b1abfd750a2cacaea71d6a56ecfb83cb7de560b`, proved by the checksum-verified
crate's VCS metadata. This text was already physically present for sibling crates
in the frozen `.5` pack; the old frozen bytes and audit are retained unchanged.

The full app builder now verifies the signed app before creating a uniquely
named DMG, mounts that new image read-only, compares its complete app inventory
(file hashes, modes and internal symlink targets), and verifies the embedded app
again. Critical executable/engine/evidence paths cannot be symlinks. Both engine
and application license manifests are bound to the selected build inputs.
Developer ID re-signing that changes engine bytes fails the frozen manifest check;
the app builder never rewrites trusted engine hashes. Release strip is disabled
because Xcode 27 stripping corrupts Rust proc-macro LINKEDIT metadata (E0463).

A tiny native DMG creation/verification/read-only mount/copy comparison/detach
smoke passed earlier on this host, including a Chinese filename with a space.
Its app signature phase used a test stub; it remains disk-image workflow evidence
only. The corrected candidate above now supplies actual app-signature and
full-pack embedding evidence. Native app and clean-host acceptance remain
separate. The full overlay also includes separate application notices;
see [application license evidence](macos-app-licenses.md). Engine evidence is not
application public-release approval.

## Active `.6` pack and relocation

The verified `.6` pack is now the full-overlay input at
`target/distribution/macos-arm64/engines`. Its original candidate is preserved at
`target/distribution/macos-arm64-v6/engines`; the complete former `.5` directory
was renamed into the single archive above, including release status and prior
validation evidence. Both old and new manifest hashes are unchanged; the active
root contains `promotion-record.json` with the exact paths and status hashes.
Its manifest SHA-256 is
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.
It contains 2,999 declared files (976,917,925 bytes), with the same 123 Mach-O
files. FFmpeg/FFprobe/COLMAP executable hashes remain the values listed above;
Brush's final relocated/signed hash is
`f8fb8784d394e224f9057243bbb6e1f33039ea34063ec8fa91c339853c144e1c`.

Brush `.6` disables native Rerun in the default target and replaces the missing
notice logging bridge with a project implementation. Its actual locked arm64
normal/build graph has 382 components and excludes `hex-slice`,
`indicatif-log-bridge` and the Rerun/video dependency chain. Nineteen omitted
package notices were recovered from already frozen original texts, with matching
package source/manifest hashes; the `objc2-foundation` correction also verifies
the published crate's exact VCS commit. The pack finalizer checks the artifact's
lockfile and target-graph digests, all source/notice hashes, and includes the
actual patched workspace before marking its audit complete.

`verify-pack.py --require-distributable --relocate` passed. Its physical copy at
`target/distribution/macos-arm64-v6/verification/引擎 重定位 496_iood/完整 引擎`
ran all 14 version/help/decode/probe/CPU-feature commands with empty PATH,
fresh HOME and no DYLD variables. It produced 1,447 keypoints; report:
`target/distribution/macos-arm64-v6/verification/latest-relocation-report.json`.
This is same-host evidence. New `.6` Metal training/live and full app acceptance
are tracked separately from this packaging check. The earlier full CPU SfM
exercise used identical final FFmpeg/COLMAP runtime binary hashes.

All three engine audits now have zero issues and the new manifest-bound status
is `evidence-complete`, explicitly subject to application signing and acceptance.
Application license evidence remains separate and incomplete. Before the final
application-verifier additions, the full Python script suite passed 119 tests,
including 19 packing and 21 application-verifier checks. The later focused
application suite passed 23 checks as recorded above; this is not a claim that
the full suite was rerun with a different total.

The shared project lock now holds a standard-library kernel file lock on the
persistent `.lock.guard` inode while publishing owner metadata with `create_new`.
Stale cleanup is serialized and bounded; corrupt files and symlinks are rejected,
and release never deletes changed owner metadata. Two independent-process tests
(8 contenders each) cover initial acquisition and stale recovery. The 14 lock
checks and all 126 pipeline library tests pass, as does pipeline Clippy with
warnings denied. These checks do not build or modify the running app.

## Final UI-fix candidate, 2026-10-27

The complete `build-macos-app.sh --internal-alpha` workflow passed with the
COLMAP progress, sparse-preview timing, CPU interval sampling and final-model
loading-label fixes. Its receipt is
`target/macos-m4/release-package-final-ui-20261027.qfrqdgun/acceptance-summary.json`.
All 443 frozen source/configuration/fixture inputs remained unchanged through
the build. The receipt binds the 697-passed/14-ignored Rust gate and the
189-passed frontend gate, including their source fingerprints.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `006cfe46d2d319f414be08d24d56f3a95a2909742b113c736c1cb4d93d6ea7ac` |
| Complete bundle inventory | `c5841dfc086a780056d0d61f58e55bb2d449ee743969f8251ec47bc4769c7271` |
| DMG | `bc319b0a75222e8c8428eaf2da712aecd18f363782930a1627bb50346a38d455` |

The DMG is
`target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.p0sKlz.dmg`
(659,992,776 bytes). The arm64 app declares minimum macOS 15.0, contains 3,618
regular files and uses ad-hoc signing. Strict signature checks, read-only DMG
mount, complete embedded/source bundle equality, and unchanged source-app
verification passed. The real release-mode locator and application-version
gates separately passed without integrity-cache reuse; neither runs GPU
training. The frozen `.6` engine and application-license manifests remain the
ones recorded above.

The first complete attempt in `release-package-final-ui-20261027.97o__j9a`
failed at `hdiutil create` with “Device not configured”; its failure receipt and
app were retained. A fresh complete run with disk-image service access passed;
the failed attempt was not resumed or counted as packaging success. This does
not establish a general cause for every such `hdiutil` error.

Native video, offline-core and path acceptance for this exact candidate are
tracked separately. The earlier `8656d4e0` candidate's successful 311-photo
native training is not transferred to this binary. Minimum-OS, actual 16 GiB,
clean-host and Windows checks remain unavailable on the current machine.
Application-license review still has five open issues; Developer ID,
notarization and public distribution are not approved. This artifact remains
an internal Alpha candidate, and M4 remains open.

Subsequent checks bound to this candidate passed all 36 schema fixture cases
(14 accepted and 22 correctly rejected) across eight CI-equivalent commands.
The independent receipt is under
`target/macos-m4/final-gates-20261027/schema-gates/run-091339Z-kqcu16gm/`;
the original packaging receipt and test totals remain unchanged. Its embedded
engines also passed the process-level offline core smoke recorded in
[M1 validation](macos-m1.md).

Native testing then found that the project wizard incorrectly accepted a
non-writable destination during preflight; actual project creation safely
failed without changing source media. See the
[native reproduction](macos-native-ui.md). This candidate therefore remains
incomplete for native acceptance, and the correction requires a new package.

## Destination-write-preflight candidate, 2026-10-27

The complete `build-macos-app.sh --internal-alpha` workflow passed again after
the destination preflight correction, from the beginning in 247.65 seconds with
exit code 0. Its immutable receipt is
`target/macos-m4/release-package-preflight-write-20261027.b_afu7_0/acceptance-summary.json`
(SHA-256 `6adf9be45e21441d5cae51f9887b19f847c90849149548d4f95344aa1f2771c5`).
All 444 selected source/configuration/fixture inputs remained unchanged through
the build. Fifty gate-evidence files are hash-bound, and the final 23-entry
checksum list passed a separate read-only recheck.

The receipt binds the new Rust gate at
`target/macos-m4/final-gates-20261027/rust-readonly-cht95y_4/summary.json`:
705 passed, zero failed and 14 ignored across 16 targets, with formatting and
Clippy checks also passing. The normalized frontend receipt at
`target/macos-m4/destination-preflight-fix-20261027/frontend-gates-summary.json`
records 190 passed and zero failed across 32 files, plus passing typecheck,
lint, build and diff checks. The prior schema receipt under
`target/macos-m4/final-gates-20261027/schema-gates/run-091339Z-kqcu16gm/`
was rebound by verifying its 52 current inputs and evidence hashes; its eight
command groups cover 36 cases, with 14 accepted, 22 correctly rejected and zero
unexpected failures. Schema execution was not repeated for the desktop-only
correction. These totals come from the supplied receipts and their logs, not
from the preceding candidate's totals.

The correction performs a real exclusive write/sync/close/delete probe in the
selected directory or its nearest existing ancestor. Eight new destination
regressions pass, including the Unix `0555` destination and missing-child case
as non-root UID 501, successful cleanup, failed-write cleanup and collision
preservation. This is automated evidence for the fix. Native regression testing
of the rebuilt app by the main validation task is in progress at this addition;
no native outcome is assigned here.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `bb13a6ee182b825216b05e7f98fe121f33a3fc319e34e2b3ef25d7e275300ded` |
| Complete bundle inventory | `5a0c637181b53257a55849a65a0ddcc059b7f02744ef6c852fbfbbc5cb8fb664` |
| DMG | `e8d4c07df80cc337e0bda0dca66ae38ada9da02fcf63c3267e2b42dfce0f9adf` |

The active app is
`target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app`.
Its arm64 bundle declares minimum macOS 15.0 and contains 3,618 regular files
(1,019,656,296 bytes), with ad-hoc signing. The new DMG is
`target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.Hzxy7t.dmg`
(659,986,214 bytes). Strict signature checks, read-only DMG mount and complete
source/embedded bundle equality passed. The real release-mode locator and
application-version/help gates passed without integrity-cache reuse; pending
work returned to zero and no GPU/training work ran during packaging.

The `006cfe46` app was copied with an exact inventory match to
`target/macos-m4/release-package-preflight-write-20261027.b_afu7_0/previous-candidate/MetOrigin Splat.app`
before rebuilding. Its original receipt and DMG, and the older `8656d4e0`
copies, mounted app, DMG and receipts, remain unchanged. Their native results
are not transferred to `bb13a6ee`.

A separate read-only binding at
`target/macos-m4/offline-core/new-package-engine-binding-bb13.json`
compares this app's four engine executables and manifest to the `006cfe46`
offline-core record. The earlier
`target/macos-m4/offline-core/core-source-check-after-destination-fix.json`
already records that all 105 core dependency inputs were unchanged. This
establishes byte/source continuity with the existing process-level offline
evidence; no offline engine test was repeated and it does not establish native
offline UI acceptance for the new app.

The engine manifest remains
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`,
and the application-license manifest remains
`7de8b1ee0ffceda57eea3408c97432237c5f0164cd4b160a5482a6b2ab19f2df`.
All five application-license issues are unchanged. This remains an internal
Alpha candidate: native video, readonly/NFC-NFD path behavior, CPU/progress/
preview/editor flows, quit/warm start and checkpoint restoration still require
results for this exact app. Clean macOS 15, an actual 16 GiB host, clean-install,
Windows regression, Developer ID and notarization/Gatekeeper acceptance remain
unverified. Public distribution is not approved, and M4 remains open.

## Restore-preview-invalidation candidate, 2026-10-27

The complete `bash scripts/macos/build-macos-app.sh --internal-alpha` workflow
passed from the beginning in 233.22 seconds, finishing at
2026-10-27 10:24:28 UTC with exit code 0; it was not resumed. The immutable
[packaging receipt](../../target/macos-m4/release-package-restore-preview-20261027.ru8gww0c/acceptance-summary.json)
has SHA-256
`1a81727e3d2723f45c9f8b9eeaaec1dc720b7cf0b70f21918a23ae4907bd7e92`.
Only `ProjectDetailPage.tsx` and its test changed relative to the `bb13a6ee`
candidate: restoring a checkpoint now releases the old GPU preview when its
`scene.ply` is invalidated. Regression coverage also retains the normal
missing-output → Export → completed → published-preview flow.

All 444 selected source/configuration/fixture inputs remained unchanged during
the build and still matched at the independent audit. The separate
[read-only evidence audit](../../target/macos-m4/release-6784-independent-audit-20261027.w77tyg22/independent-audit.json)
(SHA-256 `2a1284ca5de3d6b07e2eb465b5ee51b6dbd8abdb4d473297c60ae9b185d7cb13`)
passed all 26 checksum entries, checked 55 gate-evidence hashes, recomputed the
complete current bundle inventory, and bound the current DMG bytes to the
production script's existing mounted-validation record. This independent audit
did not repeat mounting, signature tests, application tests or native UI work.

The new
[frontend gate](../../target/macos-m4/restore-preview-invalidation-20261027/frontend-gates-summary.json)
(SHA-256 `d94cb860af600b6e20eea9ea3d59e826db112f6299cdb1720fd5e62a79326647`)
passed 195 tests across 32 files, including 49 focused regression tests, with
zero failures. Typecheck, lint, build and diff checks passed; the existing Vite
large-chunk warning remains. The Rust gate was reused after verifying all 235
recorded inputs and evidence hashes: 705 passed, zero failed and 14 ignored
across 16 targets, with formatting and Clippy passing. The schema gate was
reused after verifying its 52 inputs and evidence hashes: eight command groups,
36 cases, 14 accepted, 22 correctly rejected and zero unexpected failures.
Rust and schema execution were not repeated for this frontend-only correction.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `6784872d00056769cb4bd0c0f9e672b6c70ca46642b18e68120c568f08063919` |
| Complete bundle inventory | `9d84ed389860eb28eba662e71756f87c90e27d19d64857238172e43d891b4ec3` |
| DMG | `3f29dbafd734ca0999323cf699ee4d45dab5d1e8980ac08a43134cd6f08727b0` |
| Engine manifest | `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40` |
| Release status | `e734ad9dbbecd280e76a7f3db634998d2e94bd0b920aaae96cfca5417440acb4` |
| Application-license manifest | `7de8b1ee0ffceda57eea3408c97432237c5f0164cd4b160a5482a6b2ab19f2df` |

The app is
`target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app`.
Its arm64 bundle declares minimum macOS 15.0 and contains 3,618 regular files
(1,019,656,296 bytes), with ad-hoc signing. The new DMG is
`target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.T831yD.dmg`
(659,973,309 bytes). During the complete production build, strict signature
verification, read-only DMG mounting, full source/embedded inventory equality
and unchanged source-app checks passed. The real release locator and
application-version/help probes passed for the 2,999 embedded engine files,
without integrity-cache reuse: FFmpeg 8.1.2, COLMAP 4.1.0 and Brush
`1.0.0+metorigin-macos.6` resolved from resources with valid integrity and no
diagnostic. Pending work returned to zero; packaging ran no GPU/training work.

The
[core continuity record](../../target/macos-m4/release-package-restore-preview-20261027.ru8gww0c/unchanged-core-new-package-binding.json)
binds the new app's four engine executables and manifest to the previous
`006cfe46` process-level offline-core evidence through the `bb13a6ee` binding.
All 105 core dependency inputs are unchanged. This establishes source and byte
continuity; no offline-core test was rerun, and it does not establish native
offline UI acceptance for the new app.

Before rebuilding, the `bb13a6ee` app was preserved with an exact inventory
match at
`target/macos-m4/release-package-restore-preview-20261027.ru8gww0c/previous-candidate/MetOrigin Splat.app`.
The packaging receipt records preservation checks for the historical receipts,
DMGs and four earlier app copies. Prior 311-photo, video, editor and other native
results remain bound to their original builds and do not automatically transfer
to `6784872d`.

At this record's creation, native acceptance for this exact candidate remains
pending, including the restored-checkpoint stale-preview regression. The main
validation task is testing its separately copied app; those outcomes must be
recorded separately. The five application-license issues remain open:
`binary-and-vendored-completeness`, `supersplat-webp-provenance`,
`unicode-data-license`, `supersplat-static-asset-grants` and
`missing-license-texts`. This remains an internal Alpha candidate. Actual
macOS 15, an actual 16 GiB host, clean-install/runtime/uninstall and Windows
regression acceptance remain unverified. Developer ID signing, notarization and
Gatekeeper acceptance are unverified; public distribution is not approved, and
M4 remains open.


### 6784 后续原生复测范围

打包收据生成时的 native pending 状态保留为当时事实；之后该候选完成了原生恢复预览专项，详见 [原生桌面记录](macos-native-ui.md)及 `target/macos-m4/native-preview-invalidation-20261027/native-ui-result.json`。旧导出画面失效后清除、保留检查点显示、2500→3000 warm start、实时帧和最终自动渲染均已观察；最终 79,741 高斯，checkpoint/scene SHA `25a71896679dc0aff25538122f786fba9222e4e30fbb057f9a942fbe2a3f2ee9` 一致。这里只补充明确执行的专项，完整 M4 与外部环境验收仍未完成。

## 2026-10-27: video display rotation and stale-frame recovery candidate

The next internal Alpha fixes signed FFprobe display-matrix rotation and
revalidates completed frame extraction under an explicit execution profile.
Obsolete frame plans now trigger the existing durable invalidation journal and
rebuild dependent stages. The source delta contains five Rust files; project
and frame schemas, engine bytes, frontend and schemas are unchanged.

The complete workspace gates passed with **716 tests passed / 15 ignored**,
plus fmt and Clippy. The opt-in real-video rotation test was separately executed:
all 11 angle cases matched FFmpeg's own autorotation pixels and dimensions.
Scaled-frame validation retains measured JPEG dimensions because FFmpeg aspect
ratio rounding can differ from the plan's bounding box. It does not impose a
new exact-size contract on scaled frames. Frontend 195 tests and 36 schema cases
remain bound by unchanged input fingerprints. The earlier offline-core result
is **not transferred**, because core sources have changed.

The first attempt stopped at fmt before building; the single file was formatted
for the workspace's Rust 2021 edition. A separate second attempt ran all gates
and the complete production build from the start, with no resumed steps. Its
build took 274.102 seconds and exited 0. All 445 selected inputs were unchanged
through verification and packaging. The prior `6784872d` app was copied and
inventory-verified before replacement; historical results retain their original
candidate identity.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `cfba918efdb73a09e48a905dde03b465e14e82f73041850aa49a9a7ac60863af` |
| Complete bundle inventory | `77cb1ce0af1ce8cd5cec612dbce169e78f2d2a632946ba7869acc0d9dc96bd11` |
| DMG | `10b0293ad62baf7a9a2d1a840cc840fa88ba689137eb5e322914721b9b5d131e` |
| Build receipt | `7b792d58ada55b488316789940f9b3ebd7f64c84e92cb03c1e805745281eabe0` |
| Independent audit | `5f1b5d07ec6a8ed9c20b5c0ec08a0ba7d1a2ee5d1668f0564be2cf22c09daa8e` |

The [receipt](../../target/macos-m4/release-package-video-rotation-20261027-attempt02/acceptance-summary.json)
binds the app to
`MetOrigin-Splat-release-590102d22902-build.QFKaj3.dmg`. The complete build passed
resource-based engine resolution/version checks, strict signatures, read-only
DMG mounting and exact embedded-bundle comparison. A separate
[audit](../../target/macos-m4/video-rotation-package-audit-20261027/audit-result.json)
checked the current app, DMG and source/evidence bindings without rerunning
engines or mounting the DMG again. The bundle is arm64, declares macOS 15.0,
and remains ad-hoc signed. Its five public-license issues and external-platform
acceptance requirements are unchanged. At receipt creation, native recovery
acceptance is pending and must be recorded separately.

## 2026-10-27: bounded frame-thumbnail candidate

The `cfba918e` application also displayed 12 broken frame images after a normal
LaunchServices launch, as recorded in the
[normal-launch reproduction](../../target/macos-m4/native-thumbnails-normal-20261027/reproduction-summary.json).
The frame view used `convertFileSrc` although the release build had no enabled
asset protocol. The fix returns bounded JPEG data URLs through the existing
frame-preview command. It validates project identity and canonical containment,
rejects linked frame directories/files, checks a 64 MiB file limit and
64 × 1,024 × 1,024 pixel limit before decoding, and sequentially encodes at most
12 uniformly selected frames with a 360-pixel longest edge. The command runs
blocking image work off the async runtime. The frontend uses the encoded image's
actual dimensions, invalidates previews when the frame manifest changes or
disappears, ignores obsolete responses, and avoids decoding again on unrelated
polls. The existing `image` workspace dependency is now a direct desktop
dependency. Pipeline, pressure handling, project schemas and engine bytes are
unchanged; the complete source delta is eight files.

The [focused regression record](../../target/macos-m4/cli-adapter-comparison-20261027/thumbnail-fix-draft/verification/summary.json)
preserves one intended Rust failure and four intended frontend failures on the
old behavior, followed by five Rust and 49 focused frontend passes. A prior
Corepack sandbox failure occurred before tests and is retained as a tooling
failure. The complete frozen-source gates passed with **721 Rust tests / 15
ignored** and **198 frontend tests in 32 files**, plus fmt, Clippy, TypeScript
and ESLint. The unchanged schema inputs remain bound to the earlier 36-case
schema receipt. All 445 selected source files stayed unchanged through gates
and the full production build, which ran from the start and exited 0.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `4e763b5864705fd0c91fa5a63a547cb4119552e4a6c9a6113f017ba40a17ef3d` |
| Complete bundle inventory | `243fae560b63c8bef480477f4f434b1707ccfcfd49ed4b5826cc7ff34c57f587` |
| DMG | `8985a59031979d0faf27112ae6cb5eeaf7701256b94f0c787838e7bd868a1ad6` |
| Build receipt | `d9597996ed30a9785dec8711319e46f8be7e01953b34a4be9aa022b8ff1e3587` |
| Independent package audit | `84934e63194d723a88595902088d1c35e727b4be90f6c658edcd04b1f2315fbe` |
| Application-license manifest | `d6c37a1aab1c09b40eadacf5351432d59f0b3963f1a38d5102bdd232c2d84b75` |

The [build receipt](../../target/macos-m4/release-package-thumbnails-20261027/acceptance-summary.json)
binds the bundle to
`MetOrigin-Splat-release-590102d22902-build.9Kumca.dmg` and the
[final build verification](../../target/macos-m4/app-verification/build.9Kumca/final.json).
The complete build verified resource-based engine resolution/version probes,
strict signatures, a read-only DMG mount and exact embedded-bundle equality.
The separate [package audit](../../target/macos-m4/thumbnail-package-audit-20261027/audit-result.json)
passed 9,661 checks, independently hashing source, evidence, both complete
4,751-entry bundles and the DMG bytes. All 3,782 engine-directory entries,
including 2,999 regular engine files, match the archived `cfba918e` bundle.
The audit did not rerun engines, tests, signing commands or DMG mounting.
The prior app is preserved at
`target/macos-m4/release-package-thumbnails-20261027/previous-candidate/MetOrigin Splat.app`;
its original inventory and receipt still match.

The [license refresh](../../target/macos-m4/app-license-evidence/thumbnail-refresh-20261027/summary.json)
regenerated the 612-file license evidence against the new Cargo inputs. Its
component set and versions are unchanged; the sole graph change adds the
desktop-to-`image@0.25.10` edge. All five unresolved issues remain verbatim:
`binary-and-vendored-completeness`, `supersplat-webp-provenance`,
`unicode-data-license`, `supersplat-static-asset-grants` and
`missing-license-texts`. The previous license tree is archived separately.

The immutable build receipt's `native_acceptance=pending` describes its creation
time. The subsequent [native thumbnail record](../../target/macos-m4/native-thumbnails-fixed-20261027-summary.json)
binds the same `4e763b58` executable and inventory to 12 upright loaded thumbnails
and switching back to the 651,384-Gaussian final view, both under a normal
LaunchServices launch and a separate process-level network denial. The 122
frame/output files were unchanged. This is read/view validation of existing
`cfba918e` output, not a new generation run; generation and earlier offline-core
claims retain their original app identities. See [native UI validation](macos-native-ui.md)
for network-attribution limits. The new arm64/macOS-15.0-minimum artifact remains
an ad-hoc-signed internal Alpha. Developer ID, notarization, clean-host,
actual macOS 15, actual 16 GiB and Windows acceptance remain open, as does M4.

## 2026-10-27: d91c COLMAP diagnostic-only candidate

The next internal Alpha changes only
`crates/splat-engine-colmap/src/feature.rs` and
`crates/splat-engine-colmap/src/matching.rs` relative to `4e763b58`.
Empty or partial feature extraction and missing verified matches now retain
actionable Chinese diagnostics, observed database counts and suitable next
steps through UI localization. Error codes, retryability, reconstruction
decisions, thresholds, parameters, dependencies and engine bytes are unchanged.
Eight SQLite-based regression tests cover the diagnostic paths and preserved
error metadata. The [focused test receipt](../../target/macos-m4/native-mixed-input-20261027/diagnostic-fix-validation-20261027/targeted-test-receipt.json),
SHA-256 `b5d4e0dbdad0d2724a42e5af824c373df272db35a394af7252f0e078e7bf273c`,
records 146 COLMAP tests and seven domain-error tests passing, with Cargo.lock
unchanged. Root reviewed the recorded two-file diff before the complete build.

The newly executed workspace gates passed with **729 Rust tests / 15 ignored**,
zero failures, fmt and strict Clippy. They used the local Rust 1.97.0 toolchain,
two build jobs, locked offline Cargo resolution and
`CARGO_PROFILE_RELEASE_STRIP=none`.
**198 frontend tests**, ESLint and TypeScript checks were explicitly reused from
the successful `4e763b58` evidence after matching all 205 selected desktop and
package inputs. The **36 schema cases** were reused after matching their
52 frozen inputs and prior successful logs. These checks were not rerun or
reported as new executions. The [reuse receipt](../../target/macos-m4/release-package-colmap-diagnostics-20261027/reused-gates.json),
SHA-256 `317b1d4c3ce4cfb7c8080057b4f78bd29ed5c1c8d6bbe1048baf78dba5a9b6ef`,
records the exact bindings. Tauri still rebuilt the production frontend assets
needed by the new application.

All 445 selected production inputs remained unchanged through the gates and
packaging; the only differences from the preceding package freeze are the two
diagnostic files above. The complete `build-macos-app.sh --internal-alpha`
workflow ran from the start, without resumed steps, in 274.916 seconds and
exited 0. Its separate opt-in checks passed real release-mode resolution of
all 2,999 engine files without an integrity cache and the application's actual
adapter/version preflight. Those two checks are additional to the 729-test
workspace count and do not establish a native UI or Metal training result.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `d91c49edcf382212a4c29e11b85fdd21bf9b721959d109dcb6852946ba55758b` |
| Complete bundle inventory | `34c16db42c8b7376d5c71a9683d82f2a3284460a401f70a318a1166ddc5912b4` |
| DMG | `edd94f8c471d0f4ae16856b1baa2105b486e63d513d65d88228232b59b89cbfa` |
| Build receipt | `ebc6059c11fb1df2ff6ee7eb9ede5c9a78d58286f3e5dbdcc2cabc25b06eb6f1` |
| Final packaging verification | `0944ce1407aab24ff9297d0780a5d8cd764d3e5d1c4d82cdc77908bccbe09ab8` |

The [build receipt](../../target/macos-m4/release-package-colmap-diagnostics-20261027/acceptance-summary.json)
binds the application to
`MetOrigin-Splat-release-590102d22902-build.AdkNnm.dmg` and the
[final verification](../../target/macos-m4/app-verification/build.AdkNnm/final.json).
The app and embedded DMG app passed strict signature checks; the DMG was mounted
read-only and its complete embedded bundle matched the verified app. The
artifact is arm64, declares macOS 15.0 and remains ad-hoc signed.

Before replacement, `ditto` preserved the previous `4e763b58` application at
`target/macos-m4/release-package-colmap-diagnostics-20261027/previous-candidate/MetOrigin Splat.app`.
The complete inventory, permissions and internal symlinks matched before and
after the new build. The old `build.9Kumca.dmg` retains SHA-256
`8985a59031979d0faf27112ae6cb5eeaf7701256b94f0c787838e7bd868a1ad6`, and all
previous package receipts remain unchanged. Historical native generation and
preview results retain their original executable identities; this package does
not transfer the `4e763b58` mixed40 or Objectron results to `d91c49ed`.

The immutable receipt records `native_acceptance=pending` at creation. New
native diagnostic and model-viewing outcomes must be recorded separately after
their own evidence audit; this packaging section does not mark them passed.
Engine manifest, release-status and application-license manifest hashes are
unchanged. All five application-license issues remain open:
`binary-and-vendored-completeness`, `supersplat-webp-provenance`,
`unicode-data-license`, `supersplat-static-asset-grants` and
`missing-license-texts`. This remains an internal Alpha, with no public-release,
Developer ID, notarization, Gatekeeper, clean-host, actual macOS 15, actual
16 GiB or Windows acceptance. M4 remains open.

## 2026-10-27: 9e25 editor initial-framing candidate

This internal Alpha fixes initial camera framing for the product's fresh,
single-model SuperSplat editor session. After import completes and the scene is
confirmed nonempty, the bridge calls `scene.camera.focus()` before `doc.saved`
and the successful load acknowledgement. The no-argument camera call resolves
the lazy scene bounds before setting the focal point and distance synchronously;
an animated `camera.focus` event could otherwise have its distance target
overwritten by the next bounds update. Global reset, model transforms, PLY
contents, dirty state and export/save semantics are unchanged.

Relative to `d91c49ed`, the only selected source changes are
`integrations/supersplat/metorigin-bridge.ts`, the corresponding Scene argument
in `integrations/supersplat/prepare.mjs`, and the new
`apps/desktop/src/services/supersplatIntegration.test.ts`. Four persistent tests
execute the real transpiled bridge with stubbed import and serialization,
covering import acknowledgement ordering, empty/failed imports and subsequent
dirty/export/save behavior. The [validation receipt](../../target/macos-m4/supersplat-initial-frame-20261027/verification-summary.json),
SHA-256 `282186c193cb974c3000a40a5482b3b2ace5418f8f99a49fa6d463b0f9db88a4`,
records **202 frontend tests in 33 files**, ESLint, TypeScript and production
frontend build passing. Only a test title changed after the full suite; the
final four-test run uses the exact final test file. A separate method-level
reproducer uses the pinned camera, scene and tween implementations with
synthetic bounds to verify stable initial framing. Neither test establishes
native rendering or GPU acceptance.

SuperSplat 3.0.1 was fetched at the exact pinned commit
`18eccb9742bfbbf728c67f332d6d8215ed556755` and rebuilt through the normal prepare
script. The [generated-asset verification](../../target/macos-m4/supersplat-initial-frame-20261027/generated-asset-verification.json)
binds all 25 public assets, confirms that the source map contains the exact
bridge and `registerMetOriginBridge(events, scene)` startup call, and matches
the method-reproducer sources. The new build signature is
`dd5be040011f8a842dffde507b95f6309277f8655cd43ea149b14a1331639955`.
Initial harness/typecheck and sandbox fetch failures remain preserved alongside
their successful corrections; no dependency or general prepare behavior changed.

The previous **729 Rust tests / 15 ignored**, fmt and strict Clippy were reused
after exact identity checks of all 186 selected Rust source/dependency inputs.
The **36 schema cases** were reused after matching 52 inputs and successful
prior logs. These gates were not rerun; the [reuse receipt](../../target/macos-m4/release-package-editor-framing-20261027/reused-gates.json)
records their bindings and scope. The complete
`build-macos-app.sh --internal-alpha` workflow ran from the start in **257.295
seconds**, exited 0 and used no resumed steps. It freshly passed release-mode
resolution of all 2,999 engine files and the actual application adapter/version
preflight, then rebuilt the production frontend and application. All 446
selected source inputs and 25 public editor assets stayed unchanged throughout
packaging.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `9e25bb7cd571115bf88ac8abef72d6588b0ee066464bfa77e4a9b5543c5e602d` |
| Complete bundle inventory | `c6b5ec0f69d8a0cdde3bb231328ce2e0fd82f8f95af070f83eb800b5d1fdbd7f` |
| DMG | `7cfe5a60f629bc84c2c84c909ef9271037d7d901f347c5c70a584d01f25c2657` |
| Build receipt | `0ea99c89485141a77f49c96f9f490ffb8934e4645f9c15397d7ef2740c0add0f` |
| Final packaging verification | `fcc364444eda88f4021d714e91db18d07184cde5d534268bc684d6d27dc0da61` |

The [build receipt](../../target/macos-m4/release-package-editor-framing-20261027/acceptance-summary.json)
binds `MetOrigin-Splat-release-590102d22902-build.3WnQ7U.dmg` to the
[final verification](../../target/macos-m4/app-verification/build.3WnQ7U/final.json).
The DMG was mounted read-only; its complete embedded app matched the verified
bundle and passed signature checks. The arm64 application declares macOS 15.0
and remains ad-hoc signed.

The preceding `d91c49ed` app is preserved at
`target/macos-m4/release-package-editor-framing-20261027/previous-candidate/MetOrigin Splat.app`.
Its complete content, permissions and internal-symlink inventory remained equal
before and after replacement. The [archive mapping](../../target/macos-m4/release-package-editor-framing-20261027/previous-candidate.json),
SHA-256 `76d4779751836320c9711cdc2dc7294fee038fc887b99b9abd0e0011ed75bf1a`,
retains the original executable and inventory identities. The old
`build.AdkNnm.dmg` and all prior package receipts are unchanged; historical
native and paired-study evidence stays bound to its original application.

**Native acceptance remains pending until the root native closeout.** This
section records packaging and automated checks only, without transferring prior
viewing, editing, saving or generation results to `9e25bb7c`. Engine manifest,
release-status and application-license manifest hashes are unchanged, and all
five application-license issues listed in the preceding section remain open.
This remains an internal Alpha without public-release, Developer ID,
notarization, Gatekeeper, clean-host, actual macOS 15, actual 16 GiB or Windows
acceptance. M4 remains open.

## 2026-10-27: f7b7 Spark saved-model framing and independent package retry

The subsequent [9e25 native closeout](../../target/macos-m4/native-editor-framing-fixed-20261027/independent-postexit-closeout.json)
keeps the editor and Spark outcomes separate: the authorized Objectron test-copy
save persisted the model translation, but returning to Spark reused the original
SfM camera and left the subject outside the view. The order-independent PLY
comparison matched all 614,263 vertices, found every non-Y property bit-identical
and every saved Y equal to the expected float32 translation. The camera failure
therefore did not establish save corruption. Those observations remain bound to
`9e25bb7c` and do not count as native acceptance of the next build.

The new Spark guard compares the original capture pose with robust bounds and
sampled centers from the currently decoded model. It preserves a valid camera
inside the scene's robust bounds; an incompatible external capture pose falls
back to the existing overall-model view with a 52-degree field of view. Fresh
mounts and explicit resets reevaluate the current geometry without a session
cache, project.json change, revision marker or sidecar. Existing live/final mesh
replacement continues to preserve the user's camera. The 5% view-cone border
and 0.1% robust-core visibility threshold are conservative framing heuristics,
not reconstruction-quality tolerances or projected-pixel coverage measurements.

Relative to the 9e25 source freeze, exactly five selected paths changed: the
Spark preview component and its test file, the new `gaussianFraming.ts` helper
and its tests, and `scripts/macos/collect-app-licenses.mjs`. The
[source validation](../../target/macos-m4/spark-edited-camera-diagnosis-20261027/verification-summary.json)
records **208 frontend tests in 34 files**, TypeScript and ESLint passing, with
the four camera-related source hashes unchanged. Six new persistent tests cover
capture compatibility, indoor cameras, sparse/outlier geometry, fresh mounts
and reset behavior after replacement. The
[real-model report](../../target/macos-m4/spark-edited-camera-diagnosis-20261027/real-model-guard-report.json)
runs the production helper against actual model-derived samples and exact SfM
poses across five viewport aspects: original Objectron, mixed40 and room retain
capture poses, while the saved translated Objectron uses the bounds fallback.
This is a geometry/helper check without GPU rendering, not native acceptance.
The complete semantic report was recovered from the preserved JSON log after a
report/command-receipt filename collision; the original log and receipt remain.

The refreshed license collection was independently checked and
[promoted](../../target/macos-m4/license-refresh-spark-framing-20261027/promotion-result.json)
before packaging. It contains **614 manifest-listed files**, including the
generated Unicode-table notice and pinned static-asset provenance evidence;
manifest SHA-256 is
`2f586df635ece297b8519b53b923381e811ad964780b5f24b6dbd47c35b91f60`.
The preceding `d6c37a1a` collection is archived at
`target/macos-m4/app-license-evidence/licenses-before-spark-framing-20261027`.
Three actual issues remain: `supersplat-webp-provenance`,
`unicode-data-license` and `missing-license-texts` for sigchld 0.2.4. In
particular, the newly retained notice does not recover the exact historical
2017 Unicode data permission text. `release_ready` remains false.

The first complete standard build ran inside the execution sandbox for
**201.879 seconds** and exited **1**. Frontend/application compilation, signing
and [application-only verification](../../target/macos-m4/app-verification/build.HBrCYM/verified-app.json)
completed, but `hdiutil create` failed with `设备未配置` (Device not configured).
No DMG or final packaging report was produced. The
[failure closeout](../../target/macos-m4/release-package-spark-framing-20261027/failure-closeout.json),
SHA-256 `5097c44fe6c5009178d3df6685fecb6f2166ae95c15fefa101083f32e5f5e745`,
retains that failed result; no partial step was resumed. A separate
[device-access diagnosis](../../target/macos-m4/dmg-device-diagnosis-20261027/diagnosis.json)
used identical tiny input: image creation failed inside the sandbox and
succeeded with reviewed permission outside it. That probe used the default
filesystem, whereas application packaging requests HFS+, so the probe alone
was not application/DMG acceptance.

After that diagnosis, a new evidence directory and root control authorized one
independent complete `build-macos-app.sh --internal-alpha` invocation outside
the execution sandbox. It ran from the start in **237.665 seconds**, exited
**0** and did not reuse the failed claim or resume its DMG step. All **448
selected source inputs**, **25 SuperSplat assets** and **614 license files**
matched the failed attempt and stayed unchanged throughout the successful run.
The previous **729 Rust tests / 15 ignored**, fmt, strict Clippy and **36 schema
cases** were reused only after exact input and successful-log checks, as bound
by the [reuse receipt](../../target/macos-m4/release-package-spark-framing-retry-20261027/reused-gates.json).
They were not rerun for either packaging attempt. The standard workflow freshly
performed engine resolution and application adapter/version preflight, then
built the production frontend and desktop app. These probes do not run GPU
training. Engine manifest and release-status hashes are unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `f7b7141afa4da873bce0c90a3ca4ad218512f60eb18936047e15b91e70abd5ac` |
| Complete bundle inventory | `f99677b6230b69b7cff274b1c60f2a91d6f15346f13178da664060547c65709b` |
| DMG | `7547d568e378a842b6211a9c3690cfec8af234d01681e42ca018d19fc49e6af9` |
| Independent complete build receipt | `0d5ae67619cabc3df3d7cde3218dfe633ed80d5357cac754a038f571b7a35835` |
| Final packaging verification | `0a2bf116eab93c2583802f416c4b68284ab6b1c7b98b87f84deea1a9e437e8f3` |

The [successful build receipt](../../target/macos-m4/release-package-spark-framing-retry-20261027/acceptance-summary.json)
binds `MetOrigin-Splat-release-590102d22902-build.XWwqBV.dmg` to the
[final verification](../../target/macos-m4/app-verification/build.XWwqBV/final.json).
The DMG was mounted read-only, its entire embedded bundle matched the verified
app, and application signatures passed verification. The repeated compilation
produced the same executable and bundle inventory as the failed attempt's
app-only result; successful DMG acceptance belongs to this independent complete
run, not to the earlier failed attempt.

The full 9e25 bundle remains at
`target/macos-m4/release-package-spark-framing-20261027/previous-candidate/MetOrigin Splat.app`;
its [archive mapping](../../target/macos-m4/release-package-spark-framing-20261027/previous-candidate.json)
preserves the old receipts and `build.3WnQ7U.dmg` identity. Before the retry, the
live f7b7 app was checked against the failed attempt's exact executable and
inventory, then preserved as a complete bundle at
`target/macos-m4/release-package-spark-framing-retry-20261027/failed-attempt-app-only/MetOrigin Splat.app`.
The [failed-attempt mapping](../../target/macos-m4/release-package-spark-framing-retry-20261027/failed-attempt.json)
retains both its original and copied receipts. Both archived bundles, all prior
receipts and the old DMG remained unchanged after the successful build.

**Native acceptance is pending at this packaging closeout.** The planned next
check is viewing existing original Objectron, saved translated Objectron and
mixed models; it does not require retraining and is not marked passed here.
Historical native generation, viewing, edit and save results retain their
original application identities. This arm64/macOS-15.0-minimum artifact is
ad-hoc signed and remains an internal Alpha with three unresolved application
license issues. Local packaging and signature verification do not establish
Developer ID, notarization, Gatekeeper, clean-host, actual macOS 15, actual
16 GiB, Windows or public-release acceptance. M4 remains open.

## 2026-10-28: e086 project-path identity and fallback orientation

`e0863d0e` remounts the Spark preview when the project path changes, including
copies sharing one project ID. Same-path live/final replacements retain navigation.
Automatic fallback and reset now frame current bounds along valid capture
forward/up axes; missing or degenerate poses use the safe default direction.
The explicit overall-model view retains its existing behavior.

The [source validation](../../target/macos-m4/spark-project-path-orientation-20261027/verification-summary.json)
records **219 fresh frontend tests**, TypeScript, ESLint and independent review passing.
**729 Rust tests / 15 ignored**, fmt, Clippy and **36 schema cases** were
[reused after matching inputs](../../target/macos-m4/release-package-spark-path-orientation-20261028/reused-gates.json), without rerunning those gates.

One complete standard internal Alpha build ran outside the execution sandbox
in **236.94 seconds**, exited 0 and resumed no previous steps. Its
[build receipt](../../target/macos-m4/release-package-spark-path-orientation-20261028/acceptance-summary.json)
(SHA-256 `27d5251324f955d5cc889c221edd5f587d794fcc217b6ac7b377aaa4ff7035a9`)
binds the new [build.r7Jz6T DMG](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.r7Jz6T.dmg),
SHA-256 `747390ae488e9de148340fe57f241afeba20a145f5f08c53845a699a47fc4bbb`,
to the [final packaging verification](../../target/macos-m4/app-verification/build.r7Jz6T/final.json).
Read-only DMG mounting, complete bundle equality and signature verification passed;
448 source inputs, 25 editor assets and 614 license files remained unchanged.

**Native acceptance remains pending at packaging closeout.** Existing-model path
switching and subject framing require separate native evidence; no generation
result is transferred. `application_public_release_ready=false`: this is an
ad-hoc-signed internal Alpha with three unresolved application-license issues,
without Developer ID, notarization, clean-host or public-release acceptance.

Subsequent e086 native checks of existing models completed; see the
[native record](macos-native-ui.md#2026-10-28e086-跨路径身份与自动取景朝向复验).
Same-ID cross-directory Spark framing and the translated model's editor-return
view passed within that scope, followed by exit 0 with no known child processes.
The record also discloses a screenshot-helper directory error that overwrote
13 earlier f7 image/AX assets; current captures were copied to the correct
directory, and historical receipts were not rewritten. This does not close M4
or transfer earlier generation/edit/save acceptance to the new package.

## 2026-10-28: 6925 editor capture direction and license follow-up

`6925467b` initializes SuperSplat from capture forward transformed through the
actual imported entity, after fitting the current model bounds. Normal camera
navigation keeps world-Y upright; capture roll/up, position and FOV are not
restored. The same candidate removes the unused shell plugin and binds the
official Unicode permission text to the identified Unicode 10.0.0 data and
generated-table evidence.

The [source validation](../../target/macos-m4/editor-capture-orientation-20261028/verification-summary.json)
records **235 frontend tests**, TypeScript and ESLint, **729 Rust tests / 15
ignored**, fmt and strict Clippy, and **36 schema cases** freshly run for this
round. Packaging [reused these results](../../target/macos-m4/release-package-editor-capture-20261028/reused-gates.json)
only after matching their current inputs and successful logs; it did not rerun
those gates. The schema run includes all 52 inputs under the changed lockfile.
The real pinned Camera/Tween method check also passed, with synthetic import
and bounds; it does not establish native rendering or pointer-control behavior.

One complete standard internal Alpha build took **258.10 seconds**, exited 0
and resumed no earlier steps. **449 source inputs**, **25 editor assets** and
**610 license files** remained unchanged. That candidate's license manifest was
`9991557ac802d2f8b8b9b7393a0126d5b765afba228cf0b160a68cd8d36e480f`;
only `supersplat-webp-provenance` remained open in that collection. The collection
and application were not public-release-ready.

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `6925467b4fe285a08797b1b80b84ca938c64ff02c7f7d8e40929410aee02b8ff` |
| Complete bundle inventory | `63258eb3abd7e7df2b949a575d54227efeef7a753b089157c411947c0b014ce6` |
| DMG | `2179d133687e50b63f18e569d8ec11522d656b41695ded61886c4d71231f53be` |
| Complete build receipt | `f28061b9b23ab13ecf1a38ed6f3f93309722bb1ecccb202d7fb4f2229fdb52de` |
| Final packaging verification | `3aa216a5cf4f2359502cb2ed7df634cf1109f7a916867e71499fdf63d722983b` |

The [build receipt](../../target/macos-m4/release-package-editor-capture-20261028/acceptance-summary.json)
binds [build.IWJQjj.dmg](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.IWJQjj.dmg)
to its [final verification](../../target/macos-m4/app-verification/build.IWJQjj/final.json).
Read-only DMG mounting, complete bundle equality and signature verification passed.
The [e086 archive mapping](../../target/macos-m4/release-package-editor-capture-20261028/previous-candidate.json)
preserves the complete prior app under `previous-candidate/MetOrigin Splat.app`,
its receipts and the unchanged `build.r7Jz6T.dmg`; earlier f7 image/AX assets were
not touched by this packaging run.

**Native acceptance was pending when this package completed.** Existing-model
editor entry and return checks require separate evidence. Earlier generation,
editing and saving results retain their original application identities and
are not transferred to 6925. This remains an ad-hoc-signed internal Alpha;
packaging does not establish Developer ID, notarization, clean-host or public
release acceptance, and M4 remains open.

Subsequent 6925 [native observations](../../target/macos-m4/native-editor-capture-20261028/root-native-observation.json)
(SHA-256 `20d91c10bee878d4c05de2707d3e5899f9348ca5305f7ebd9ef5e0d74fbea88d`)
recorded identifiable subjects in initial and returned Spark views for three
existing model copies. Both Objectron editor views showed the shoes and carpet
after loading, with small subjects in a wide scene and blurry peripheral
reconstruction; the mixed editor view showed the rock and turntable at a
distance. All three no-edit returns had no dirty prompt. Normal exit returned
0 with no known remaining processes. This closes only the three-case initial
subject-identifiability and clean-return check. No generation, editing, saving,
camera navigation, reset or model-quality improvement was tested. The session
used the current M1 Pro/32 GiB/macOS 27.0.1 host with direct process-scoped
network denial, not Finder, system-wide offline or clean-host acceptance.
The [independent post-exit closeout](../../target/macos-m4/native-editor-capture-20261028/independent-postexit-closeout.json)
(SHA-256 `93ec0b5f6b9f211faa6b7c6d82c21b4ef904715e60c0f4a5c29137b691616155`)
confirms all six project trees unchanged and completes the current package/input
review. Its explicit serialization boundary records that the audit saved project
and bundle inventories before its final process probe was denied by the sandbox;
the input/license/DMG/signature assertions had already run, but their package
summary was serialized afterward. A separately approved process probe found no
known remaining identities or current app process. No full scans were repeated.
The packaging receipt's earlier native-pending state remains an unchanged
historical fact; M4 and public release remain unaccepted.

### 2026-10-28 WebP source integration before the next application build

That source-integration step selected a fixed-source WebP/splat-transform derivative
and an exception-safe codec wrapper. The paired ten-file overlay, complete runtime
notice/source mapping, preparation cache and public/dist input checks passed.
The separately generated `licenses-webp-source-audited-20261028/` collection had
722 files and no remaining license findings, with manifest SHA-256
`60575302453eeb2d1124c6c3f537b68976764db174ca44439b08c294b11dceb5`.
See the [replacement evidence](macos-app-licenses.md#2026-10-28-fixed-source-webp-replacement).

No app/DMG was produced in that step. At its closeout, the most recent complete
candidate was 6925 with its original 610-file collection and WebP finding. Its
native results were not transferred to the pending derivative. The builder compares
public assets, exact Vite dist copies and the selected license collection before
and after Tauri compilation, then requires that receipt when checking the app
and DMG. This is build-chain evidence, not extraction of frontend bytes from the
executable. Default license promotion and complete packaging subsequently ran as
recorded below; native checks, complete M3/M4 and public-release status remained open.

## 2026-10-28 ebef fixed-source WebP complete application and DMG

The audited 722-file license collection was verified in a staging directory,
then selected as the default while preserving the old 610-file collection at
`target/macos-m4/app-license-evidence/licenses-before-webp-20261028/`.
The [promotion receipt](../../target/macos-m4/release-package-webp-20261028/license-promotion.json)
binds new manifest `60575302453eeb2d1124c6c3f537b68976764db174ca44439b08c294b11dceb5`
and old manifest `9991557ac802d2f8b8b9b7393a0126d5b765afba228cf0b160a68cd8d36e480f`.
An initial preparation stopped before mutation because it compared differently
ordered inventories as lists. Its failure record remains; the successful attempt
compared records by path and completed the independently verified copy.

One complete `build-macos-app.sh --internal-alpha` invocation took **249.75 seconds**,
exited 0 and resumed no partial build. The
[build receipt](../../target/macos-m4/release-package-webp-20261028/acceptance-summary.json)
has SHA-256 `57f07aa980b39289827161c858be0a5dbfab103c17492b9a2f9961012a4cedf3`.
It binds the new [build.zid9up DMG](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.zid9up.dmg)
to the [final verification](../../target/macos-m4/app-verification/build.zid9up/final.json):

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `ebefccae78577fb9fa9ed83418ff62b8aa426d6797fc3c06a5ea2ab4cff54e80` |
| Complete bundle inventory | `870387725969b7112c962c6deb911c78a497d549acdc8f619986c887a2efde87` |
| DMG | `af4fcc9a8485624c601ccaabf738228242177d07713c5a4903149e4f8ea18e12` |
| Final packaging verification | `3f5dbe386aae5c3b4ebcbb406b350e256e17f8b29e6a9dbb3552267d4124bb93` |

All **576 frozen source inputs**, **25 public editor assets** and **722 license
files** remained unchanged. Source selection is the prior Git-selected scope
plus the entire **118-file controlled overlay**: the union includes 14 ignored
files absent from the ordinary Git listing. The prepared and post-build source
records match exactly. The earlier **235 frontend tests**, TypeScript and ESLint,
and **729 Rust tests / 15 ignored**, fmt and Clippy were reused after the
[input review](../../target/macos-m4/release-package-webp-20261028/input-delta-review.json)
matched their inputs. The **36 schema fixtures** were also reused, with all 50
substantive inputs unchanged; the two other recorded inputs only gained the
packaging-test script/CI steps. This does not repeat the former claim that all
52 recorded schema inputs were byte-identical, and none of these reused gates
was rerun during packaging.

The standard build freshly ran both frozen-pack checks against engine manifest
`590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`.
The [resource resolver](../../target/macos-m4/app-verification/build.zid9up/runtime-engine-locator.log)
and [application adapter/version preflight](../../target/macos-m4/app-verification/build.zid9up/runtime-application-preflight.log)
each passed, without an integrity cache; the latter executed only version/help
probes and returned pending work to zero. Production frontend and release app
compilation then completed. No GPU training ran in these checks. Engine manifest,
release-status and the 2,999-file frozen pack identity remain unchanged.

The final app report binds the 722-file license evidence with **`issues=[]` and
`release_ready=true`**, and retains its 106 evidence files, 48 runtime notices and
94 linked members. Its frontend receipt SHA-256 is
`fd7b7f77e44028f865efa59928f000b1af6f92fc0a811eb030ff1f162c047e0e`.
The public and Vite-dist input identities agree before/after compilation; the
final report records `dist_verified=true` and the same preparation signature and
overlay as the collected license evidence. App signatures passed, and read-only
DMG mounting verified that its complete embedded app equals the verified bundle.
The [independent receipt review](../../target/macos-m4/release-package-webp-20261028/package-review.json)
cross-checks these records without a redundant complete app/DMG/license scan.

The [rollback record](../../target/macos-m4/release-package-webp-20261028/rollback-package.json)
preserves the earlier verified `build.IWJQjj.dmg`; no redundant copy of its full
application bundle was made. Previous receipts and native outcomes retain their
original application identities. **Native WebP acceptance is pending at this
packaging closeout.** The new arm64/macOS-15.0-minimum app is ad-hoc signed and
remains internal Alpha: zero source-license findings do not establish Developer
ID, notarization, Gatekeeper, clean-host, actual macOS 15/16 GiB, Windows, model
quality, sleep or full M3/M4 acceptance. `application_public_release_ready=false`
and `m4_accepted=false` remain explicit.

Subsequent native validation observed the Objectron model in Spark and the editor, but the320×240WebP image export failed responsiveness/output acceptance. The main thread was sampled in Wry/WebKit download destination SandboxExtension processing; the exact test process required SIGTERM. No valid exported file or normal quit was established. The439-file test project is unchanged. See the [native closeout](../../target/macos-m4/native-webp-20261028/closeout.json); packaging success and zero license findings do not close this runtime failure.

## 2026-10-28: 6095 native image save package

The [complete build](../../target/macos-m4/native-image-save-20261028/acceptance-summary.json) and [independent review](../../target/macos-m4/native-image-save-20261028/package-review.json) bind app `6095c7b2e95939417bca04b976038aec31364ce500c1ffc224354628bcbae4e4`, bundle inventory `419b246bce157add287799e019a17b5d7ad2f3ce6b134334445d0c474c9bc9d1`, and unique `build.vwiRqG.dmg` (`99f1a910412584c00f8b0afab529612ea59fab6d7ee8a9ff9cf4e8729cac9c7c`). Read-only mounting, embedded bundle equality and signatures passed. The previous ebef DMG and license collection remain preserved.

All 578 selected source files, including the complete 118-file overlay, match before/after the build. Fresh frontend 273 and Rust 738/15 ignored gates passed; schema36 reuse retains the reviewed 50-identical-input/two-additive-command boundary. The license manifest `62161031ec21f848e68eb6dbd4390702740b9a9835ce100479aeadc55e146863` binds 722 payload files with no findings. The engine manifest and release-status identities are unchanged. Both runtime preflights and the production frontend build ran again for this package.

The [subsequent native session](../../target/macos-m4/native-image-save-20261028/native/root-native-observation.json) saved valid 320×240 PNG/JPEG/WebP through native dialogs, canceled without creating a file, returned/reentered the editor and issued Cmd+Q followed by verified process disappearance (OS exit code unavailable). The439-file project copy remained unchanged. **Image fidelity failed on this candidate:** WebP/JPEG showed pointlike noise unlike PNG. The later capture-lock diagnosis and limited `0f85` fix verification below do not change that historical failure. No historical generation/model-save result is transferred. This is ad-hoc-signed internal Alpha; native image-save progress does not close general M3/M4, external-platform, clean-host, Developer ID or notarization gates.

## 2026-10-28: 0f85 stable image capture package

The complete [build receipt](../../target/macos-m4/image-render-quality-20261028/acceptance-summary.json)
and [independent package review](../../target/macos-m4/image-render-quality-20261028/package-review.json)
bind the new [build.qhJJPk DMG](../../target/aarch64-apple-darwin/release/bundle/dmg/MetOrigin-Splat-release-590102d22902-build.qhJJPk.dmg)
to the [final builder report](../../target/macos-m4/app-verification/build.qhJJPk/final.json):

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `0f85289e89e606c4732675347c138bf1b922e1bc8c1a49453c487310e6685180` |
| Complete bundle inventory | `c564ca40705110f5750d3ba29c6c7a4375cedec7be6c664a1113547fb6d7118f` |
| DMG | `0a403c7603db77238dd1e8b0d261f67bbcf07eca6705f183917ed8264661c2a5` |
| Application license manifest | `62254c372e700b3b0220287e9860a93ad48809ad31e9537562291b849f14eedc` |
| Final packaging verification | `5187cd5022173690172306b0050d283fb57a629f4c9ae92c4a94891f04a2d34d` |

One complete internal-Alpha builder run exited 0 in 245.65 seconds. The builder
freshly ran both frozen-engine checks, compiled the production frontend and
release app, and verified signatures plus exact bundle equality in the read-only
mounted DMG. Engine manifest `590102d2290251ceced86320d1edef00b1667b139249326f9511ff1b75b6bc40`
and release-status identity remain unchanged. The selected, default and bundled
722-file license manifests agree with no findings; frontend before/after/final
input identities agree and `dist_verified=true`. The receipt review independently
hashed the actual executable and selected small inputs without repeating the
complete bundle scan or DMG hash/mount. The prior `build.vwiRqG` DMG and license
collection remain preserved.

The bridge now scopes sorted rendering to native image capture and restores lock
flags/listeners afterward, retaining the user's persistent render preference.
Only `metorigin-bridge.ts` and its image-export test changed from `6095`.
All four snapshots contain the same **578 source records**, including **118
overlay records**. Fresh frontend tests passed **290**, and the final targeted
suite passed **46**, including **7 actual pinned-upstream Scene/render paths
with GPU/codec stubs**. Those tests are not native GPU evidence. TypeScript and
changed-file ESLint passed; fresh lint covered only the two changed files.
Snapshots bracket full frontend tests and production build; final typecheck
and lint ran earlier on the same reviewed frozen revision.
[Gate evidence](../../target/macos-m4/image-render-quality-20261028/gates.json)
explicitly reuses **738 Rust passed / 15 ignored**, fmt and Clippy because their
recorded inputs are unchanged. **36 schema fixtures** are reused under the
existing 50-identical-input/two-reviewed-metadata-delta boundary, not a claim
that all 52 inputs match or that these gates were rerun.

The subsequent native session, PID **62152**, saved actual **320×240** Objectron
PNG, WebP and JPEG files, canceled a fourth JPEG without an error dialog,
returned cleanly to Spark and reentered the editor with **614,263** Gaussians.
All three files fully decoded. The [independent original-image review](../../target/macos-m4/image-render-quality-20261028/native/image-comparison-review.json)
confirms the prior WebP/JPEG black-hole speckle artifact is no longer visible
in this sample. PNG and WebP are **not pixel-identical**: only 38 of 76,800
pixels differ, by at most one channel level, with whole-frame RGB MAE 0.000221.
PNG/JPEG MAE is 0.380469. Thresholded near-black counts fell from 2449/2447 to
0/0 for WebP/JPEG, and their Laplacian RMS fell from 141.78/141.04 to
35.288/35.480, close to PNG 35.288. Each run uses its own PNG reference mask;
no general quality threshold or reconstruction improvement is claimed.

Cmd+Q from the clean editor returned `App quit`; the
[quit observation](../../target/macos-m4/image-render-quality-20261028/native/quit-observation.json)
records both `ps` and exact-executable `pgrep` returning 1 with empty output,
without force termination or relaunch. The OS exit code is unknown, not zero.
See the [reentry capture](../../target/macos-m4/image-render-quality-20261028/native/editor-reentered/capture.json)
and [native closeout](../../target/macos-m4/image-render-quality-20261028/native/closeout.json)
for the session, cancellation and project-integrity evidence. The immutable
packaging receipt retains its native-pending creation state; these subsequent
checks supplement it without transferring old native results.

The [cancellation audit](../../target/macos-m4/image-render-quality-20261028/native/cancel-integrity.json)
confirms exactly the three original export files remain with unchanged sizes and
hashes and no canceled destination. The [single-project audit](../../target/macos-m4/image-render-quality-20261028/native/project-integrity.json)
confirms all **439 files / 1,047,169,524 bytes** of the authorized test copy are
unchanged; original projects and other copies were not rescanned. The
[root observation](../../target/macos-m4/image-render-quality-20261028/native/root-native-observation.json)
binds 16 capture groups. The native closeout SHA-256 is
`43c50528f48a169698d5380c7ced74f910dadc2471cb4d3fad5bc56748e130e0`.

This closes only the sampled save/quality/cancel and clean return/reentry/quit
gap. No new generation, model save, dirty-editor protection, write-error
recovery, quit-during-save, native 360, SOG/video, large-image memory or complete
M3/M4 acceptance is claimed. Real sleep remains deferred by the user; actual
macOS 15/16 GiB, clean-host and Windows environments remain unavailable. Dock,
offline Finder, physical external-disk, CPU SfM quality comparison and other
unfinished matrix gates retain their scope. The app is ad-hoc-signed internal
Alpha; Developer ID, notarization, Gatekeeper and public release remain open.
`m4_accepted=false` and `public_release_ready=false` remain explicit.
