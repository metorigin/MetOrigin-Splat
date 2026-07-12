# MetaOrigin Splat — Architecture

## Overview

MetaOrigin Splat is structured as a layered architecture with clean separation between the desktop UI, the Rust application core, and the external engines.

```
┌───────────────────────────────────────────┐
│               Desktop UI                  │
│        Tauri + React + TypeScript          │
│                                           │
│ 项目管理 / 素材导入 / 设置 / 进度 / 预览     │
└──────────────────────┬────────────────────┘
                       │ Tauri Commands / Events
┌──────────────────────▼────────────────────┐
│              Rust Application Core        │
│                                           │
│ Project Manager                           │
│ Pipeline Orchestrator                     │
│ Process Runner                            │
│ Hardware Detector                         │
│ Event Bus                                 │
│ Error Mapper                              │
│ Checkpoint Manager                        │
└───────┬──────────────┬──────────────┬─────┘
        │              │              │
┌───────▼──────┐ ┌─────▼───────┐ ┌────▼───────────┐
│ FFmpeg Adapter│ │COLMAP Adapter│ │ Brush Adapter  │
└───────┬──────┘ └─────┬───────┘ └────┬───────────┘
        │              │              │
┌───────▼──────────────▼──────────────▼─────┐
│               Project Workspace           │
│ source / frames / colmap / training       │
│ output / logs / cache / project.json      │
└───────────────────────────────────────────┘
```

## Core Design Principles

### 1. External Engines Must Use Adapters

UI and business logic must never construct FFmpeg, COLMAP, or Brush commands directly. A unified adapter layer is mandatory:

```rust
pub trait EngineAdapter {
    fn name(&self) -> &'static str;
    fn detect(&self) -> Result<EngineInfo, EngineError>;
    fn validate(&self, context: &TaskContext) -> Result<(), EngineError>;
    fn build_command(&self, context: &TaskContext) -> Result<CommandSpec, EngineError>;
}
```

This allows future replacement:
- Brush → OpenSplat (or other training engines)
- COLMAP → GLOMAP (or other SfM)
- FFmpeg → other media processors

### 2. Pipeline Must Be a State Machine

A single long function that executes all commands sequentially is not acceptable.

Every stage must contain:
- Unique ID
- Inputs
- Outputs
- Current status
- Start / end time
- Retry count
- Failure reason
- Log path
- Whether skippable
- Whether resumable

### 3. Project Is the Single Source of Truth

The UI does not independently maintain business state. Core state is stored in `project.json` (and runtime state store). The UI reads from and writes to the project through the core.

### 4. Unified Process Runner

All external processes (FFmpeg, COLMAP, Brush) must be launched through a single `ProcessRunner` that handles:
- stdout / stderr streaming
- Log file writing
- Exit code handling
- Cancellation
- Timeout
- Process tree termination (Windows)
- Progress parsing
- Crash recording
- Windows path and encoding compatibility

## Domain Module (`splat-domain`)

Core types without UI or engine dependencies:

```rust
Project
ProjectSettings
ProjectStatus
Pipeline
PipelineStage
StageStatus
TaskProgress
EngineInfo
HardwareProfile
AppError
RecoveryState
ExportResult
```

Requirements:
- Serializable
- Version-upgradable
- No UI dependency
- No engine-specific dependency
- Unit tests covering major state transitions

## Process Runner (`splat-process`)

The most important infrastructure crate in the first version.

```rust
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<OsString, OsString>,
    pub log_file: PathBuf,
    pub timeout: Option<Duration>,
}

pub struct ProcessHandle {
    pub process_id: u32,
    pub started_at: DateTime<Utc>,
}

pub enum ProcessEvent {
    Started,
    StdoutLine(String),
    StderrLine(String),
    Progress(TaskProgress),
    Exited(i32),
    Cancelled,
    TimedOut,
}
```

Acceptance criteria:
- Correct handling of Windows paths with CJK characters and spaces
- Real-time stdout/stderr streaming
- Simultaneous log file writing
- Process cancellation without residue
- Distinguish user cancellation from process crash
- No shell string command construction (avoid injection/escaping issues)
- Sensitive paths not sent to external services

## Hardware Manager (`splat-hardware`)

MVP detection includes:
- OS type
- CPU info
- Total memory
- GPU name and VRAM
- Available disk space
- DirectX / Vulkan capability
- Engine launch capability

```rust
pub struct HardwareProfile {
    pub operating_system: OperatingSystem,
    pub cpu_name: Option<String>,
    pub memory_total_bytes: u64,
    pub gpu_devices: Vec<GpuDevice>,
    pub available_disk_bytes: u64,
    pub recommended_preset: PresetId,
    pub warnings: Vec<HardwareWarning>,
}
```

Do not infer everything from GPU name alone. The primary compatibility check is whether the engine self-test passes.

## Pipeline Orchestrator (`splat-pipeline`)

### Pipeline Stage IDs

```rust
pub enum PipelineStageId {
    MediaValidation,
    FrameExtraction,
    ImagePreprocessing,
    ColmapFeatureExtraction,
    ColmapMatching,
    ColmapMapping,
    ColmapValidation,
    TrainingPreparation,
    BrushTraining,
    ModelValidation,
    PreviewGeneration,
    Export,
}
```

### Stage Status

```rust
pub enum StageStatus {
    Pending,
    Preparing,
    Running,
    Pausing,
    Paused,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
    Skipped,
}
```

### Pipeline capabilities

- Start
- Cancel
- Retry failed stage
- Resume from last successful stage
- Check existing outputs
- Re-execute a stage
- Stage-level logging
- Crash recovery

**MVP note**: True arbitrary pause is not implemented initially (external programs don't natively support pause). MVP defines "cancel and preserve results" rather than "pause any process and resume in place."

## Error Mapper

### Error Hierarchy

```
User errors
Environment errors
Media errors
Engine errors
Filesystem errors
System resource errors
Internal errors
```

### Error Code Ranges

| Range      | Type                  |
| ---------- | --------------------- |
| 1000–1099  | Project & file errors |
| 1100–1199  | Media errors          |
| 1200–1299  | Disk & permission     |
| 2000–2099  | FFmpeg errors         |
| 3000–3099  | COLMAP errors         |
| 4000–4099  | Brush errors          |
| 5000–5099  | GPU & hardware        |
| 9000–9099  | Internal errors       |

### Error Structure

```rust
pub struct AppError {
    pub code: String,
    pub category: ErrorCategory,
    pub title: String,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub suggestions: Vec<String>,
    pub retryable: bool,
    pub log_path: Option<PathBuf>,
}
```

## UI Pages

### Home
- New project
- Open project
- Recent projects
- Software version
- Engine status
- Environment warnings

### New Project Wizard
```
Select input
→ Media analysis
→ Choose save location
→ Select preset
→ Create project
```

### Project Page
- Project name, media count, current stage, disk usage
- Training preset, registered image count, last run time
- Actions: continue training, re-execute, open output directory

### Training Page
- Overall progress, current stage, stage progress
- Elapsed time, training iteration, resource usage
- Latest log, cancel button, detailed log entry

### Results Page

**MVP**: Open external viewer, show output path, export PLY, open output directory.

**Future**: Embedded WebGPU viewer, camera bookmarks, basic cropping, background settings, quality statistics.

### Settings Page
- Engine paths
- Default project directory
- Cache policy
- Log level
- Update channel
- Advanced parameters
- Privacy notice
- Third-party licenses

## Risks

### Brush CLI Instability
- CLI parameters may change
- Output log format may change
- Checkpoint format may change
- GPU backend behavior differs

**Mitigation**: Version pinning, adapter isolation, version detection, compatibility tests, no raw Brush log parsing in UI.

### COLMAP Success Rate
- Poor user media quality
- Low texture, blur, dynamic objects, repetitive patterns
- Insufficient overlap between adjacent frames

**Mitigation**: Media pre-check, frame extraction strategy, multiple matching modes, registration rate detection, failure suggestions, future auto-retry.

### Large Installer Size
**Mitigation**: Separate app from engine pack, first-run engine download, offline full pack option, on-demand engine updates.

### GPU Compatibility
**Mitigation**: No blanket GPU promises, engine self-test on first launch, device/result logging, public compatibility matrix, prioritize one GPU class for stability.

### Third-Party Licenses
**Mitigation**: License audit in first week, record binary sources, preserve license texts, clarify FFmpeg build config, do not distribute binaries with unclear license status.
