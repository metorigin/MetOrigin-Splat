# MetOrigin Splat Development Guide

## Supported development environment

The actively validated development environment is Windows 10/11 x64 with:

- Rust 1.97.0, pinned by `rust-toolchain.toml`
- Node.js 22
- pnpm 11.12.0, pinned by the root `packageManager` field
- Windows SDK
- Visual Studio Build Tools with the Desktop development with C++ workload
- The Windows prerequisites from the [Tauri guide](https://v2.tauri.app/start/prerequisites/)

Other host platforms may build individual Rust crates, but they are not supported desktop release targets yet.

## Getting started

```powershell
git clone https://github.com/metorigin/MetOrigin-Splat.git
Set-Location MetOrigin-Splat

pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` starts only the Vite frontend. Use `pnpm tauri dev` when testing desktop commands, dialogs, filesystem integration, engine detection, or pipeline execution.

## External engines

The application integrates with three external programs through Rust adapters:

- FFmpeg / FFprobe for media probing and frame extraction
- COLMAP for feature extraction, matching, and sparse reconstruction
- Brush for Gaussian Splatting training and PLY generation

Frontend and core unit tests do not require these programs. Running the complete pipeline and the ignored real-engine tests requires compatible local engine installations.

The versions used for the current Windows technical validation are recorded in `packaging/windows-x64/engine-lock.json`. That lock file and the packaging scripts are reproducibility inputs, not permission to republish the downloaded programs. Read `packaging/windows-x64/README.md` and `packaging/windows-x64/THIRD_PARTY_NOTICES.template.md` before creating or distributing an engine bundle.

## Repository structure

```text
MetOrigin-Splat/
├── apps/desktop/
│   ├── src/                  # React and TypeScript frontend
│   ├── src-tauri/            # Tauri application and Rust commands
│   └── package.json
├── crates/
│   ├── splat-domain/         # Domain types and state machines
│   ├── splat-project/        # Project persistence and migration
│   ├── splat-process/        # External process execution
│   ├── splat-pipeline/       # Pipeline orchestration and integration tests
│   ├── splat-hardware/       # Hardware and engine discovery
│   ├── splat-engine-ffmpeg/  # FFmpeg adapter
│   ├── splat-engine-colmap/  # COLMAP adapter
│   └── splat-engine-brush/   # Brush adapter
├── schemas/                  # JSON Schemas and validation examples
├── presets/                  # Fast, balanced, and quality presets
├── docs/                     # Architecture and development documentation
├── packaging/                # Internal packaging definitions and notices
└── scripts/                  # Build and packaging utilities
```

Rust integration tests live alongside the relevant crate. Frontend tests live beside the components and pages they cover.

## Validation commands

Run the checks relevant to your change before opening a pull request:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ux:automated

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

`pnpm test:ux:automated` is a Windows-only, dependency-free frontend acceptance preflight. It builds the production
frontend, opens it in a local headless Microsoft Edge session through the CDP pipe, injects synthetic Tauri IPC data,
checks page-context isolation, active-project conflict handling, menu/tab/drawer keyboard behavior, accessibility
names, forced-colors/reduced-motion hooks, conservative 1024×768 scale viewports, and 20-sample timing runs. It reads
no real project or media and writes only ignored evidence under `.test-results/ux-automation/`.

This preflight does not replace native Tauri/WebView2 scenarios, Windows sleep/resume, external-process failure tests,
real project compatibility/checksums, controlled usability sessions, or independent release sign-off.

For an optional native Fast smoke run with licensed local media, start the debug Tauri app with the packaged engine
directory and a loopback-only WebView2 CDP port, then run `pnpm test:tauri:native-fast` from a second terminal. Provide
`METORIGIN_TEST_VIDEO`, `METORIGIN_TEST_PROJECT_ROOT`, `METORIGIN_NATIVE_REPORT_DIR`,
`METORIGIN_EXPECTED_SOURCE_SHA256`, and `METORIGIN_TAURI_DEBUG_PORT`. The project root must be isolated from the source.
The runner exercises real Tauri IPC, FFmpeg/FFprobe, COLMAP, Brush, pause/resume, checkpoint-preserving cancel/resume,
artifact/PLY validation, and before/after source hashing. Keep its output under ignored `.test-results/`; never commit
media, project directories, private paths, raw logs, or native reports.

After that run has produced at least two valid checkpoints, set `METORIGIN_TEST_PROJECT_PATH` to its isolated project
and run `pnpm test:tauri:native-failure-recovery` from a session allowed to terminate its own test child process. The
runner refuses to inject a fault if any Brush process already exists or if more than one new candidate appears. It
checks localized `E-4003` failure persistence, active-slot cleanup, checkpoint preservation, explicit retry to
Completed, recovered artifacts, source hashing, and recent-index cleanup.

For a Windows desktop release candidate, the frontend and Rust gates above are necessary but not sufficient. Build the local release application through the repository-owned entry point:

```powershell
pnpm build:windows:release
```

This command always uses `mainBinaryName = "MetOrigin Splat"`, builds in the isolated `target/windows-release-build` Cargo directory, and resets `artifacts/windows/app` before publishing exactly one runnable application plus its checksum and sanitized build metadata. The isolated target prevents a currently running development or legacy release executable from blocking a new build. `target/release` remains an internal Cargo cache and must not be used as a delivery directory.

The fully offline internal installer remains a separate, explicit packaging operation:

```powershell
pnpm package:windows:full
```

It publishes the installer, checksum, and packaging metadata to `artifacts/windows/installer`. Both Windows artifact directories are ignored by Git and contain no project data. A release build must exit with code 0 on Windows before the real Tauri scenarios, keyboard-only and forced-colors checks, 1024×768 at 100%/125%/150% scaling checks, compatibility/checksum comparison, controlled usability protocol, and monotonic-clock samples in `specs/001-frontend-ux-improvements/quickstart.md` are executed. Record only sanitized results in `specs/001-frontend-ux-improvements/validation-results.md`; do not commit screenshots containing project names, private paths, media, raw logs, or diagnostics.

The UX feature is additive: it does not change `project.json`, `schemas/project.schema.json`, recent-project record fields, or legacy Tauri mutation signatures. When extending the boundary, add a service wrapper and contract tests instead of importing raw Tauri `invoke` in a page, component, or hook.

Schema validation is also performed in GitHub Actions with `ajv-cli`.

### Real-engine tests

The following tests are ignored by default because they require pinned engines, licensed test media, disk space, and compatible hardware:

- `crates/splat-pipeline/tests/real_ffmpeg.rs`
- `crates/splat-pipeline/tests/real_colmap.rs`
- `crates/splat-pipeline/tests/real_brush.rs`
- `crates/splat-pipeline/tests/real_image_pipeline.rs`

Their environment variables, commands, and latest validation evidence are documented in `docs/plans/technical-spike.md`. Do not commit private or unlicensed test media. Public fixtures must record their source, license, checksum, and expected result.

## CI behavior

Pull requests targeting `main` run:

- Rust formatting, Clippy, and unit/integration tests
- JSON Schema validation
- Windows frontend lint, type checking, and production build
- Windows Rust checks and a Tauri debug build without a bundle

The full offline Windows installer workflow is manual and internal-only. It does not create a public GitHub Release.

## Code quality

### Rust

- Keep `cargo fmt` and Clippy clean.
- Propagate or intentionally map errors; do not silently discard them.
- Avoid `unwrap` in production paths unless an invariant is documented.
- Use atomic writes for project state and other critical files.
- Keep external command construction inside engine adapters and `splat-process`.

### TypeScript

- Keep strict type checking enabled.
- Do not call raw Tauri command names directly from components; use the service layer.
- Keep long-running task state in the shared application context.
- Separate user-facing error summaries from technical diagnostics.

## Contribution and security

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before submitting a change. Report vulnerabilities privately according to [SECURITY.md](../SECURITY.md); do not open a public issue for a suspected security problem.
