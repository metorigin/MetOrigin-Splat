use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// COLMAP feature extraction stage.
///
/// Creates the COLMAP database and extracts SIFT features from all
/// input images. Delegates to `ColmapAdapter` for command generation.
///
/// TODO: Full implementation with ColmapAdapter + ProcessRunner.
pub struct ColmapFeatureStage;

impl Default for ColmapFeatureStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapFeatureStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapFeatureStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapFeatureExtraction
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.frames_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Frames Directory Not Found",
                "No frames directory found. Run frame extraction before COLMAP feature extraction.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        // COLMAP database exists and is non-empty
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        let meta = std::fs::metadata(&ctx.paths.colmap_db).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Database Check Failed",
                e.to_string(),
            )
        })?;
        Ok(meta.len() > 1024)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!(
            "COLMAP feature extraction started (frames: {}, db: {})",
            ctx.paths.frames_dir.display(),
            ctx.paths.colmap_db.display()
        );

        // TODO: Full implementation:
        // 1. DatabaseCreator.build_command → create database
        // 2. ProcessRunner.execute(database_spec)
        // 3. FeatureExtractor.build_command
        // 4. ProcessRunner.execute(feature_spec) + stream progress
        // 5. FeatureExtractor.validate_extraction

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.colmap_db.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Not Created",
                "The COLMAP database was not created. Feature extraction may have failed.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_colmap_feature_no_frames() {
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapFeatureExtraction,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_colmap_feature_cache_no_db() {
        let dir = std::env::temp_dir().join("splat-stage-colmap-feat");
        let _ = std::fs::create_dir_all(&dir);
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, &dir, None);
        assert!(!stage.check_cached(&ctx).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
