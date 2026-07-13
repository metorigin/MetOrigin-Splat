use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{read_colmap_result, write_colmap_result_atomic, ColmapMapperParser};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Builds all sparse models, selects the model with the most registered
/// images, and persists the stable `colmap/result.json` handoff.
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
                "The COLMAP database is required for mapping.",
            ));
        }
        colmap_support::image_dir(ctx)?;
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_result.exists() {
            return Ok(false);
        }
        let result = match read_colmap_result(&ctx.paths.colmap_result) {
            Ok(result) => result,
            Err(_) => return Ok(false),
        };
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        Ok(colmap_support::has_complete_model(&model_path)
            && result.registered_images > 0
            && result.point_count > 0)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let adapter = colmap_support::adapter(ctx)?;
        let image_dir = colmap_support::image_dir(ctx)?;
        let total_images = colmap_support::count_images(&image_dir);
        reset_sparse_output(ctx)?;

        let command = adapter
            .build_mapping_command(
                &ctx.paths.colmap_db,
                &image_dir,
                &ctx.paths.colmap_sparse,
                &ctx.log_path,
            )
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(4 * 60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(ColmapMapperParser::new("ColmapMapping")));
        let process_result = ProcessRunner::with_parser(parsers)
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        colmap_support::ensure_success(&process_result, "sparse mapping")?;

        let mut result = adapter
            .mapper()
            .analyze_result(&ctx.paths.colmap_sparse, total_images)?;
        result.model_path = result
            .model_path
            .strip_prefix(&ctx.project_dir)
            .unwrap_or(&result.model_path)
            .to_path_buf();
        write_colmap_result_atomic(&result, &ctx.paths.colmap_result)?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        if !colmap_support::has_complete_model(&model_path) {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "Sparse Model Not Created",
                "The selected COLMAP model is incomplete.",
            ));
        }
        Ok(())
    }
}

fn reset_sparse_output(ctx: &StageContext) -> AppResult<()> {
    if ctx.paths.colmap_sparse.exists() {
        std::fs::remove_dir_all(&ctx.paths.colmap_sparse).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Reset Sparse Output",
                "Could not clear the previous COLMAP sparse models.",
            )
            .with_technical(error.to_string())
        })?;
    }
    std::fs::create_dir_all(&ctx.paths.colmap_sparse).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Create Sparse Output",
            "Could not create the COLMAP sparse output directory.",
        )
        .with_technical(error.to_string())
    })?;
    for path in [&ctx.paths.colmap_result, &ctx.paths.colmap_validation] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "Failed to Clear COLMAP Result",
                    "Could not clear a stale COLMAP result file.",
                )
                .with_technical(error.to_string())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_mapping_no_db() {
        let stage = ColmapMappingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapMapping,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_mapping_cache_no_result() {
        let dir = tempfile::tempdir().unwrap();
        let stage = ColmapMappingStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapMapping, dir.path(), None);
        assert!(!stage.check_cached(&ctx).unwrap());
    }
}
