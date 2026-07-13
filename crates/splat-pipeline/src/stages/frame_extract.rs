use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Extracts frames from video using FFmpeg.
///
/// This stage delegates to `FfmpegAdapter` for:
/// - Probing video metadata (via FFprobe)
/// - Computing the extraction plan (fps, scaling, rotation)
/// - Building and executing the FFmpeg command
/// - Parsing frame extraction progress
/// - Validating and generating the frame manifest
///
/// TODO: Full implementation requires FfmpegAdapter + ProcessRunner integration.
pub struct FrameExtractionStage {
    /// The FFmpeg preset to use for extraction parameters.
    preset_name: String,
}

impl FrameExtractionStage {
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
        }
    }
}

#[async_trait::async_trait]
impl PipelineStage for FrameExtractionStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::FrameExtraction
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        // Source directory must have media files
        if !ctx.paths.source_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Source Media Missing",
                "No source media found. Import a video or images before extracting frames.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        // Frames exist and manifest is present
        let manifest_ok = ctx.paths.frames_manifest.exists();
        let frames_ok = ctx.paths.frames_dir.exists() && has_frames(&ctx.paths.frames_dir);
        Ok(manifest_ok && frames_ok)
    }

    async fn execute(
        &self,
        _ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!("Frame extraction started (preset: {})", self.preset_name);

        // TODO: Full implementation:
        // 1. ffmpeg_adapter.probe_metadata(source_video)
        // 2. preset = load_preset(self.preset_name)
        // 3. plan = plan_extraction(metadata, preset.frame_extraction)
        // 4. spec = ffmpeg_adapter.build_command(plan, video, frames_dir)
        // 5. runner = ProcessRunner::new()
        // 6. handle = runner.execute(spec).await?
        // 7. monitor events + forward progress
        // 8. manifest = validate_frames(frames_dir, plan, metadata)?
        // 9. write manifest to frames/frames.json

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.frames_manifest.exists() {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Frame Extraction Output Missing",
                "The frame manifest (frames/frames.json) was not created. Extraction may have failed.",
            ));
        }
        Ok(())
    }
}

fn has_frames(dir: &std::path::Path) -> bool {
    if !dir.exists() {
        return false;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader.filter_map(|e| e.ok()).any(|e| {
                e.path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_frame_extraction_validate_inputs_missing_source() {
        let stage = FrameExtractionStage::new("balanced");
        let ctx = StageContext::new(
            PipelineStageId::FrameExtraction,
            Path::new("/nonexistent"),
            Some("balanced".into()),
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_frame_extraction_check_cached_empty() {
        let dir = std::env::temp_dir().join("splat-stage-frames-cache");
        let _ = std::fs::create_dir_all(&dir);
        let ctx = StageContext::new(
            PipelineStageId::FrameExtraction,
            &dir,
            Some("balanced".into()),
        );
        assert!(!FrameExtractionStage::new("balanced")
            .check_cached(&ctx)
            .unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_has_frames() {
        let dir = std::env::temp_dir().join("splat-stage-has-frames");
        let _ = std::fs::create_dir_all(&dir);
        assert!(!has_frames(&dir));
        std::fs::write(dir.join("000001.jpg"), b"fake").unwrap();
        assert!(has_frames(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
