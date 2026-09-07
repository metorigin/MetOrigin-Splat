# Architecture

MetOrigin Splat is a Windows-first Tauri 2 application with a React/TypeScript interface and a Rust reconstruction pipeline. This document describes implemented boundaries; the older UX design records are indexed under [specs](../specs/README.md).

## Modules

| Location | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Project navigation, creation wizard, timeline, settings, rendering and interaction state |
| `apps/desktop/src/services/desktop.ts` | Typed frontend wrappers for Tauri IPC |
| `apps/desktop/src-tauri/src/` | Desktop commands, application state, events and validated file access |
| `crates/splat-domain/` | Project, settings, stage, event and error types |
| `crates/splat-project/` | Project creation, persistence, locking, migration and recent-project index |
| `crates/splat-process/` | Child-process execution, output capture, cancellation and process-tree cleanup |
| `crates/splat-pipeline/` | Stage orchestration, preflight, progress, cache checks, recovery and export |
| `crates/splat-hardware/` | Hardware/resource detection, engine discovery and engine-pack integrity |
| `crates/splat-engine-ffmpeg/` | Media probing and video frame extraction |
| `crates/splat-engine-colmap/` | Features, matching, sparse reconstruction and quality reports |
| `crates/splat-engine-brush/` | Training, checkpoint parsing and live-preview protocol |
| `integrations/brush-live/` | Source injected into the pinned Brush build to export requested training snapshots |

```text
React pages and shared state
        │ typed desktop service calls / project-scoped events
Tauri commands and application state
        │
Pipeline orchestrator ── Project persistence / hardware and engine discovery
        │
FFmpeg / COLMAP / Brush adapters
        │
splat-process ── local child processes ── project artifacts
```

Components use the desktop service layer instead of importing raw Tauri commands. Domain and pipeline crates do not depend on the visual layout.

## Interface and state

The application has a project center, a three-step creation wizard and a project-detail workspace. The sidebar contains creation/open actions, recent projects and the single Settings & Engines entry. The theme is managed through `useTheme`; active styles are `styles/buzz.css`, `styles/tokens.css` and `styles/interaction-surfaces.css`.

The selected project and the running project are separate concepts. Only one pipeline owns the active execution slot, but users can inspect another project or prepare a new one. Project identity and sequence information prevent late events from being applied to the wrong view. Recent-index reads precede bounded availability checks so a slow or missing location does not block the list.

The creation wizard analyzes the selected source, runs preflight for the chosen preset, then validates the destination before copying source media. Changing the preset triggers a new preflight; outdated results cannot enable the next step. Image selection uses a browsable file picker and derives the parent folder for whole-folder import.

Frontend async resources distinguish loading, unavailable data and failures. Missing resource measurements are not represented as zero. The project center queries the executable's volume by default; project-specific resource views can query the project location.

## Pipeline

The UI groups twelve backend stage identifiers into four phases:

| Phase | Stage identifiers |
| --- | --- |
| 预处理 / Preprocessing | `MediaValidation`, `FrameExtraction`, `ImagePreprocessing` |
| 特征提取 / Feature extraction | `ColmapFeatureExtraction`, `ColmapMatching`, `ColmapMapping`, `ColmapValidation` |
| 训练重建 / Training | `TrainingPreparation`, `BrushTraining`, `ModelValidation` |
| 质量评估 / Quality assessment | `Export`, `PreviewGeneration` |

The phase cards are collapsed until clicked. Selecting a stage changes the artifact being inspected; following the current stage restores automatic selection. The last phase includes final validation output and export, rather than a separate training engine.

Each stage checks its prerequisites and existing output before execution. Valid cached output can be reused. Invalidating a stage also affects its dependent stages. Progress comes from stage state and available engine measurements, not a simulated timer.

## Persistence and recovery

A `.splat-project` is a directory containing `project.json`, copied media, intermediate output, checkpoints, final artifacts and logs. [Project format](project-format.md) describes the layout and serialization.

Project locks prevent concurrent writers. Critical state is written atomically. On reopening an interrupted project, recovery validates persisted stage state and files before deciding what is reusable. A partial Brush checkpoint makes the stage resumable; it does not mark training complete.

Pause, cancel, rerun, recovery and deletion use explicit application actions. High-impact operations that expose a preview/confirmation token verify that token against current state before mutation. Removing a recent entry and deleting its project directory remain different operations.

## Artifact and live rendering

Preprocessing displays image artifacts. COLMAP displays sparse geometry and camera poses. Training and final-model stages use the lazy-loaded Spark/WebGL2 Gaussian renderer and full model attributes.

The live path is:

```text
Viewer demand → Tauri request → Brush TrainStep model
             → complete binary PLY + atomic latest.json
             → validated binary IPC → Spark renderer → acknowledgement
```

The companion exports only when requested and when the prior frame has been acknowledged. Session identities isolate runs; expiring requests and a two-frame cache bound unattended work. Model replacement preserves the user's camera. Saved recovery checkpoints are separate from transient live-preview files.

This is a snapshot channel to the training model, not an embedded native Brush window or a shared GPU texture. See [Gaussian live preview](gaussian-live-preview.zh-CN.md) for cadence, formats and limits.

## Verification boundaries

Unit and integration tests cover domain transitions, persistence, adapter behavior and frontend interactions. The browser UI preview uses development-only synthetic data. Native WebView2 and real-engine tests are separate because rendering, file dialogs, GPU drivers and child-process failures cannot be validated by a browser mock alone.

See [development](development.md) for validation commands and [engine integration](engine-integration.md) for engine selection and compatibility boundaries.
