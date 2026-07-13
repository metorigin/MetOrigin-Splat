use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Validates input media files before processing begins.
///
/// Checks:
/// - Source directory exists and contains media files
/// - Media files have supported extensions (MP4, MOV, JPG, PNG)
///
/// This is a lightweight stage — it only validates, no heavy processing.
pub struct MediaValidationStage;

impl Default for MediaValidationStage {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaValidationStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for MediaValidationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::MediaValidation
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        let source_dir = &ctx.paths.source_dir;
        if !source_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Source Directory Not Found",
                format!(
                    "The source directory '{}' does not exist. Please import media files first.",
                    source_dir.display()
                ),
            ));
        }
        Ok(())
    }

    fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
        // Media validation always runs — it is very fast
        Ok(false)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!("Validating media in '{}'", ctx.paths.source_dir.display());

        let source_dir = &ctx.paths.source_dir;
        let count = count_media_files(source_dir);

        if count == 0 {
            return Err(AppError::new(
                "E-1102",
                ErrorCategory::Media,
                "No Supported Media Files",
                format!(
                    "No supported media files found in '{}'. Supported formats: MP4, MOV, JPG, PNG.",
                    source_dir.display()
                ),
            ));
        }

        tracing::info!("Found {} media file(s) in source directory", count);

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
        Ok(())
    }
}

fn count_media_files(dir: &std::path::Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            matches!(
                                ext.to_lowercase().as_str(),
                                "mp4" | "mov" | "avi" | "mkv" | "jpg" | "jpeg" | "png"
                            )
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_media_validation_no_source_dir() {
        let stage = MediaValidationStage::new();
        let ctx = StageContext::new(
            PipelineStageId::MediaValidation,
            Path::new("/nonexistent/project"),
            None,
        );

        let result = stage.validate_inputs(&ctx);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_media_validation_empty_dir() {
        let dir = std::env::temp_dir().join("splat-stage-media-empty");
        let _ = std::fs::create_dir_all(dir.join("source"));

        let ctx = StageContext::new(PipelineStageId::MediaValidation, &dir, None);

        let stage = MediaValidationStage::new();
        let result = stage.execute(&ctx, broadcast::channel(8).0).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .user_message
            .contains("No supported media"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_media_files() {
        let dir = std::env::temp_dir().join("splat-stage-media-count");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("video.mp4"), b"test").unwrap();
        std::fs::write(dir.join("photo.jpg"), b"test").unwrap();
        std::fs::write(dir.join("readme.txt"), b"test").unwrap();
        assert_eq!(count_media_files(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
