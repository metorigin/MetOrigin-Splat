use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_brush::{CheckpointScanner, ExportManager};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Atomically publishes the latest validated Brush checkpoint as
/// `output/scene.ply`.
pub struct ExportStage;

impl Default for ExportStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ExportStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ExportStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::Export
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?.is_none() {
            return Err(AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "No Brush PLY to Export",
                "Brush training did not produce a PLY checkpoint.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        Ok(ExportManager::validate_ply(&ctx.paths.output_ply).is_ok())
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let checkpoint = CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?
            .ok_or_else(|| {
                AppError::new(
                    "E-4005",
                    ErrorCategory::Engine,
                    "No Brush PLY to Export",
                    "Brush training did not produce a PLY checkpoint.",
                )
            })?;
        ExportManager::validate_ply(&checkpoint.path)?;
        std::fs::create_dir_all(&ctx.paths.output_dir).map_err(io_error)?;
        let temporary = ctx.paths.output_ply.with_extension("ply.tmp");
        std::fs::copy(&checkpoint.path, &temporary).map_err(io_error)?;
        ExportManager::validate_ply(&temporary)?;
        if ctx.paths.output_ply.exists() {
            std::fs::remove_file(&ctx.paths.output_ply).map_err(io_error)?;
        }
        std::fs::rename(&temporary, &ctx.paths.output_ply).map_err(io_error)?;
        let _ = progress_tx.send(
            TaskProgress::new(
                "Export",
                format!("Published checkpoint {} as scene.ply", checkpoint.iteration),
            )
            .with_percent(1.0),
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        ExportManager::validate_ply(&ctx.paths.output_ply)
    }
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Export Brush PLY",
        "The final PLY file could not be published.",
    )
    .with_technical(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn create_checkpoint(project: &Path) {
        let dir = project.join("training/checkpoints");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("checkpoint_003000.ply"),
            b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n",
        )
        .unwrap();
    }

    #[test]
    fn test_export_no_training_dir() {
        let stage = ExportStage::new();
        let ctx = StageContext::new(PipelineStageId::Export, Path::new("/nonexistent"), None);
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_export_with_valid_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        create_checkpoint(dir.path());
        let ctx = StageContext::new(PipelineStageId::Export, dir.path(), None);
        let stage = ExportStage::new();
        stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await
            .unwrap();
        assert!(dir.path().join("output/scene.ply").exists());
        assert!(stage.validate_outputs(&ctx).is_ok());
    }
}
