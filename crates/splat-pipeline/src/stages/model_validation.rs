use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_brush::{CheckpointScanner, ExportManager};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelValidationReport {
    passed: bool,
    checkpoint_path: PathBuf,
    size_bytes: u64,
    vertex_count: u64,
}

/// Validates the newest verified Brush PLY checkpoint before export.
pub struct ModelValidationStage;

impl Default for ModelValidationStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelValidationStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ModelValidationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ModelValidation
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?.is_none() {
            return Err(AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "No Brush Checkpoint Found",
                "Brush training did not produce a PLY checkpoint.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        let path = validation_path(ctx);
        let report: ModelValidationReport = match std::fs::read_to_string(path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
        {
            Some(report) => report,
            None => return Ok(false),
        };
        let checkpoint = ctx.project_dir.join(&report.checkpoint_path);
        Ok(report.passed
            && std::fs::metadata(&checkpoint)
                .map(|metadata| metadata.len() == report.size_bytes)
                .unwrap_or(false)
            && ExportManager::validate_ply(&checkpoint).is_ok())
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
                    "No Brush Checkpoint Found",
                    "Brush training did not produce a PLY checkpoint.",
                )
            })?;
        ExportManager::validate_ply(&checkpoint.path)?;
        let vertex_count = ExportManager::vertex_count(&checkpoint.path)?;
        let report = ModelValidationReport {
            passed: true,
            checkpoint_path: checkpoint
                .path
                .strip_prefix(&ctx.project_dir)
                .unwrap_or(&checkpoint.path)
                .to_path_buf(),
            size_bytes: checkpoint.size_bytes,
            vertex_count,
        };
        std::fs::write(validation_path(ctx), serde_json::to_vec_pretty(&report)?)
            .map_err(io_error)?;
        let _ = progress_tx.send(
            TaskProgress::new(
                "ModelValidation",
                format!("Validated {vertex_count} Gaussian splats"),
            )
            .with_percent(1.0),
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if self.check_cached(ctx)? {
            Ok(())
        } else {
            Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Brush Model Validation Failed",
                "The Brush PLY validation report is missing or stale.",
            ))
        }
    }
}

fn validation_path(ctx: &StageContext) -> PathBuf {
    ctx.paths.training_dir.join("validation.json")
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Write Model Validation",
        "The model validation report could not be written.",
    )
    .with_technical(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_validate_no_training_dir() {
        let stage = ModelValidationStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ModelValidation,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_validate_with_brush_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let checkpoints = dir.path().join("training/checkpoints");
        std::fs::create_dir_all(&checkpoints).unwrap();
        std::fs::write(
            checkpoints.join("checkpoint_003000.ply"),
            b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n",
        )
        .unwrap();
        let ctx = StageContext::new(PipelineStageId::ModelValidation, dir.path(), None);
        let stage = ModelValidationStage::new();
        stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await
            .unwrap();
        assert!(stage.validate_outputs(&ctx).is_ok());
    }
}
