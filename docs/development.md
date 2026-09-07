# Development

## Toolchain and startup

The validated desktop target is Windows 10/11 x64. Install Rust **1.97.0** with `x86_64-pc-windows-msvc`, Node.js **22**, pnpm **11.12.0**, Visual Studio C++ Build Tools, the Windows SDK and WebView2 Runtime. Rust and pnpm versions are pinned in [rust-toolchain.toml](../rust-toolchain.toml) and [package.json](../package.json).

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

Frontend tests live beside the components and pages they exercise; Rust tests live in their crates. On non-Windows hosts, core-only CI excludes `splat-desktop`. JSON Schemas and fixtures are validated by the commands in [ci.yml](../.github/workflows/ci.yml).

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

Do not commit:

- Cargo targets (`target/`, root `target-*/`, `.codex-cargo-target/`), frontend output or dependency caches.
- `.engines/`, `artifacts/`, `.artifacts/`, `.test-results/`, coverage or raw logs.
- User `.splat-project` directories, source media, generated PLY/checkpoints or private datasets.
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
