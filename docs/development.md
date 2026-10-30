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

## Engines and live preview

Source checkouts do not contain the engine binaries. See [engine integration](engine-integration.md) for configuring installed engines or preparing the pinned pack:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

The generated engine directory is `target/distribution/windows-x64/engines`; select that directory in Settings & Engines for local use. The downloaded archives remain in `.engines/downloads`. The pack preparation also builds the Brush live-preview companion.

To build that companion separately for an existing Brush installation:

```powershell
pnpm build:brush:live
# With a complete local dependency/source cache:
pnpm build:brush:live -Offline
```

The default output is `.engines/brush-v0.3.0-windows-x64/brush_live.exe`. Use `-OutputDirectory` to place it beside another configured `brush_app.exe`. This builds the companion only, not the complete stock engine pack.

## Routine checks

### Bundled SuperSplat editor

The integrated editor is pinned to official SuperSplat 3.7.0, with splat-transform 3.10.2 and its matching derived WebP codec. The desktop `predev` and `prebuild` scripts run `integrations/supersplat/prepare.mjs`. On the first run this fetches the commit in `integrations/supersplat/upstream.json`, installs its exact npm lockfile, adds the local import/export bridge, and builds the editor into ignored `apps/desktop/public/supersplat/`. Source and dependency caches live under `target/supersplat-*`. Later runs reuse assets when the pinned revision and bridge/build script are unchanged. Use `pnpm prepare:supersplat` to prepare them explicitly. Git and npm are required for preparation; installed applications load these bundled assets without a development server or runtime package installation. If Node's installation has no adjacent npm CLI, set `METORIGIN_NPM_CLI` to `npm-cli.js`.

The editor occupies the main workspace in a same-origin iframe and retains the project sidebar. Completed projects expose an Edit button in the workspace title bar. While editing, the project title/run bar is hidden; Back and Save share the editor toolbar. Back restores the preview and reports. Navigation checks unsaved changes and is blocked during saving. Binary saves carry an exact session ID so stale requests cannot write into a later project's session. Saves are serialized, validated and synced before replacing `output/scene.ply` by a same-directory rename. The session revision advances after each save; no history is created or listed. The bridge accepts only messages from its parent and exposes a bounded import/export protocol. Upstream license and bundled dependency notices are included under `supersplat/`, together with source maps.

Native verification uses an isolated copy of an existing trained model. Start a test build with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9258`, preferably with an isolated `WEBVIEW2_USER_DATA_FOLDER`, then run:

```powershell
node scripts/windows/Validate-ModelEditor.mjs <completed-project-path>
```

This checks WebGPU import, workspace layout and consistent action dimensions, deletion of a subset, cancelled navigation, repeated in-place saves, failure preservation, absence of generated history, preview updates and reopening the saved PLY. It substitutes the folder picker and confirmation responses to avoid unattended OS dialogs. The isolated project is temporarily added to the recent index and removed in cleanup. Evidence and copied models are written under ignored `target/editor-evidence/`. `METORIGIN_TAURI_DEBUG_PORT` overrides the test port.

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

`pnpm test:ux:automated` builds the frontend and uses a local headless Edge session with synthetic IPC data. It covers interaction/layout checks and writes ignored evidence under `.test-results/ux-automation/`. It does not exercise real media, engines, native file dialogs or Windows sleep/resume.

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

Keep raw screenshots, logs, generated models, browser profiles and native reports in `.test-results/` or `.artifacts/`. Record sanitized, dated outcomes only when retaining evidence is useful. Historical [acceptance protocols](../specs/README.md) remain available for broader release verification.

## Windows build outputs

| Command | Result |
| --- | --- |
| `pnpm build` | Frontend production assets in `apps/desktop/dist/` |
| `pnpm build:windows:release` | Application executable, checksum and metadata in `artifacts/windows/app/` |
| `pnpm prepare:windows:engines` | Engine/license staging tree in `target/distribution/windows-x64/` |
| `pnpm package:windows:full` | Internal NSIS installer, checksum and metadata in `artifacts/windows/installer/` |

The release application build uses `target/windows-release-build` as an isolated Cargo cache. Do not distribute executables directly from a Cargo cache. The standalone app build and the full engine installer are separate operations; public binary distribution remains subject to [release gates](release-process.md).

## What belongs in Git

Commit source, tests, schemas, presets, build/validation scripts, configuration, current documentation and required license notices. Commit both `Cargo.lock` and `pnpm-lock.yaml` when their dependencies change. The source under `integrations/brush-live/` is necessary to reproduce the companion build.

The pinned WebP dependency under `integrations/supersplat/webp-overlay-3.10.2/` is a deliberate build input; `webp-overlay/` retains the historical 3.4.2 source and evidence. Keep its hash-locked payload, source patches, license texts and selected build-provenance records together, including the specifically allowlisted evidence logs. Their original bytes are verified by the preparation and packaging checks; do not trim upstream whitespace or replace them with unrelated local build output.

Do not commit:

- Cargo targets (`target/`, root `target-*/`, `.codex-cargo-target/`), frontend output or dependency caches.
- `.engines/`, `artifacts/`, `.artifacts/`, `.test-results/`, coverage or raw logs.
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
