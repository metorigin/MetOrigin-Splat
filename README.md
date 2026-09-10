# MetOrigin Splat

[English](README.md) | [简体中文](README.zh-CN.md)

A Windows desktop application that turns a video or a folder of photos into a 3D Gaussian Splatting scene. FFmpeg prepares the frames, COLMAP reconstructs the cameras and sparse geometry, and Brush trains the model locally.

**Status: Alpha / v0.1.0.** The core workflow is implemented; Windows installers are for internal validation. There is no supported public binary release yet.

## What you can do

- Create projects from MP4, MOV, AVI, MKV, or folders containing JPG, JPEG and PNG images.
- Inspect media and hardware before choosing Fast, Balanced or High Quality reconstruction.
- Monitor the four processing phases, inspect stage outputs, pause or cancel a task, and resume from validated recovery data.
- View sparse COLMAP geometry and full Gaussian models, including updates during training with the companion Brush engine.
- Open recent projects, inspect quality metrics and resource usage, and export PLY results.
- Edit completed models in the bundled SuperSplat workspace and save directly to the project's model file.
- Configure engines, storage, performance and light/dark/system appearance in one settings drawer.

Media processing runs on your computer. Engine preparation and dependency installation may download software; they do not upload your project media.

## Run locally

Use Windows 10/11 x64 with:

- Rust **1.97.0**, including `x86_64-pc-windows-msvc`
- Node.js **22** and pnpm **11.12.0**
- Visual Studio Build Tools: **Desktop development with C++**, plus the Windows SDK
- Microsoft Edge WebView2 Runtime
- A compatible NVIDIA GPU for the currently validated reconstruction path

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm tauri dev` starts both the desktop application and its Vite server. Do not start another `pnpm dev` on port 1420 at the same time. Restart this command after Rust/Tauri changes; frontend changes support hot reload.

### Prepare the reconstruction engines

A source checkout does not contain engine executables. Configure existing installations through **设置与引擎** (Settings & Engines), or prepare the pinned local engine pack:

```powershell
pnpm prepare:windows:engines
pnpm verify:windows:engines
```

The generated engine directory is `target/distribution/windows-x64/engines`; select it in Settings & Engines for local use. The pack includes FFmpeg/FFprobe, COLMAP and Brush. Versions and checksums are defined in [engine-lock.json](packaging/windows-x64/engine-lock.json). Building the companion engine may take time on the first run.

For an existing local Brush installation, the companion can also be built separately:

```powershell
pnpm build:brush:live
```

The default output is `.engines/brush-v0.3.0-windows-x64/brush_live.exe`. Place it beside the configured `brush_app.exe`; new training sessions use it automatically. Stock Brush can still provide saved checkpoints, but live updates of unsaved training models require this companion. See [engine setup](docs/engine-integration.md) and [live preview details (中文)](docs/gaussian-live-preview.zh-CN.md).

### Preview only the interface

```powershell
pnpm dev
```

Open `http://localhost:1420/?ui-preview` for the development-only sample-data view. This runs in a browser and cannot validate native file dialogs, real reconstruction or live GPU rendering.

## Typical workflow

1. Select **新建项目**, choose a video or browse an image in the folder to import. Image import includes the selected image's entire parent folder, including subfolders.
2. Review media analysis and preflight checks, then select a reconstruction preset.
3. Confirm the project name and location, then choose to create only or create and start reconstruction.
4. Follow **预处理 → 特征提取 → 训练重建 → 质量评估**. Expand a phase to inspect individual stages and their outputs.
5. Inspect the Gaussian model, quality report and checkpoints; open the output directory to use `output/scene.ply`.

One reconstruction task can run at a time. You can browse other projects while it runs. A PLY checkpoint restores model geometry, not the complete optimizer state. Live preview uses model snapshots between processes, so its update rate depends on training speed and model size.

## Development checks

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

Real-engine tests require explicit opt-in, local media and suitable hardware. See [development and validation](docs/development.md) for commands and build outputs.

## Repository guide

| Path | Contents |
| --- | --- |
| `apps/desktop/` | React/TypeScript UI, Tauri commands and frontend tests |
| `crates/` | Rust domain, project storage, process runner, pipeline, hardware and engine adapters |
| `integrations/brush-live/` | Companion source for training snapshots |
| `presets/`, `schemas/` | Reconstruction parameters and persisted-data schemas |
| `scripts/`, `packaging/` | Validation, Windows builds, pinned engines and third-party notices |
| `docs/` | Current usage, implementation and release guides |
| `specs/` | Historical design contracts and acceptance protocols |

Start with the [documentation index](docs/README.md), [user guide (中文)](docs/user-operation-flow.zh-CN.md), [architecture](docs/architecture.md), or [troubleshooting](docs/troubleshooting.md). Contribution and vulnerability reporting instructions are in [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License and distribution

Application source is available under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. Third-party engines and dependencies retain their own licenses.

Source availability does not authorize redistribution of the bundled engine pack. See the [release process](docs/release-process.md) and [Windows packaging notices](packaging/windows-x64/THIRD_PARTY_NOTICES.template.md) for the current binary release gates.
