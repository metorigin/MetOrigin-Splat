use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_brush::{
    BrushAdapter, BrushProgressParser, Checkpoint, CheckpointScanner, ExportManager, TrainingConfig,
};
use splat_process::{CompositeParser, ProcessResult, ProcessRunner};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Persisted evidence for one successful Brush training run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushTrainingResult {
    pub brush_version: String,
    pub preset: String,
    pub total_iterations: u32,
    pub resumed_from_iteration: u32,
    pub checkpoint_path: PathBuf,
    pub checkpoint_size_bytes: u64,
    pub duration_ms: u64,
    /// Brush v0.3.0 does not expose TrainStep loss on stdout/stderr.
    pub final_loss: Option<f64>,
    pub optimizer_state_restored: bool,
}

/// Executes Brush v0.3.0 against the isolated COLMAP dataset prepared by the
/// previous stage. Periodic PLY exports are both progress evidence and
/// geometry-only recovery checkpoints.
pub struct BrushTrainingStage {
    preset_name: String,
}

impl BrushTrainingStage {
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
        }
    }
}

#[async_trait::async_trait]
impl PipelineStage for BrushTrainingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::BrushTraining
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        let model_dir = ctx.paths.training_dataset.join("sparse/0");
        if !colmap_support::has_complete_model(&model_dir) {
            return Err(AppError::new(
                "E-4002",
                ErrorCategory::Engine,
                "Prepared COLMAP Model Missing",
                "The isolated Brush dataset does not contain a complete COLMAP model.",
            ));
        }
        if count_images(&ctx.paths.training_dataset.join("images")) == 0 {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Prepared Training Images Missing",
                "The isolated Brush dataset does not contain training images.",
            ));
        }
        if ctx.engine_paths.brush.is_none() {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Brush Not Found",
                "Brush was not found in the configured engine directory, application resources, or PATH.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        let config = TrainingConfig::from_builtin(&self.preset_name)?;
        let latest = CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?;
        Ok(latest
            .filter(|checkpoint| checkpoint.iteration >= config.iterations)
            .map(|checkpoint| ExportManager::validate_ply(&checkpoint.path).is_ok())
            .unwrap_or(false))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        std::fs::create_dir_all(&ctx.paths.training_checkpoints).map_err(io_error)?;
        std::fs::create_dir_all(&ctx.paths.training_logs).map_err(io_error)?;

        let brush_path = ctx.engine_paths.brush.clone().ok_or_else(|| {
            AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Brush Not Found",
                "Brush is required for training but was not resolved.",
            )
        })?;
        let adapter = BrushAdapter::from_path(brush_path)?;
        let config = TrainingConfig::from_builtin(&self.preset_name)?;
        let latest = CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?;
        let start_iteration = latest
            .as_ref()
            .map(|checkpoint| checkpoint.iteration.min(config.iterations))
            .unwrap_or(0);
        prepare_resume_ply(ctx, latest.as_ref())?;

        let _ = progress_tx.send(
            TaskProgress::new(
                "BrushTraining",
                if start_iteration > 0 {
                    format!(
                        "Resuming geometry from iteration {start_iteration}; optimizer state restarts"
                    )
                } else {
                    "Loading the prepared COLMAP dataset".to_string()
                },
            )
            .with_percent(start_iteration as f64 / config.iterations as f64)
            .with_items(start_iteration as u64, config.iterations as u64),
        );

        let command = adapter
            .build_train_command(
                &config,
                &ctx.paths.training_dataset,
                &ctx.paths.training_checkpoints,
                start_iteration,
                &ctx.log_path,
            )
            .with_cwd(&ctx.project_dir)
            .with_env(
                "RUST_LOG",
                "brush_cli=info,brush_process=info,brush_dataset::formats=info",
            )
            .with_timeout(Duration::from_secs(24 * 60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(BrushProgressParser::new(
            "BrushTraining",
            config.iterations as u64,
        )));

        let monitor_stop = CancellationToken::new();
        let monitor = tokio::spawn(monitor_checkpoints(
            ctx.paths.training_checkpoints.clone(),
            config.iterations,
            progress_tx.clone(),
            monitor_stop.clone(),
        ));
        let process_result = ProcessRunner::with_parser(parsers)
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        monitor_stop.cancel();
        let _ = monitor.await;
        ensure_process_success(&process_result)?;

        let final_checkpoint = CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?
            .filter(|checkpoint| checkpoint.iteration >= config.iterations)
            .ok_or_else(|| {
                AppError::new(
                    "E-4005",
                    ErrorCategory::Engine,
                    "Brush Final Checkpoint Missing",
                    "Brush exited successfully but did not export the expected final PLY checkpoint.",
                )
            })?;
        ExportManager::validate_ply(&final_checkpoint.path)?;

        let result = BrushTrainingResult {
            brush_version: adapter.version().to_string(),
            preset: self.preset_name.clone(),
            total_iterations: config.iterations,
            resumed_from_iteration: start_iteration,
            checkpoint_path: relative_to_project(ctx, &final_checkpoint.path),
            checkpoint_size_bytes: final_checkpoint.size_bytes,
            duration_ms: process_result.duration_ms,
            final_loss: None,
            optimizer_state_restored: false,
        };
        write_json_atomic(&result, &ctx.paths.training_result)?;
        let resume_ply = ctx.paths.training_dataset.join("init.ply");
        if resume_ply.exists() {
            let _ = std::fs::remove_file(resume_ply);
        }

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        let result: BrushTrainingResult = serde_json::from_str(
            &std::fs::read_to_string(&ctx.paths.training_result).map_err(io_error)?,
        )
        .map_err(|error| {
            AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "Invalid Brush Training Result",
                "The Brush training result file is malformed.",
            )
            .with_technical(error.to_string())
        })?;
        let checkpoint = ctx.project_dir.join(result.checkpoint_path);
        ExportManager::validate_ply(&checkpoint)
    }
}

async fn monitor_checkpoints(
    directory: PathBuf,
    total_iterations: u32,
    progress_tx: broadcast::Sender<TaskProgress>,
    stop: CancellationToken,
) {
    let mut last_iteration = 0;
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                if let Ok(Some(checkpoint)) = CheckpointScanner::find_latest(&directory) {
                    if checkpoint.iteration > last_iteration {
                        last_iteration = checkpoint.iteration;
                        let _ = progress_tx.send(
                            TaskProgress::new(
                                "BrushTraining",
                                format!("PLY checkpoint saved at iteration {}", checkpoint.iteration),
                            )
                            .with_percent(checkpoint.iteration.min(total_iterations) as f64 / total_iterations as f64)
                            .with_items(checkpoint.iteration as u64, total_iterations as u64),
                        );
                    }
                }
            }
        }
    }
}

fn prepare_resume_ply(ctx: &StageContext, checkpoint: Option<&Checkpoint>) -> AppResult<()> {
    let resume_path = ctx.paths.training_dataset.join("init.ply");
    if let Some(checkpoint) = checkpoint {
        let temporary = resume_path.with_extension("ply.tmp");
        std::fs::copy(&checkpoint.path, &temporary).map_err(io_error)?;
        if resume_path.exists() {
            std::fs::remove_file(&resume_path).map_err(io_error)?;
        }
        std::fs::rename(temporary, resume_path).map_err(io_error)?;
    } else if resume_path.exists() {
        std::fs::remove_file(resume_path).map_err(io_error)?;
    }
    Ok(())
}

fn ensure_process_success(result: &ProcessResult) -> AppResult<()> {
    if result.cancelled {
        return Err(AppError::new(
            "E-4004",
            ErrorCategory::Engine,
            "Brush Training Cancelled",
            "Brush training was cancelled; existing PLY checkpoints were preserved.",
        ));
    }
    if result.timed_out {
        return Err(AppError::new(
            "E-4004",
            ErrorCategory::Engine,
            "Brush Training Timed Out",
            "Brush training exceeded the 24 hour safety timeout.",
        ));
    }
    if !result.is_success() {
        return Err(AppError::new(
            "E-4003",
            ErrorCategory::Engine,
            "Brush Training Failed",
            "Brush returned an error. Check the Brush stage log for details.",
        )
        .with_technical(format!("exit_code={:?}", result.exit_code))
        .retryable(true));
    }
    Ok(())
}

fn count_images(path: &Path) -> usize {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| {
                            matches!(
                                extension.to_ascii_lowercase().as_str(),
                                "jpg" | "jpeg" | "png"
                            )
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

fn relative_to_project(ctx: &StageContext, path: &Path) -> PathBuf {
    path.strip_prefix(&ctx.project_dir)
        .unwrap_or(path)
        .to_path_buf()
}

fn write_json_atomic<T: Serialize>(value: &T, path: &Path) -> AppResult<()> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = std::fs::File::create(&temporary).map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    if path.exists() {
        std::fs::remove_file(path).map_err(io_error)?;
    }
    std::fs::rename(temporary, path).map_err(io_error)
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Brush File Operation Failed",
        "A Brush training file could not be read or written.",
    )
    .with_technical(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_brush_training_no_dataset() {
        let stage = BrushTrainingStage::new("balanced");
        let ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            Path::new("/nonexistent"),
            Some("balanced".into()),
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_checkpoint_progress_is_cacheable_at_target_iteration() {
        let dir = tempfile::tempdir().unwrap();
        let checkpoint_dir = dir.path().join("training/checkpoints");
        std::fs::create_dir_all(&checkpoint_dir).unwrap();
        std::fs::write(
            checkpoint_dir.join("checkpoint_003000.ply"),
            b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n",
        )
        .unwrap();
        let stage = BrushTrainingStage::new("fast");
        let ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            dir.path(),
            Some("fast".into()),
        );
        assert!(stage.check_cached(&ctx).unwrap());
    }
}
