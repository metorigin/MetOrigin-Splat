# Windows x64 internal full installer

This directory defines the reproducible, internal-only engine pack used by the
fully offline Windows installer. It is not an authorization to publish the
bundled third-party programs.

## Brush 1 alignment candidate

The separately named `alignment-lock.json` and commands below prepare an
internal development candidate at `target/distribution/windows-x64-alignment`.
The existing installer and legacy pack remain the release default until native
Windows, native macOS and distribution dependency gates pass.

```powershell
pnpm prepare:windows:alignment
pnpm verify:windows:alignment
pnpm dev:windows
# Advanced development override:
pnpm dev:windows -Backend vulkan -Offline
```

The rebuilt Windows1 application starts normally by double-clicking the installed
executable. With no backend/device override it selects DX12, performs the real
Gaussian compute preflight and freezes the returned device identity for training.
PowerShell, a development launcher and environment variables are not prerequisites
for ordinary use. This application default does not change the legacy 0.3 release
pack or the Mac Metal path.

`dev:windows` checks Node 26, pnpm 11.12.0 and Rust 1.97.0, verifies or prepares
the candidate, and invokes Tauri once. Its optional `-Backend` / `-DeviceId`
arguments override selection only for that invocation; otherwise existing
advanced process overrides or the application's DX12 default apply. Tauri starts
its own Vite server. A
Windows debug-only low-priority hint preserves saved engine overrides and
explicit `METORIGIN_ENGINE_DIR`; `-EngineDirectory <pack>/engines` is an explicit
highest-priority selection. Optional `-DeviceId` accepts the canonical identity
reported by the Brush probe, not an NVIDIA or WGPU enumeration ordinal.
`-CheckOnly` prepares/checks without launching Tauri. Build dependencies and the
Brush Rust 1.95.0 toolchain are independently checked by its build script.

The candidate builder holds an exclusive preparation lock, stages into a unique
sibling directory and publishes only after all file hashes, source/patch build
records, versions and machine capabilities pass. Interrupted staging directories
are never selected as packs. A subsequent invocation may reuse verified archives
and the Brush cache. It does not overwrite an existing damaged or outdated pack;
preserve that directory for diagnosis and choose a fresh `-OutputRoot` for an
explicit rebuild. An existing `.prepare.lock` reports its owning PID/start time;
remove a stale lock only after confirming that process no longer prepares it.
Offline mode requires all three locked archives and cached Brush build inputs.

These scripts check file/DLL closure and command startup contracts. Actual
forward/backward probes, backend stability and training remain separate gates.
The candidate carries `distribution_status` stating that native macOS regression
and the full dependency license audit remain pending. It is not an approved
full installer and does not replace the legacy pack's license/SBOM workflow.

For an isolated internal installer or portable application containing this
verified candidate, explicitly select the new mode:

```powershell
./scripts/windows/Build-FullInstaller.ps1 -AlignmentCandidate -OfflineEngines -SkipAcquire
./scripts/windows/Build-WindowsRelease.ps1 -AlignmentCandidate -OfflineEngines -SkipAcquire
# Validate all candidate inputs and generate the resource config without building:
./scripts/windows/Build-FullInstaller.ps1 -AlignmentCandidate -SkipAcquire -CheckOnly
```

The displayed application name, window title, executable and shortcut name are
`MetOrigin Splat`. The internal identifier remains
`com.metorigin.splat.alignment-candidate`; the candidate's custom NSIS template
retains its original installation registry keys and isolated default directory
so a display-name change does not adopt the legacy release installation or lose
the candidate's settings and project index. Builds use an isolated Cargo cache
and a unique directory under `artifacts/windows/alignment-candidate/<pack-id>/`,
publishing `MetOrigin-Splat-Setup.exe`. Historical artifacts keep their recorded
names and hashes. The generated
configuration uses only the selected candidate's resource inputs, relative to
the Tauri source directory, without embedding the developer's absolute paths.
The pinned Tauri NSIS template's MIT notice is additionally installed under
`resources/licenses/tauri/NSIS-LICENSE-MIT.txt`. Its upstream source and exact
identity-only template changes are recorded in
`apps/desktop/src-tauri/nsis/alignment-template-source.json`. The installer
updates only legacy desktop/Start-menu shortcuts owned by the selected install
directory; existing taskbar pins are managed by Windows separately.

The Windows window starts centered at 1200 by 768 logical pixels and shrinks to
the monitor workarea when needed. Its icon exports use the same approved v4
master as macOS, with only a deterministic transparent-margin crop before
resizing. See [Windows icon sources](../../design/app-icon/windows/README.md).

The process guard excludes only the current installer/uninstaller PID obtained
from `GetCurrentProcessId`. This also permits NSIS maintenance's in-place
`_?=$INSTDIR` uninstall while still rejecting other applications or engines in
that installation, including another process named `uninstall.exe`. Native
fixtures cover these paths without touching an installed application, real
desktop shortcuts or registry entries.

Metadata includes both engine build records and explicitly retains pending Mac
and license gates. The builder captures relative file SHA-256 inventories of
application sources, locks, prepared public assets, relevant hooks/provenance and
the selected pack resources before Tauri build. It compares them again after
build hooks and refuses publication on any added, removed or changed input. It
also records the actual built frontend and raw application hashes. Its explicit
prebuild dependency graph additionally selects the root pnpm patches, copied UI
license/notice files, active WebP compressed payloads and reviewed build evidence,
and the theme's selected fonts/licenses. Other node_modules, unrelated docs,
arbitrary build/cache trees and private environment/runtime logs are excluded.
Code should remain stable while a candidate is building; a source-change rejection
requires a new build after edits settle.
The NSIS path separately freezes and rechecks its cached NSIS tools, offline
WebView2 installer and selected build-tool binaries, and records the generated
installer script/include hashes. These cached tools must be available before a
provenance-bound NSIS build. `bundle-identity.json` records the raw executable hash
and the expected NSIS payload hash separately: Tauri 2.11.4 temporarily changes its
unique bundle marker from `UNK` to `NSS` and then restores the raw executable.
An installed-file comparison is a separate observation, not implied by that
expected identity.
The portable app includes its resources beside the executable;
the NSIS variant includes the offline WebView2/VC prerequisites. These are build
paths, not evidence that installation or clean-machine/offline relocation passed.
For advanced troubleshooting, `METORIGIN_BRUSH_BACKEND=dx12|vulkan` and a canonical
`METORIGIN_BRUSH_DEVICE_ID` remain optional process overrides. Supplied values must
match a successful compute probe; unsupported overrides fail explicitly. Training
uses the exact verified backend/device rather than switching APIs after failure.

Application runtime fixes require a new timestamped artifact and a new source
inventory. The existing 874-input / `5386…` candidate remains historical evidence
and does not acquire the later no-environment startup fix. The candidate builder
can reuse its isolated Cargo and NSIS caches, then recaptures all inputs before
build and verifies them afterward; it never replaces an existing artifact stamp.

To exercise the production preflight with both override variables absent:

```powershell
./scripts/windows/Test-AlignmentDefaultRuntime.ps1
```

This opt-in native check removes the two keys from the owned Cargo child's
environment using `ProcessStartInfo.EnvironmentVariables.Remove`. The calling
process and machine/user environment remain untouched and are checked afterward.
It invokes the production Rust preflight and the real eight-Gaussian forward/
backward probe, expects DX12 and a canonical device, and writes a fresh evidence
directory under `target/windows-default-runtime-validation/`. It creates no
project, runs no training and launches no application UI. A successful check and
normal installed-application UI acceptance must be recorded against the rebuilt
source/application identity; this command's existence is not a pass result.

## Build

From the repository root on Windows 10/11 x64:

```powershell
pnpm package:windows:full
```

The command verifies the pinned Node, pnpm and Rust toolchain, acquires the
locked components, and prepares and hashes the engine staging tree. It builds
and verifies the Brush live-preview companion, checks the stock engines,
then builds the Tauri NSIS bundle and publishes it as:

```text
artifacts/windows/installer/MetOrigin-Splat-Full-Setup-0.1.0-internal.exe
```

The installer checksum and review metadata are written next to the installer.
The isolated Cargo bundle directory is a build cache, not the delivery directory. The staging
tree is generated at `target/distribution/windows-x64/` and is intentionally
ignored by Git.

For an engine-only refresh or verification:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

`Acquire-EngineArchives.ps1 -Offline` can be used after all four files named in
`engine-lock.json` have been placed in `.engines/downloads`. Offline companion
builds additionally need the pinned Brush source archive and cached Cargo dependencies;
see [engine integration](../../docs/engine-integration.md). An exact installed
copy of the locked VC++ Runtime is also detected automatically.

## Distribution boundary

The GitHub workflow is manual (`workflow_dispatch`) and uploads an unsigned
artifact for 14 days. It does not create a GitHub Release. Before any public
distribution, resolve every gate documented in the generated
`THIRD_PARTY_NOTICES.md`, complete the SBOM review and clean-machine compatibility
matrix. Stable releases require signing; explicitly labelled unsigned Alpha
candidates may be prepared under the release policy.

The installer now includes dependency license texts and an explicitly incomplete
CycloneDX review SBOM. Use `scripts/windows/Publish-WindowsDraft.ps1 -Tag
v0.1.0-alpha.1` after a clean committed build to upload a maintainer-only draft.
See [Windows Alpha preparation](../../docs/windows-alpha-release.zh-CN.md) for the
remaining corresponding-source, binary dependency and model-weight evidence.
