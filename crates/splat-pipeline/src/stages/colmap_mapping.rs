use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// COLMAP sparse reconstruction (mapping) stage.
///
/// Runs the incremental Structure-from-Motion pipeline to produce
/// a sparse 3D model. Delegates to ColmapMapper for command generation
/// and result analysis.
///
/// TODO: Full implementation with ColmapMapper + ProcessRunner.
pub struct ColmapMappingStage;

impl Default for ColmapMappingStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapMappingStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapMappingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapMapping
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.colmap_db.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Missing",
                "The COLMAP database is required for mapping. Run feature extraction and matching first.",
            ));
        }
        if !ctx.paths.frames_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Frames Directory Missing",
                "The frames directory is required for mapping.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        // Check for sparse model output
        let model_dir = ctx.paths.colmap_model_dir();
        if !model_dir.exists() {
            return Ok(false);
        }
        let has_cameras =
            model_dir.join("cameras.bin").exists() || model_dir.join("cameras.txt").exists();
        Ok(has_cameras)
    }

    async fn execute(
        &self,
        _ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!("COLMAP sparse mapping started");

        // TODO: Full implementation:
        // 1. Ensure sparse/ output directory exists
        // 2. ColmapMapper.build_command(database, frames, sparse)
        // 3. ProcessRunner.execute(mapper_spec) + progress parsing
        // 4. ColmapMapper.analyze_result(sparse) → ColmapResult
        // 5. ColmapValidator.validate with diagnostics

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        let model_dir = ctx.paths.colmap_model_dir();
        if !model_dir.join("cameras.bin").exists() && !model_dir.join("cameras.txt").exists() {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "Sparse Model Not Created",
                "COLMAP did not produce a valid sparse model. The reconstruction may have failed.",
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
    async fn test_mapping_no_db() {
        let stage = ColmapMappingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapMapping,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_mapping_cache_no_model() {
        let dir = std::env::temp_dir().join("splat-stage-mapping-cache");
        let _ = std::fs::create_dir_all(&dir);
        let stage = ColmapMappingStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapMapping, &dir, None);
        assert!(!stage.check_cached(&ctx).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
