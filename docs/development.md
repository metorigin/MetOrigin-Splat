# MetaOrigin Splat — Development Guide

## Prerequisites

- **Rust**: stable toolchain (install via [rustup](https://rustup.rs/))
- **Node.js**: 18+ (LTS recommended)
- **pnpm**: `npm install -g pnpm`
- **Windows SDK**: For Windows builds, install [Windows SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/) and [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with "Desktop development with C++" workload.

### Tauri Prerequisites

See [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your platform.

## Getting Started

```bash
# Clone the repository
git clone https://github.com/metorigin/splat.git
cd splat

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

## Project Structure

```
splat/
├── apps/
│   └── desktop/          # Tauri application
│       ├── src/          # React + TypeScript frontend
│       ├── src-tauri/    # Rust backend (Tauri commands)
│       └── package.json
├── crates/               # Rust workspace crates
│   ├── splat-domain/     # Core domain types & state machines
│   ├── splat-project/    # Project CRUD & serialization
│   ├── splat-pipeline/   # Pipeline orchestration & stage execution
│   ├── splat-process/    # External process runner
│   ├── splat-hardware/   # Hardware detection & profiling
│   ├── splat-engine-ffmpeg/  # FFmpeg adapter
│   ├── splat-engine-colmap/  # COLMAP adapter
│   └── splat-engine-brush/   # Brush training adapter
├── schemas/              # JSON Schema definitions
├── presets/              # Training presets
├── docs/                 # Documentation
├── scripts/              # Build & utility scripts
├── tests/                # Integration & E2E tests
│   ├── fixtures/         # Test data
│   ├── integration/      # Integration tests
│   └── e2e/              # End-to-end tests
└── vendor/licenses/      # Third-party license texts
```

## Testing Strategy

### Unit Tests

Coverage targets:
- State machine transitions
- Project serialization / deserialization
- Path generation
- Error mapping
- Log parsing
- Parameter validation
- Preset loading
- Project version migration

### Integration Tests

Coverage targets:
- Process runner
- FFmpeg test videos
- COLMAP small datasets
- Brush small training samples
- Project creation and recovery
- Process cancellation

### E2E Tests

Test flow:
```
Launch app
→ New project
→ Select video
→ Complete frame extraction
→ Complete COLMAP
→ Start training
→ Generate output
→ Open results
```

E2E tests do not need to run full training on every commit. CI uses:
- Mock engines
- Fake processes
- Small fixtures

Real GPU E2E runs on manual release workflow.

### Fixture Strategy

- Do not commit large user media to the repository
- Small test fixtures in `tests/fixtures/`
- Large test data via: Release Assets, separate test repo, object storage, download scripts
- Always record: source, license, checksum, expected result

## CI/CD

### Pull Request CI

Each PR runs:
```
Rust fmt
Rust clippy
Rust unit tests
TypeScript lint
TypeScript typecheck
Frontend tests
Schema validation
License checks
```

### Windows Build

- Rust release build
- Frontend production build
- Tauri build
- Installer generation
- Artifact upload

### Release Workflow

Trigger: Git tag `v*.*.*`

Executes:
1. Version validation
2. Changelog generation
3. Build installer & portable package
4. Generate SHA-256
5. Upload to GitHub Release
6. Attach third-party licenses
7. Mark as pre-release or release

### Branch Strategy

```
main
feature/*
fix/*
docs/*
release/*
```

Rules:
- `main` is always buildable
- Each feature via PR
- At least one CI check must pass before merge
- Squash merge
- Conventional Commits

Examples:
```
feat(pipeline): add resumable stage execution
fix(colmap): handle paths containing non-ascii characters
docs: add Windows development guide
```

## Code Quality

### Rust

- `cargo fmt --check` must pass
- `cargo clippy --all-targets --all-features -- -D warnings` preferred
- No unwrap in production code without justification
- No silently discarded errors
- Public APIs documented
- Modular responsibility, no giant files
- Atomic writes for critical files

### TypeScript

- Strict mode
- No abuse of `any`
- Unified API type sources
- No raw commands in components
- Single-responsibility components
- Long-running task state from unified store / query layer
- Error messages separated from technical details
