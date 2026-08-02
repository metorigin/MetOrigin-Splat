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

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

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
