# Windows alignment candidate pack verification

2026-10-30. Candidate ID: `0.1.0-internal.windows-alignment.1`. Release default
and the original Windows legacy lock/scripts remain unchanged.

The actual source-backed candidate at
`target/distribution/windows-x64-alignment/` passed offline preparation, complete
manifest/file checksums, archive identities, runtime versions, machine protocol,
Brush source/patch/Cargo.lock provenance and the DXC DLL/notice closure. Versions
are FFmpeg/FFprobe 8.1.2, COLMAP 4.1.0 and
Brush `1.0.0+metorigin-windows.1`. Brush binary SHA-256 is
`4398eeabd0cc4becaf5d82fb81b76dfd377b791b7bd7251b0e2b7ca8fe7e4001`.
The main CLI is mapped to `brush/bin/brush-cli.exe`; no legacy live companion is
required by this candidate.

The exact FFmpeg archive was assembled from the original download prefix and
eight verified HTTP byte ranges from its pinned official URL. Each response's
Content-Range was checked before append; final size **109,728,040 bytes** and the
original `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`
SHA-256 passed before the cache filename became available. Failed CDN/mirror
attempts were not used as completed archives. COLMAP's locked archive hash and
the exact locked VC runtime installer from the installed VS toolchain passed.

The first immediate publication rename returned a transient Windows `EPERM`
after running the binaries. The complete staging tree was retained, reverified
and successfully published later. The builder now retries only bounded
sharing/access failures and never replaces an output that appears meanwhile.
Failed or interrupted staging trees are never application discovery candidates.

The development entry's `-Backend dx12 -Offline -CheckOnly` passed toolchain,
candidate cache reuse and runtime checks. It used a process-local Node 26 /
pnpm 11.12.0 toolchain; no global tool installation or user engine overrides were
changed. This is **preparation/check acceptance**, not evidence that the launcher
started Tauri or that its native UI completed reconstruction. The actual Tauri
launch and application UI are recorded independently.

A complete copy was moved to a fresh path containing Chinese characters and
spaces under `target/windows-relocation/`. With PATH restricted to Windows and
System32, and development engine overrides cleared, standalone pack verification
passed all hashes and the four engine version/capability commands. This tests
package-relative dependency startup; it does not establish a clean-machine
installation, network-disabled GPU training or native macOS compatibility.

Seven pack/installer tests execute compiled native fixture programs and actual file
operations: candidate generation/cache reuse, corrupt-cache preservation,
offline missing materials and concurrent owner locks, missing DLLs and traversal
paths, actual incompatible engine/platform identities, ZIP traversal rejection,
and transient publish failure/competing-output preservation. The same suite
exercises candidate bundle config generation and verifies that the legacy Tauri
configuration stays byte-identical. An additional actual PowerShell build-lock
check rejected an existing owner before compilation and preserved its bytes.
The test command is:

```powershell
pnpm test:windows:alignment-pack
```

Both `Build-FullInstaller.ps1 -AlignmentCandidate -SkipAcquire -CheckOnly` and
the equivalent `Build-WindowsRelease.ps1` path passed actual input verification
and generated isolated resource configurations. The candidate uses its own
identifier, product/executable name, Cargo cache and timestamped artifact
directory.

An intermediate portable release candidate completed, including the resources,
build metadata and checksum closure:
`artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T140644963Z-35cd023f/`.
Its `MetOrigin Splat Alignment Candidate.exe` SHA-256 is
`f0891aeaa70fd7e7550256674d2724ba94381cb2f2d182050cdfd72680fa6a21`.
That artifact records only HEAD plus a dirty-worktree flag for application
sources. Its binary identity and engine-pack hashes are known, but it is **not
bound to a complete inventory of the uncommitted application source**. Native
observations made with it remain intermediate evidence and will not be relabeled
as final source-bound acceptance.
Building the NSIS installer first failed while downloading its toolkit; the
official NSIS 3.11 archive was then separately verified against its published
SHA-256 and Tauri 2.11.4's pinned SHA-1, and its plugin against Tauri's pinned
SHA-1, before seeding the isolated local tools cache. The accidental interruption
left `nsis-output.exe` with a zero declared payload length in its NSIS first
header. Its silent CRC entry exited 2 without creating an installation or
changing the formal registry/settings; the 369 MB file is retained as a failed
intermediate artifact, not an accepted installer.

The builder freezes a SHA-256 inventory **before** Tauri build, after
preparing deterministic public assets. Its scope includes root dependency/tool
locks, Rust workspace sources/tests, schemas/presets, frontend sources/prepared
public assets, Tauri configuration/icons/capabilities/hooks, the required source
preparers and provenance inputs, and every selected pack resource. Paths are
repository-relative or pack-relative. An independent audit of the first
797-file inventory found 71 omitted repository prebuild inputs and four selected
font/license files: pnpm patches, copied UI notices, theme inputs, active WebP
compressed payloads and curated build evidence. The first inventory remains
historical evidence with that incomplete scope. The corrected collector follows
the owning modules' explicit dependency selections, including their reviewed
source-evidence logs and four selected node_modules font/license files. Unrelated
docs, arbitrary target/cache trees, other node_modules and private/runtime logs
are excluded. After
hooks/build, it recaptures those inputs and refuses publication if a file was
added, removed or changed. The artifact carries this inventory/digest and a
separate inventory of the actual built frontend payload and application.

Six automated inventory tests cover source changes, new/deleted files,
resource/config changes, required missing inputs, output binding, explicit
prebuild dependencies and excluded private/unrelated paths. Two bundle-identity
tests and a bundler-receipt mutation test bring the complete suite to sixteen
passing tests, with no skipped native guard test. The candidate's separate installer hook checks executable paths
below its installation directory and replaces Tauri's global silent same-name
kill macro. Its native observation test confirms that it does not stop another
process; the original legacy installer hook remains unchanged.

The 797-input NSIS build completed and passed its declared-length and CRC check:
447,747,600 bytes, SHA-256
`7636ed4debf7977e1c4d152ff7883a57f4665dcfd9a71b87e1df76fa62b76ca9`.
Its isolated Chinese/space-path installation has 158 matching engine/license
files, an uninstaller and a candidate-only uninstall registration. The installer
process exited after the initial bounded wait; its final exit code was not
observed. Formal application settings/recent-project files remain absent.

The raw build application SHA-256 is
`07d66b5e8cf9aded1a83b28e0540cac782b0c19cd40b93aa3041909ae7952db5`;
the actual installed application is
`7348bb36d1a792249faf60e5916478e360a943573d75b2cb4779974d9ccc5407`.
They have equal length and differ only at the three-byte Tauri bundle marker
(`UNK` to `NSS`, offset 23,812,890). Applying that sole documented transform to
the raw bytes exactly reproduces the installed SHA. Future metadata records
both identities and labels the transformed hash as expected until installation
verifies it. The earlier artifact is immutable; its raw hash and incomplete
source scope are not relabeled.

The final rebuild freezes 874 source/resource/config files, digest
`08eb5d854019def159a3988aa3b48c353405b8b4ac873cc05b78fa46f9b52ee0`,
and a separate 451-file bundler receipt covering NSIS, offline WebView2 and
selected tool binaries. Both inventories remained unchanged after the successful
build. The generated NSIS script/includes are recorded as outputs. The final
artifact is
`artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T152515039Z-6f069c00/`.
Its 447,732,890-byte installer SHA-256 is
`66123ce212ca58a0932d1a1500a490c39da042800a4fa8563eca2b74d396b382`.
All twelve artifact files passed checksum closure; inventory digests, declared
NSIS length and CRC32 `b4871712` passed. Its raw application is
`d64d74bf1cb3ff7f602ff266fee82e3c2aa63ea2e247f4eed8ee2dd5fb3dd7f4`,
and expected NSS installation payload is
`53865e80ce7a026fab30da0ce2a4199e809c9a71e97c6882c402c545147dc594`.
Compared with the older NSS application, the new NSS bytes differ only in 24
bytes of PE/Debug timestamps and the RSDS build GUID. This is a byte-range
classification, not an assertion that the two distinct binary acceptance
identities are interchangeable. Build evidence is in
`target/windows-pack-validation/nsis-build-final-dependency-bound.log` and
`final-artifact-validation.json`.
The final installer completed with an observed exit code **0**, installing into
a fresh Chinese/space path under `target/windows-install-validation/`. Its
actual application hash exactly matches `53865e80…dc594`; all 158 resource files
match the frozen source inventory, with exact resource file closure and the
candidate registration pointing to the new directory. The old `7348bb36…5407`
candidate executable remains byte-identical and formal application settings and
recent projects remain unchanged. Evidence is in `final-install.json`.

The final installed application and its complete resources were copied to a
second Chinese/space path, excluding the uninstaller. The copy retained exactly
the same application hash and all resource hashes. Five actual version/static
capability commands passed from both directories using only system PATH plus
COLMAP's package-relative dependency paths. These are file-integrity and runtime
startup observations; they did not launch a second GUI or GPU workload, and the
network was not disabled. Evidence is in `final-relocation-integrity.json`,
`final-installed-runtime-system-path.json` and
`final-relocated-runtime-system-path.json`.
An independent read-only review resampled the 874 source/resource/config inputs,
451 bundler inputs, generated NSIS files, all twelve artifact checksums and all
158 installed resources. Every hash and the observed NSS application identity
matched. Its receipt is
`target/windows-alignment-evidence/final-874-independent-review.json`.
Native installed-application UI/offline generation is recorded separately by
exact installed binary hash. Clean-machine installation, dependency license
review, native macOS regression and release-default switching remain pending.

Local evidence: `target/windows-pack-validation/verified.json`, `summary.json`,
`nsis-build.log`, `target/windows-relocation/relocation-evidence.json`, and
`.engines/downloads/ffmpeg-ranges/verification.json`. Source-backed GPU evidence
belongs to the independent Brush and pipeline experiments rather than the pack
integrity report.

## Ordinary startup follow-up

The later ordinary-launch report exposed an application preflight problem:
the historical `5386…` candidate required a process backend variable. Its
874-input build, installer and explicit-environment native results above remain
unchanged historical evidence. They do not establish that an ordinary launch
with both backend/device variables absent passed.

The application fix selects DX12 by default for Windows1 and keeps environment
selection as an advanced optional override. The developer launcher now also
accepts an omitted backend; legacy Windows 0.3, Mac and the paired engine binary
are unchanged. `Test-AlignmentDefaultRuntime.ps1` supplies a separate opt-in
production-preflight check with both variables absent, using only the tiny real
compute probe. Its fresh launcher/probe/test-binary evidence is separate from
installed-app UI acceptance.

The new source-bound NSIS build completed using the isolated incremental cache:
`artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T182838204Z-b0a9edf1/`.
Its 877 source/resource/config inputs, digest
`af1adea96d6651c689c16ea7f2b85fe290f393be4be162038f8d786dd13bf158`,
and 451 bundler inputs, digest
`f125b697dc4b07df950ae05b8e6c068bdf411a05a2ae9e7fed84a605aefbc463`,
remained unchanged before/after build. All twelve artifact checksums and the
NSIS declared length/CRC32 `ad80233a` passed. The 447,730,786-byte installer SHA is
`daeb24969beb4cf4783296973a327bd3e18510d077278eefefc69de1e77443ab`.
The restored raw application SHA is
`632129dba13f1fd10fb8a6f97b22028e82433f9469f3d5be1ba2db275cc2df0d`;
its expected NSS payload SHA is
`57e582c7658316fd8e9322f85242599f22e8d3fd40736e3f7abf52de6e90a989`.
The old 874 artifact and its receipts were not overwritten. Build and artifact
checks are recorded in `target/windows-pack-validation/nsis-build-default-dx12-no-env.log`
and `target/windows-startup-fix/artifact-validation.json`. No new installation
or registry change was performed for this follow-up.

The first native no-environment launcher run compiled successfully but failed
its absence assertion before GPU execution: PowerShell's nullable .NET setter
left an empty environment key on this host. Its exit 101, raw logs and failed
environment-restoration observation are preserved in
`target/windows-default-runtime-validation/20261030T182238949Z-63e8db0a/`.
This was a validation-launcher defect and is not recorded as a failed DX12
compute result. The corrected launcher removes the two keys directly from the
owned Cargo child's `ProcessStartInfo.EnvironmentVariables`, leaving its caller
and machine/user environment unchanged.

The corrected actual production-preflight run passed with both keys absent:
`target/windows-default-runtime-validation/20261030T182534683Z-c96e32b1/`.
The returned API is DX12 with the canonical RTX 5080 Laptop device identity;
eight Gaussians at 32×32 have finite forward/backward results and positive
gradient L1 `0.036350282141938806`. Brush SHA remains `4398eeab…e4001`, and
the test executable SHA is recorded in `probe/evidence.json`. Launcher exit 0,
runtime/test/helper source hashes and unchanged caller environment are in
`launcher.json`. The no-Backend development `-Offline -CheckOnly` entry also
passed without launching Tauri, Vite or GPU work. The existing sixteen pack
tests and 83 Mac-protection hashes passed. None of these results reassigns
ordinary-launch success to the old `5386…` application.

The exact new `57e582…` NSS payload was independently copied with 159 checked
resource files into a fresh workspace directory. Its actual native TUM-media
new-project preflight passed with both GPU override keys and both development
engine hints removed from the child OS environment, system-only PATH, and no
backend argument. The UI reported the RTX 5080 Laptop DX12 forward/backward
check ready and enabled Continue. It did not create a project or run training;
the test window then closed normally. The existing user application remained
at its original `5386…` identity and was not closed, replaced or reconfigured.
The observed copy's hash exactly matches the completed build's expected NSS
payload hash. This verifies ordinary startup/preflight from a copied payload,
not a new NSIS installation, complete reconstruction, editing or export run.

Native evidence is in
`target/windows-startup-fix/native-default-launch-b0a9edf1/`:
`launch-receipt.json`, `resource-verification.json`, `preflight-ui.json`,
`closeout.json` and the three actual probe logs. The no-environment source
bridge/read-only review is `target/windows-startup-fix/independent-code-review.json`.
Full generation and editor/export results remain attached to their earlier
application identities. Clean-VM dependency acceptance, native Mac regression,
public distribution license review and release-default switching remain pending.

## Requested quality preset follow-up

The Windows candidate now preserves the selected preset's iterations, SH degree
and requested training resolution. The final source-bound installer is
`artifacts/windows/alignment-candidate/0.1.0-internal.windows-alignment.1/20261030T195903345Z-5283428e/MetOrigin-Splat-Alignment-Candidate-Setup.exe`.
It is 447,733,683 bytes, SHA-256
`9841982eb474f15e880d67e38e0dfbee4eefd5e4febb66175895c6009ea39dd7`.
All twelve artifact checksums, declared NSIS length and CRC32 `1d1f00bd` passed.
The 879 source/resource/config inputs, digest
`e8f7b57c8b428b5bc9eb148f0312098d75c215c07c354518617c880da6597e13`,
and 451 bundler inputs, digest
`f125b697dc4b07df950ae05b8e6c068bdf411a05a2ae9e7fed84a605aefbc463`,
remained unchanged across the build and final source resampling. The 83 frozen
Mac build-input hashes also remained unchanged.

The earlier `20261030T193951910Z-86fb1737` artifact and evidence are retained.
Comparing its 879-input inventory with the final inventory finds exactly one
changed input: `crates/splat-pipeline/tests/windows_quality_preset.rs`, containing
the corrected image-size postcondition, three non-GPU dimension regressions and
clearer receipt states. The other 878 inputs, all 57 built frontend outputs and
the 451 bundler inputs are identical. The two NSS applications differ in 24 bytes
confined to PE timestamps and the RSDS build GUID; this classification does not
reassign an older binary's UI evidence to the new binary.

The final raw application SHA is
`3d9ef4f0b0adab4e26bbdb4643be7c2c29a13bf58e06ef0c2fb27537dd052b16`.
Its expected NSS payload SHA is
`320f8d50f701b06c944cd122fa59f30503d07aebbfd512e9c582271e722f7505`,
which exactly matches the new actual copied payload used for native UI testing.
All 159 copied resource files were verified. With both GPU override variables
absent, the selected quality preset reported **30000 / SH2 / 2560** in both
preflight and confirmation, with Continue/Create enabled. No project was created
in that UI run; the test application closed normally. This is copied-payload
startup/UI acceptance, not a new installation or registry-change observation.

The original independent full-quality production run completed all twelve
stages, registered 82/82 extracted frames, and produced a 30000-step checkpoint
and matching exported scene containing 300,000 complete, finite SH2 Gaussians.
The result, preparation/training fingerprints, checkpoint/scene hashes and output
manifest match. Source frames are 640×480; the prepared undistorted images are
622×466 and match their COLMAP camera models. Eleven source hashes, four engine
hashes and the original/copied TUM video hashes remained unchanged. The original
test harness nevertheless exited **101** because it incorrectly required the
prepared images to remain exactly 640×480. Its failed launcher/log and evidence
status `running` remain unchanged. The corrected harness has three passing
non-GPU regressions; the completed training was not rerun or relabeled as a full
harness pass. The final default workspace tests passed 742 with 22 ignored, and
the unchanged frontend passed 450.

Evidence is under `target/windows-preset-fix/`: `harness-only-source-delta.json`,
`harness-corrected-artifact-validation.json`,
`harness-corrected-payload-comparison.json`,
`independent-quality-output-review.json`,
`native-quality-launch-5283428e/`, `harness-corrected-pack-closeout.json` and
`final-closeout.json`. No user project was retrained or modified, and this work
does not establish a fix for the user's dark/floating model appearance. New
installation, clean-VM dependency acceptance, native Mac regression, public
distribution license review and release-default switching remain separate gates.
