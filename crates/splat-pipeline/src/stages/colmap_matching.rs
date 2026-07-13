use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    inspect_database, ColmapFeatureParser, MatchingStrategy, MatchingValidator,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Matches ordered video frames with COLMAP's sequential matcher.
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
        let stats = inspect_database(&ctx.paths.colmap_db)?;
        if stats.images == 0 || stats.keypoints == 0 {
            return Err(AppError::new(
                "E-3010",
                ErrorCategory::Engine,
                "COLMAP Features Missing",
                "The COLMAP database does not contain extracted image features.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        Ok(inspect_database(&ctx.paths.colmap_db)
            .map(|stats| stats.matched_pairs > 0 && stats.verified_matches > 0)
            .unwrap_or(false))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let adapter = colmap_support::adapter(ctx)?;
        let stats = inspect_database(&ctx.paths.colmap_db)?;
        let strategy = MatchingStrategy::Sequential { overlap: 10 };
        let command = adapter
            .build_matching_command(&ctx.paths.colmap_db, &strategy, &ctx.log_path)
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(2 * 60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(ColmapFeatureParser::new(
            "ColmapMatching",
            stats.images as u64,
        )));
        let result = ProcessRunner::with_parser(parsers)
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        colmap_support::ensure_success(&result, "feature matching")?;
        MatchingValidator::validate_matching(&ctx.paths.colmap_db)?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        MatchingValidator::validate_matching(&ctx.paths.colmap_db)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_matching_no_db() {
        let stage = ColmapMatchingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapMatching,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }
}
