# Development

## Toolchain and startup

The validated desktop target is Windows 10/11 x64. Install Rust **1.97.0** with `x86_64-pc-windows-msvc`, Node.js **26**, pnpm **11.12.0**, Visual Studio C++ Build Tools, the Windows SDK and WebView2 Runtime. Development and CI use Node 26; [`.node-version`](../.node-version) is CI's version source, and [`.nvmrc`](../.nvmrc) provides the same version for nvm. Rust and pnpm versions remain pinned in [rust-toolchain.toml](../rust-toolchain.toml) and [package.json](../package.json).

Use your preferred Node manager and confirm `node --version` reports `v26.x`. If you use nvm, run `nvm install` and `nvm use` from the repository root to read `.nvmrc`; these commands are optional for other managers. Vite+ users should also verify the actual `node --version` output is 26. If pnpm 11.12.0 is not available, install it with the active Node 26 installation's npm:

```sh
npm install --global pnpm@11.12.0
node --version
pnpm --version
```

Historical validation records retain the Node version actually used for those runs; they do not establish a completed Node 26 validation matrix.

`pnpm test` disables Node's server-side Web Storage in the Vitest runner and fork workers so browser tests use jsdom's Storage. Vitest 2 does not automatically forward this runner flag to its forks. This test-only setting does not change application storage or the desktop WebView.

On 2026-10-30, local macOS validation with Node 26.13.0 / pnpm 11.12.0 passed lint, typecheck, all 438 frontend tests, 55 SuperSplat packaging tests, 60 Spark and 39 Three lifecycle/provenance tests, 16 copied-UI provenance tests, the schema fixtures and base schema checks, 28 macOS packaging verifier tests, and the frontend build. Frozen-lockfile offline validation preserved both lockfiles. Matching application-license evidence was regenerated and selected for the next package build; the previous collection was archived. Logs and exact scope are in `.test-results/node26-baseline/`. Hosted CI, Windows execution, native app acceptance and a new DMG were not run as part of this toolchain change.

The experimental macOS route uses Apple Silicon, Xcode command-line tools, the same application Rust/Node/pnpm versions, and native arm64 engines. Brush's isolated source build pins its own Rust toolchain. Follow [macOS build recipes](../scripts/macos/README.md) and [engine packaging](../packaging/macos-arm64/README.md); stock Windows binaries cannot be reused. The selected deployment target is 15.0, but acceptance on macOS 15 and 16 GB hardware is still open.

Mac runtime and native-source paths are defined in [`engine-paths.json`](../packaging/shared/engine-paths.json). Debug startup uses `.engines/macos-arm64/development/` (FFmpeg 8.1.2, COLMAP 4.1.0 and Brush `metorigin-macos.5`); the full package uses the separately frozen Alpha `.6` pack under `.engines/macos-arm64/distribution/`. Explicit development environment overrides retain priority; mapping a saved path to the same verified pack preserves its engine identity. See [engine resolution and canonical paths](engine-integration.md#macos-runtime-and-source-layout-2026-11-01).

Mac engines are read directly from their canonical `.engines/macos-arm64/` locations. Development/build preparation does not create `target/macos-m0` or `target/distribution/macos-arm64`; `cargo clean` removes compiled outputs without removing or recreating runtime engines. Preparation migrates saved distribution paths only after verifying that the canonical pack has the same identity; unrelated custom settings are preserved.

Development COLMAP dependencies use the canonical `.engines/macos-arm64/development/colmap-deps/` prefix, installed by Conda from the pinned 171-package lock. Rebuild COLMAP 4.1.0 in the fresh native cache against this prefix, keeping the development profile with CGAL, LSD, MVS and downloads enabled; see the [current native commands](../scripts/macos/README.md#当前路径入口2026-11-01). The original dependency environment and development install are retained under `.engines/macos-arm64/archive/colmap/` for historical audit inputs. A new development build has its own hash and validation record; it does not inherit the original binary's evidence or make the environment portable.

After preparing engines, a development app can be built with:

```sh
MACOSX_DEPLOYMENT_TARGET=15.0 pnpm --dir apps/desktop tauri build \
  --debug --bundles app --config src-tauri/tauri.macos.conf.json
```

This overlay does not embed engines. Use the verified full-package script for a self-contained candidate. On the tested Xcode 27 host, release builds require `CARGO_PROFILE_RELEASE_STRIP=none` to avoid corrupting host proc-macro dylibs; retain this setting in build evidence. Do not use Brush's `--all-features`, which also enables the separate native MSL implementation.

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

Tauri starts Vite on port 1420 through `beforeDevCommand`. Start only this command for normal desktop development. Restart it after Rust/Tauri changes. Vite handles frontend hot reload.

For frontend-only work, use `pnpm dev`, then open `http://localhost:1420/?ui-preview`. Add `&preview-page=new-project` and optionally `&preview-step=2` or `3` to inspect wizard steps with sample data. The sample mode is gated by `import.meta.env.DEV` and cannot replace native or GPU validation.

### First Windows alignment build

`pnpm dev:windows` also needs Python **3.10 or newer** on PATH. Its Brush source build uses a separately pinned Rust **1.95.0** toolchain through rustup and downloads the locked upstream sources and DXC inputs on its first online run. These inputs are independent of the application's Rust 1.97.0 build.

For an internal alignment installer from a checkout with no engine or bundler cache:

```powershell
pnpm install --frozen-lockfile
pnpm dev:windows -CheckOnly
./scripts/windows/Build-FullInstaller.ps1 -AlignmentCandidate -SkipAcquire
```

The candidate builder freezes the application build tools before compiling once, prepares empty NSIS/WebView2 caches with an unpublished Tauri bundle, then freezes the bundler inputs and generates the final bundle. Both tool inventories and the source inputs are rechecked before delivery. The preparation installer remains in the Cargo cache and is removed before the final bundle. Only the final package, with matching source/tool evidence and a verified NSIS WebView2 reference, is delivered. Evergreen still resolves its current download over the network even when engine preparation uses `-OfflineEngines`; a changed runtime during the final bundle rejects publication. See [Windows packaging](../packaging/windows-x64/README.md) for the separate legacy default installer and the pending candidate gates.

## Engines and live preview

Source checkouts do not contain the engine binaries. See [engine integration](engine-integration.md) for configuring installed engines or preparing the pinned pack:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

The generated engine directory is `.engines/windows-x64/distribution/engines`; select that directory in Settings & Engines for local use. Downloaded archives use `.cache/metorigin/downloads/engines/windows-x64/`. The pack preparation also builds the Brush live-preview companion.

To build that companion separately for an existing Brush installation:

```powershell
pnpm build:brush:live
# With a complete local dependency/source cache:
pnpm build:brush:live -Offline
```

The default output is `.engines/windows-x64/development/brush-v0.3.0/brush_live.exe`. Use `-OutputDirectory` to place it beside another configured `brush_app.exe`. This builds the companion only, not the complete stock engine pack.

## Routine checks

### Bundled SuperSplat editor

The integrated editor is pinned to official SuperSplat 3.7.0, with splat-transform 3.10.2 and its matching derived WebP codec. The desktop `predev` and `prebuild` scripts run `integrations/supersplat/prepare.mjs`. On the first run this fetches the commit in `integrations/supersplat/upstream.json`, installs its exact npm lockfile, adds the local import/export bridge, and builds the editor into ignored `apps/desktop/public/supersplat/`. The source checkout lives at `.cache/metorigin/sources/supersplat/upstream/`, and npm uses `.cache/metorigin/downloads/npm/supersplat/`; both paths come from [`cache-paths.json`](../packaging/shared/cache-paths.json) through [`cache-paths.mjs`](../scripts/shared/cache-paths.mjs). Later runs reuse assets when the pinned revision and bridge/build script are unchanged. Use `pnpm prepare:supersplat` to prepare them explicitly. Git and npm are required for preparation; installed applications load these bundled assets without a development server or runtime package installation. If Node's installation has no adjacent npm CLI, set `METORIGIN_NPM_CLI` to `npm-cli.js`.

Preparation creates the new cache directories as needed and does not fall back to the old `target/supersplat-source/` or `target/supersplat-npm-cache/` locations. When migrating an existing cache, verify the copied checkout and prepared assets at the new locations before removing the old copies; do not substitute directory links. This layout change updates the preparation signature. Before the next macOS package build, archive and regenerate application-license evidence using the [packaging guide](macos-packaging.zh-CN.md). Its current default is `artifacts/licenses/macos-arm64/current/`.

The editor occupies the main workspace in a same-origin iframe and retains the project sidebar. Completed projects expose an Edit button in the workspace title bar. While editing, the project title/run bar is hidden; Back and Save share the editor toolbar. Back restores the preview and reports. Navigation checks unsaved changes and is blocked during saving. Binary saves carry an exact session ID so stale requests cannot write into a later project's session. Saves are serialized, validated and synced before replacing `output/scene.ply` by a same-directory rename. The session revision advances after each save; no history is created or listed. The bridge accepts only messages from its parent and exposes a bounded import/export protocol. Upstream license and bundled dependency notices are included under `supersplat/`, together with source maps.

Native verification uses an isolated copy of an existing trained model. Start a test build with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9258`, preferably with an isolated `WEBVIEW2_USER_DATA_FOLDER`, then run:

```powershell
node scripts/windows/Validate-ModelEditor.mjs <completed-project-path>
```

This checks WebGPU import, workspace layout and consistent action dimensions, deletion of a subset, cancelled navigation, repeated in-place saves, failure preservation, absence of generated history, preview updates and reopening the saved PLY. It substitutes the folder picker and confirmation responses to avoid unattended OS dialogs. The isolated project is temporarily added to the recent index and removed in cleanup. Copied models use a temporary workspace; reports are published under `artifacts/verification/windows-x64/tests/model-editor/current/` or `failed/`. Failure or explicit `--keep` retains debug data with that result. `METORIGIN_TAURI_DEBUG_PORT` overrides the test port.

### Application checks

Run checks relevant to the change:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

Frontend tests live beside the components and pages they exercise; Rust tests live in their crates. Linux core-only CI excludes `splat-desktop`; macOS arm64 baseline CI includes the desktop crate and an app build. This baseline does not establish Metal GPU or native UI acceptance. JSON Schemas and fixtures are validated by the commands in [ci.yml](../.github/workflows/ci.yml).

`pnpm test:ux:automated` builds the frontend and uses a local headless Edge session with synthetic IPC data. It covers interaction/layout checks and publishes reports under `artifacts/verification/<host-platform>/tests/ux-automation/current/` or `failed/`, cleaning its temporary workspace. It does not exercise real media, engines, native file dialogs or Windows sleep/resume.

The Windows CI gate also runs:

```powershell
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

## Real-engine validation

These integration tests are ignored by default. Run them against disposable test projects and media you are authorized to use; they create or modify files and may run substantial CPU/GPU workloads.

| Test target in `splat-pipeline` | Required environment variables / prior output |
| --- | --- |
| `real_ffmpeg` | `METORIGIN_TEST_VIDEO`, `METORIGIN_TEST_PROJECT_DIR`, `METORIGIN_TEST_FFMPEG`, `METORIGIN_TEST_FFPROBE` |
| `real_colmap` | `METORIGIN_TEST_PROJECT_DIR` containing prepared frames; `METORIGIN_TEST_COLMAP` |
| `real_brush` | `METORIGIN_TEST_PROJECT_DIR` containing a valid COLMAP result; `METORIGIN_TEST_BRUSH` |
| `real_image_pipeline` | `METORIGIN_TEST_IMAGE_DIR`, isolated `METORIGIN_TEST_PROJECT_ROOT`, `METORIGIN_TEST_COLMAP` |

After setting the appropriate variables, select a target, for example:

```powershell
cargo test -p splat-pipeline --test real_brush -- --ignored --nocapture
```

The [2026-07-13 engine baseline](validation/engine-baseline.md) records one historical run and its compatibility findings. It is not a current all-hardware pass claim.

For native Gaussian rendering and a separate training run, follow [the live-preview validation procedure](gaussian-live-preview.zh-CN.md). `pnpm test:tauri:native-fast` and `pnpm test:tauri:native-failure-recovery` provide additional opt-in native scenarios. Their setup variables and behavior are documented in [Run-NativeTauriFastValidation.mjs](../scripts/windows/Run-NativeTauriFastValidation.mjs) and [Run-NativeTauriFailureRecoveryValidation.mjs](../scripts/windows/Run-NativeTauriFailureRecoveryValidation.mjs). The latter intentionally terminates its own test engine process and requires an isolated project with valid checkpoints.

Keep retained reports, screenshots and logs under `artifacts/verification/<platform>/`; test models and browser profiles are temporary work data unless explicitly retained for diagnosis. Record sanitized, dated outcomes only when retaining evidence is useful. Historical [acceptance protocols](../specs/README.md) remain available for broader release verification.

## Generated files and cleanup

Native build, engine, validation and packaging data use four roots. Scripts resolve them through the shared configuration under `packaging/shared/`; do not create another output root for each test or packaging run.

| Root | Role and cleanup boundary |
| --- | --- |
| `target/` | Cargo compilation and Tauri bundle intermediates; rebuildable with the toolchain and inputs available |
| `.cache/metorigin/` | Reusable downloads, source checkouts, native build caches and local tools; source checkouts with local changes or untracked work require review before removal |
| `.engines/` | Prepared development, alignment and frozen distribution engines; keep the selected pack with its intrinsic notices and provenance |
| `artifacts/` | Delivered packages, formal verification reports and license collections; prune by recorded references and retention rules |

```text
target/
  aarch64-apple-darwin/
  windows-release-build/
  windows-alignment-release-build/
.cache/metorigin/
  downloads/
  sources/
  build/
  tools/macos-arm64/
.engines/
  macos-arm64/{development,distribution,archive}/
  windows-x64/{development,distribution,alignment}/
artifacts/
  packages/{macos-arm64,windows-x64}/
  verification/{macos-arm64,windows-x64}/
  licenses/{macos-arm64,windows-x64}/
```

Ordinary tests use an automatically cleaned system-temporary workspace. Their retained reports use `artifacts/verification/<platform>/tests/<tool>/current/` for success and `failed/` for failure; a later success does not erase the latest failure. The shared options are `--keep` or `METORIGIN_KEEP_TEST_OUTPUT=1` to retain debug work data, and `--report <tool-root>` to select a report root under `artifacts/verification/`. Native scenarios also accept `METORIGIN_NATIVE_REPORT_DIR` as that tool root. Failures retain debug data automatically under the selected result's `debug/` directory. Explicit caller project paths are never cleanup targets. Native validation that deliberately retains a dataset must say so in its report; it must not silently add another permanent test directory.

Current tool names are `ux-automation`, `gaussian-preview`, `model-editor`, `native-tauri-fast`, `native-tauri-failure-recovery` and `ui-sources`. Repeated ordinary runs update the relevant success or failure slot instead of accumulating permanent timestamped workspaces.

Package retention keeps the latest registered package run per platform with its referenced verification and license evidence. Ordinary unreferenced test results keep the latest success and latest failure per tool; an unresolved failure, release baseline or explicit pin remains protected. Historical audit-manifest references also protect their inputs. Age alone is not permission to delete a referenced receipt or a modified source checkout.

The retention `apply` command previews changes by default; `--apply` performs the reviewed cleanup:

```sh
node scripts/shared/artifact-retention.mjs apply --platform macos-arm64
node scripts/shared/artifact-retention.mjs apply --platform macos-arm64 --apply
```

Use `--platform windows-x64` for Windows. Package producers register a successful final report, delivered package file or owned directory, and optional license collection with `record`, which applies package retention automatically. Explicit release baselines can be protected or released with `pin` and `unpin`:

```sh
node scripts/shared/artifact-retention.mjs record --platform macos-arm64 \
  --report artifacts/verification/macos-arm64/build.EXAMPLE/final.json \
  --package artifacts/packages/macos-arm64/EXAMPLE.dmg \
  --license-root artifacts/licenses/macos-arm64/current
node scripts/shared/artifact-retention.mjs pin --platform macos-arm64 \
  --report artifacts/verification/macos-arm64/build.EXAMPLE/final.json
node scripts/shared/artifact-retention.mjs unpin --platform macos-arm64 \
  --report artifacts/verification/macos-arm64/build.EXAMPLE/final.json
```

Replace the example paths with an actual successful build; `pin` and `unpin` require a registered report. These commands do not run a build or prove acceptance. Package pruning preserves independent current and historical license collections, including audit-manifest inputs; it does not blindly remove their root. It does not target source, user projects, engines, toolchains or dirty source caches. Local Figma working files belong under ignored `design/local/figma-redesign/`, and local Rust/Corepack tools under `.cache/metorigin/tools/macos-arm64/`; they are not disposable test output.

Obsolete test payloads, imported Brush M0–M4 build caches and duplicate distribution packs are removed after retaining compact build identities, migration receipts and license originals. The local cleanup receipt and compressed records are under `artifacts/verification/macos-arm64/cleanup-current/`. Historical path mappings remain as a trace; `artifacts:resolve` returns `exists: false` for payloads that have been pruned. Current engines, current license collections and the latest delivered package with its verification report are retained independently.

## macOS build outputs

macOS DMGs, package-verification reports and application-license evidence share a layout defined in [`packaging/shared/artifact-paths.json`](../packaging/shared/artifact-paths.json) and resolved by [`scripts/shared/artifact-paths.mjs`](../scripts/shared/artifact-paths.mjs). Stable engine paths come from [`engine-paths.json`](../packaging/shared/engine-paths.json). The current defaults are:

| Output | Path |
| --- | --- |
| Compiled release application | `target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app` |
| New release or debug DMG | `artifacts/packages/macos-arm64/` |
| New build reports and preflight logs | `artifacts/verification/macos-arm64/build.XXXXXX/` |
| Last successful selected build report | `artifacts/verification/macos-arm64/latest.json` |
| Current application-license evidence | `artifacts/licenses/macos-arm64/current/` |
| Archived application-license evidence | `artifacts/licenses/macos-arm64/archive/` |
| Mac development engines | `.engines/macos-arm64/development/` |
| Frozen full-package engine input | `.engines/macos-arm64/distribution/` |

Run `bash scripts/macos/build-macos-app.sh --internal-alpha`; see the [macOS packaging guide (中文)](macos-packaging.zh-CN.md) for inputs and options. The compiled debug application remains under `target/aarch64-apple-darwin/debug/`. A failed build does not replace `latest.json`; `--app-only` can update it without a DMG.

SuperSplat and native-engine sources/downloads use `.cache/metorigin/`; stable Mac development and distribution engines use `.engines/macos-arm64/`. Imported native build trees are retained under `.cache/metorigin/build/engines/macos-arm64/imported/` as historical records. Fresh native builds use the separate `native/` tree and do not resume those path-bound caches. No target compatibility aliases are prepared; Mac runtime engines are read directly from the canonical `.engines/` paths. The collector refuses to overwrite current application-license evidence; archive it before recollecting when its inputs change. The builder generates its Tauri resource configuration from the shared paths and still embeds the evidence as `resources/app-licenses/`. Historical evidence contents and their recorded paths remain unchanged; the local [migration map](../artifacts/licenses/macos-arm64/migration-map.json) records relocated license directories. Historical receipt contents and original path fields remain unchanged when archived; migration records identify their current locations. Design sources belong under `design/`, while local toolchains belong under `.cache/metorigin/tools/`.

## Windows build outputs

| Command | Result |
| --- | --- |
| `pnpm build` | Frontend production assets in `apps/desktop/dist/` |
| `pnpm build:windows:release` | Application executable and delivery files in `artifacts/packages/windows-x64/build.<stamp>/` |
| `pnpm prepare:windows:engines` | Engine/license staging tree in `.engines/windows-x64/distribution/` |
| `pnpm package:windows:full` | Internal NSIS installer and delivery files in `artifacts/packages/windows-x64/build.<stamp>/` |

Windows build reports use `artifacts/verification/windows-x64/build.<stamp>/final.json`; `latest.json` selects the most recent successful package report. The release application build uses `target/windows-release-build` as an isolated Cargo cache. Do not distribute executables directly from a Cargo cache. The standalone app build and the full engine installer are separate operations; public binary distribution remains subject to [release gates](release-process.md).

## What belongs in Git

Commit source, tests, schemas, presets, build/validation scripts, configuration, current documentation and required license notices. Commit both `Cargo.lock` and `pnpm-lock.yaml` when their dependencies change. The source under `integrations/brush-live/` is necessary to reproduce the companion build.

The pinned WebP dependency under `integrations/supersplat/webp-overlay-3.10.2/` is a deliberate build input; `webp-overlay/` retains the historical 3.4.2 source and evidence. Keep its hash-locked payload, source patches, license texts and selected build-provenance records together, including the specifically allowlisted evidence logs. Their original bytes are verified by the preparation and packaging checks; do not trim upstream whitespace or replace them with unrelated local build output.

Do not commit:

- `target/`, `.cache/metorigin/`, `.engines/`, `artifacts/`, frontend output, dependency caches, coverage or raw logs.
- Local design drafts under `design/local/`.
- User project directories (ordinary names or legacy `.splat-project`), source media, generated PLY/checkpoints or private datasets.
- Local environment files, credentials, signing keys or personal editor settings.

Put local data inside the ignored directories instead of adding broad exclusions for every image or binary extension: application icons and deliberately licensed test fixtures may belong in Git. Git ignore rules do not remove already tracked files, so inspect both the tracked diff and untracked candidates before staging:

```powershell
git status --short
git diff --stat
git diff --check
git ls-files --others --exclude-standard
# After intentionally staging the files for a change:
git diff --cached --stat
```

Keep persisted state atomic, external execution inside adapters/`splat-process`, and frontend IPC behind the service layer. See [architecture](architecture.md), [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).

Historical local paths can be located with `pnpm artifacts:resolve -- <old-path>`. Immutable receipts keep their original text; the local migration index resolves their current location. Package retention also protects runs referenced by the current `latest*.json` selectors, in addition to explicitly pinned runs.
