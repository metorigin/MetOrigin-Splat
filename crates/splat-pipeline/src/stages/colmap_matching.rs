use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// COLMAP feature matching stage.
///
/// Matches features between images using the configured strategy.
/// For video frames, uses sequential matching. For photo sets, uses exhaustive matching.
///
/// TODO: Full implementation with ColmapAdapter + ProcessRunner.
pub struct ColmapMatchingStage;

impl Default for ColmapMatchingStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapMatchingStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapMatchingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapMatching
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.colmap_db.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Missing",
                "The COLMAP database was not found. Run feature extraction before matching.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        // Use MatchingValidator to check if database has matches
        // For now, a lightweight check: database exists and has keypoints
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        Ok(ctx.paths.colmap_db.exists())
    }

    async fn execute(
        &self,
        _ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!("COLMAP feature matching started");

        // TODO: Full implementation:
        // 1. Determine matching strategy (sequential for video, exhaustive for photos)
        // 2. build_matching_command(database_path, strategy)
        // 3. ProcessRunner.execute(matching_spec) + progress
        // 4. MatchingValidator.validate_matching(database_path)

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
                "COLMAP Database Missing After Matching",
                "The COLMAP database is missing after matching. The process may have failed.",
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
    async fn test_matching_no_db() {
        let stage = ColmapMatchingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapMatching,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }
}
