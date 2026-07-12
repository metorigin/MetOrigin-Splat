# Engine Integration Guide

## Overview

All external engines (FFmpeg, COLMAP, Brush) are accessed through a common adapter pattern. The application core never directly constructs CLI commands for these engines. This ensures each engine can be replaced independently without affecting the rest of the system.

```rust
pub trait EngineAdapter {
    fn name(&self) -> &'static str;
    fn detect(&self) -> Result<EngineInfo, EngineError>;
    fn validate(&self, context: &TaskContext) -> Result<(), EngineError>;
    fn build_command(&self, context: &TaskContext) -> Result<CommandSpec, EngineError>;
}
```

## FFmpeg Adapter (`splat-engine-ffmpeg`)

### Responsibilities

- Detect FFmpeg availability and version
- Read video metadata via FFprobe
- Calculate frame extraction parameters
- Execute frame extraction
- Parse progress output
- Validate output frames
- Generate frame manifest

### Input → Output

```
input.mp4
    ↓
frames/000001.jpg
frames/000002.jpg
frames/000003.jpg
frames/frames.json
```

### Must Handle

- Corrupted video files
- Unsupported codecs
- Variable frame rate
- Rotation metadata
- CJK characters in filenames
- Output directory permission issues
- Insufficient disk space
- User cancellation

### Adapter Interface

```rust
pub struct FfmpegAdapter;

impl EngineAdapter for FfmpegAdapter {
    fn name(&self) -> &'static str { "ffmpeg" }
    fn detect(&self) -> Result<EngineInfo, EngineError> { /* ... */ }
    fn validate(&self, context: &TaskContext) -> Result<(), EngineError> { /* ... */ }
    fn build_command(&self, context: &TaskContext) -> Result<CommandSpec, EngineError> { /* ... */ }
}
```

Additional FFmpeg-specific methods:

```rust
impl FfmpegAdapter {
    pub fn probe_metadata(&self, video_path: &Path) -> Result<VideoMetadata, EngineError>;
    pub fn plan_extraction(&self, metadata: &VideoMetadata, preset: &Preset) -> ExtractionPlan;
    pub fn parse_frame_progress(&self, line: &str) -> Option<f64>;
    pub fn validate_frames(&self, frame_dir: &Path, plan: &ExtractionPlan) -> Result<FrameManifest, EngineError>;
}
```

## COLMAP Adapter (`splat-engine-colmap`)

### Pipeline Stages

COLMAP is split into multiple independently executable stages:

```
colmap_database_init
colmap_feature_extraction
colmap_feature_matching
colmap_mapping
colmap_model_validation
```

### Matching Strategies

| Source Type | Recommended Strategy     |
| ----------- | ------------------------ |
| Video frames| Sequential matching      |
| Independent photos | Exhaustive matching |
| Any         | Vocabulary tree matching (future) |

### Integration Requirements

- Never hard-code unverified CLI parameters in core code
- Read bound version's help text at integration time
- Maintain version compatibility records for each COLMAP version
- Validate commands with fixed test data
- Check registered image count
- Check sparse model existence
- Verify cameras, images, and points3D data integrity

### Result Type

```rust
pub struct ColmapResult {
    pub registered_images: usize,
    pub total_images: usize,
    pub point_count: usize,
    pub model_path: PathBuf,
}
```

### Failure Tips (User-Facing)

```
无法建立稳定的相机轨迹。

已注册图像：4 / 180

可能原因：
1. 视频运动过快或存在模糊
2. 场景纹理不足
3. 相邻画面重叠不够
4. 画面中存在大量动态物体

建议：
1. 使用更缓慢、连续的拍摄方式
2. 降低抽帧间隔
3. 确保目标从多个角度被拍摄
4. 避免强反光、透明和纯色表面
```

## Brush Adapter (`splat-engine-brush`)

### Design Principles

- Do not assume Brush CLI parameters are stable long-term
- Pin the Brush version used during development
- Save bound version and checksum
- Maintain Brush version compatibility matrix
- Implement pre-training capability detection
- Verify Brush can read current COLMAP output format
- Build a unified parsing layer for training output
- Never let the UI depend on raw Brush log format

### Training Engine Trait

```rust
pub trait TrainingEngine {
    fn detect(&self) -> Result<TrainingEngineInfo, EngineError>;
    fn validate_dataset(&self, dataset: &Dataset) -> Result<(), EngineError>;
    fn start_training(
        &self,
        request: TrainingRequest
    ) -> Result<TrainingProcess, EngineError>;
    fn find_checkpoints(
        &self,
        project: &Project
    ) -> Result<Vec<Checkpoint>, EngineError>;
    fn export(
        &self,
        request: ExportRequest
    ) -> Result<ExportResult, EngineError>;
}
```

### Adapter Responsibilities

- Version detection
- Dataset format compatibility check
- Training configuration generation
- Training process launch
- Progress parsing
- Output detection
- Checkpoint scanning
- Training cancellation
- Training resume verification
- Output model validation
