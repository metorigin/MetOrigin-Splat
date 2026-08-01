# MetOrigin Splat

[简体中文](README.zh-CN.md)

> **Alpha / source preview:** the source code is available for development and review. No public binary release or supported offline installer is available yet.

MetOrigin Splat is a Windows-first desktop application for turning videos or photos into Gaussian Splatting scenes with local compute. User media is processed locally by the application and is not uploaded to a cloud service.

## Project status

The core desktop workflow, project model, external-process orchestration, engine adapters, recovery logic, preview, and export path are implemented and covered by automated tests. The project is still pre-release software:

- Windows 10/11 x64 is the only release target currently under validation.
- A compatible NVIDIA GPU is expected for Brush training.
- FFmpeg, COLMAP, and Brush compatibility is pinned and tested against a limited hardware and dataset matrix.
- Real-engine integration tests require local engines, test media, substantial disk space, and a compatible GPU.
- The full offline installer is internal-only until third-party redistribution obligations are complete.

Do not rely on the current project format or command-line behavior as a stable public API.

## Pipeline

```text
Video / Images
    ↓
Media Validation
    ↓
FFmpeg Frame Extraction
    ↓
Image Preprocessing
    ↓
COLMAP Feature Extraction / Matching / Sparse Reconstruction
    ↓
Brush Local GPU Training
    ↓
Checkpoint / PLY
    ↓
Preview & Export
```

## Current scope

| Area | Current scope |
| --- | --- |
| OS | Windows 10/11 x64 |
| Input | MP4, MOV, JPG, PNG |
| Scenes | Static objects and static indoor/outdoor scenes |
| SfM | Local COLMAP |
| Trainer | Brush |
| GPU | NVIDIA, subject to Brush compatibility |
| Output | PLY, project files, logs |
| UI | Tauri, React, TypeScript |
| Backend | Rust |
| Privacy | Local processing; no user-media upload |

Cloud training, accounts, cloud sync, public sharing, dynamic 3DGS, multi-GPU training, mobile clients, a full Gaussian editor, and official macOS/Linux releases are outside the current scope.

## Development quick start

### Prerequisites

- Rust 1.97.0 with the `x86_64-pc-windows-msvc` target
- Node.js 22
- pnpm 11.12.0
- Windows SDK and Visual Studio Build Tools with the Desktop development with C++ workload
- Tauri prerequisites for Windows

```powershell
git clone https://github.com/metorigin/MetOrigin-Splat.git
Set-Location MetOrigin-Splat

pnpm install --frozen-lockfile
pnpm tauri dev
```

Building the application does not bundle public redistributable copies of FFmpeg, COLMAP, or Brush. Running the complete 3D pipeline requires compatible local engine installations. See the [development guide](docs/development.md), [engine integration guide](docs/engine-integration.md), and [Windows packaging boundary](packaging/windows-x64/README.md).

## Validation

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all -- --check
cargo test --workspace --all-targets
```

Real-engine tests are ignored by default. Their requirements and commands are documented in [the technical spike](docs/plans/technical-spike.md).

## Repository structure

```text
MetOrigin-Splat/
├── apps/desktop/        # Tauri desktop application and frontend tests
├── crates/              # Rust workspace crates and integration tests
├── schemas/             # JSON Schema definitions and examples
├── presets/             # Training presets
├── docs/                # Architecture, development, and project documentation
├── packaging/           # Internal packaging definitions and license gates
└── scripts/             # Build and packaging utilities
```

## Documentation

- [Architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Engine integration](docs/engine-integration.md)
- [Project format](docs/project-format.md)
- [Release process](docs/release-process.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Security vulnerabilities must be reported privately according to [SECURITY.md](SECURITY.md).

## License

MetOrigin Splat source code is dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

Third-party programs, model weights, icons, and other dependencies retain their own licenses. The project license does not grant permission to redistribute the internal full engine pack; consult [the packaging notices](packaging/windows-x64/THIRD_PARTY_NOTICES.template.md) before distributing binaries.
