# MetaOrigin Splat

> An open-source desktop application for turning photos and videos into Gaussian Splats using local compute.

MetaOrigin Splat is a Windows-first desktop application that automatically converts videos or photos into viewable and exportable 3D Gaussian Splatting scenes — all running locally, no Python environment required, no data uploaded to the cloud.

## Tech Pipeline

```
Video / Images
    ↓
Media Validation
    ↓
FFmpeg Frame Extraction
    ↓
Image Preprocessing
    ↓
COLMAP Feature Extraction
    ↓
COLMAP Matching
    ↓
COLMAP Sparse Reconstruction
    ↓
Data Conversion
    ↓
Brush Local GPU Training
    ↓
Checkpoint / PLY
    ↓
Preview & Export
```

## MVP Scope

| Area   | Scope                              |
| ------ | ---------------------------------- |
| OS     | Windows 10 / 11 x64               |
| Input  | MP4, MOV, JPG, PNG               |
| Scenes | Static objects, indoor & outdoor   |
| SfM    | Local COLMAP                      |
| Trainer| Brush                             |
| GPU    | NVIDIA (per Brush compatibility)  |
| Output | PLY, project file, logs           |
| UI     | Tauri + React + TypeScript        |
| Backend| Rust                              |
| Privacy| Fully local, no uploads           |
| Install| Windows installer & portable      |

### Not in MVP

Cloud training, multi-GPU training, dynamic 3DGS, mobile training, full Gaussian editor, custom SfM, custom trainer, public sharing URLs, macOS/Linux official builds, commercial licensing, accounts, cloud sync.

## Quick Start

```bash
# Prerequisites: Rust stable, Node.js 18+, pnpm

# Clone the repository
git clone https://github.com/metorigin/splat.git
cd splat

# Build and run in development mode
pnpm install
pnpm tauri dev
```

See [docs/development.md](docs/development.md) for detailed setup instructions.

## Repository Structure

```
splat/
├── apps/desktop/        # Tauri desktop application
├── crates/              # Rust workspace crates
│   ├── splat-domain/    # Core domain types
│   ├── splat-project/   # Project management
│   ├── splat-pipeline/  # Pipeline orchestration
│   ├── splat-process/   # External process runner
│   ├── splat-hardware/  # Hardware detection
│   ├── splat-engine-ffmpeg/
│   ├── splat-engine-colmap/
│   └── splat-engine-brush/
├── schemas/             # JSON Schema definitions
├── presets/             # Training presets
├── docs/                # Documentation
├── scripts/             # Build & utility scripts
└── tests/               # Integration & E2E tests
```

## Documentation

- [Architecture](docs/architecture.md)
- [Development Guide](docs/development.md)
- [Engine Integration](docs/engine-integration.md)
- [Project Format](docs/project-format.md)
- [Release Process](docs/release-process.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

[License to be determined](LICENSE)
