use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    inspect_database, ColmapFeatureParser, DatabaseCreator, FeatureExtractionOptions,
    FeatureExtractor,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Creates a COLMAP database and extracts SIFT features from the preferred
/// processed image directory, falling back to extracted frames when needed.
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
        colmap_support::image_dir(ctx)?;
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        let image_dir = colmap_support::image_dir(ctx)?;
        let stats = match inspect_database(&ctx.paths.colmap_db) {
            Ok(stats) => stats,
            Err(_) => return Ok(false),
        };
        Ok(stats.images == colmap_support::count_images(&image_dir) && stats.keypoints > 0)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let image_dir = colmap_support::image_dir(ctx)?;
        let image_count = colmap_support::count_images(&image_dir);
        let adapter = colmap_support::adapter(ctx)?;
        create_colmap_directories(ctx)?;
        reset_feature_outputs(ctx)?;

        let database_command = adapter
            .database_creator()
            .build_command(
                &ctx.paths.colmap_db,
                &ctx.paths.colmap_logs.join("database.log"),
            )
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(5 * 60));
        let database_result = ProcessRunner::new()
            .run_to_completion(database_command, ctx.cancellation.clone(), None)
            .await?;
        colmap_support::ensure_success(&database_result, "database creation")?;
        DatabaseCreator::validate_database(&ctx.paths.colmap_db)?;
        let _ = progress_tx.send(
            TaskProgress::new("ColmapFeatureExtraction", "COLMAP database created")
                .with_percent(0.05),
        );

        let options = FeatureExtractionOptions::default();
        let feature_command = adapter
            .build_feature_command(&ctx.paths.colmap_db, &image_dir, &options, &ctx.log_path)
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(ColmapFeatureParser::new(
            "ColmapFeatureExtraction",
            image_count as u64,
        )));
        let feature_result = ProcessRunner::with_parser(parsers)
            .run_to_completion(feature_command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        colmap_support::ensure_success(&feature_result, "feature extraction")?;
        FeatureExtractor::validate_extraction(&ctx.paths.colmap_db, &image_dir, true)?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        DatabaseCreator::validate_database(&ctx.paths.colmap_db)?;
        let image_dir = colmap_support::image_dir(ctx)?;
        FeatureExtractor::validate_extraction(&ctx.paths.colmap_db, &image_dir, true)?;
        Ok(())
    }
}

fn create_colmap_directories(ctx: &StageContext) -> AppResult<()> {
    for path in [&ctx.paths.colmap_dir, &ctx.paths.colmap_logs] {
        std::fs::create_dir_all(path).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create COLMAP Directory",
                "Could not create a COLMAP working directory.",
            )
            .with_technical(error.to_string())
        })?;
    }
    Ok(())
}

fn reset_feature_outputs(ctx: &StageContext) -> AppResult<()> {
    DatabaseCreator::remove_database(&ctx.paths.colmap_db).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Reset COLMAP Database",
            "Could not clear the previous COLMAP database.",
        )
        .with_technical(error.to_string())
    })?;
    for stale in [&ctx.paths.colmap_result, &ctx.paths.colmap_validation] {
        if stale.exists() {
            std::fs::remove_file(stale).map_err(|error| {
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
    fn test_colmap_feature_no_frames() {
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapFeatureExtraction,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_colmap_feature_cache_no_db() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("frames")).unwrap();
        std::fs::write(dir.path().join("frames/000001.jpg"), b"frame").unwrap();
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, dir.path(), None);
        assert!(!stage.check_cached(&ctx).unwrap());
    }
}
