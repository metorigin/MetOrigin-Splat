use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_domain::runtime::{
    BrushCliProfile, CapabilityStatus, LiveProtocol, ResumeMode, RuntimePlatform,
};
use splat_engine_brush::{
    current_runtime_platform, probe_training_runtime, BrushAdapter, BrushProgressParser,
    Checkpoint, CheckpointScanner, ExportManager, ProfiledTrainingRequest, TrainingConfig,
    TrainingRuntimeEvidence,
};
use splat_process::{CompositeParser, ProcessResult, ProcessRunner};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

mod restore;
mod state;
pub use restore::{
    recover_checkpoint_restore, recover_checkpoint_restore_with_lock, restore_checkpoint,
};
use state::write_json_atomic;

/// Persisted evidence for one successful Brush training run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushTrainingResult {
    pub brush_version: String,
    pub preset: String,
    pub total_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sh_degree: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<u32>,
    pub resumed_from_iteration: u32,
    pub checkpoint_path: PathBuf,
    pub checkpoint_size_bytes: u64,
    pub duration_ms: u64,
    /// Brush v0.3.0 does not expose TrainStep loss on stdout/stderr.
    pub final_loss: Option<f64>,
    pub optimizer_state_restored: bool,
}

/// Executes the negotiated Brush CLI against the isolated COLMAP dataset prepared by the
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
        validate_runtime_profile(ctx)?;
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.training_result.is_file() || ctx.engine_paths.brush.is_none() {
            return Ok(false);
        }
        let config = effective_config(ctx, &self.preset_name)?;
        let adapter = resolved_adapter(ctx)?;
        let live_program = live_program(ctx, &adapter);
        let fingerprint = training_fingerprint(ctx, &config, &adapter, live_program.as_deref())?;
        state::completed_matches(ctx, &fingerprint, config.iterations)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        validate_runtime_profile(ctx)?;
        state::recover_archive(ctx)?;
        std::fs::create_dir_all(&ctx.paths.training_logs).map_err(io_error)?;
        let adapter = resolved_adapter(ctx)?;
        let config = effective_config(ctx, &self.preset_name)?;
        let live_program = live_program(ctx, &adapter);
        let fingerprint = training_fingerprint(ctx, &config, &adapter, live_program.as_deref())?;
        let previous = state::load(ctx)?;
        let can_resume = ctx
            .execution_profile
            .as_ref()
            .is_none_or(|profile| profile.resume_mode == ResumeMode::PlyWarmStartOptimizerReset);
        let matching_partial = previous.as_ref().is_some_and(|previous| {
            previous.fingerprint == fingerprint && previous.completed.is_none()
        });
        if !matching_partial || !can_resume {
            state::archive(ctx)?;
        }
        let latest = if matching_partial && can_resume {
            // A target-named checkpoint left by an unsuccessful process cannot
            // establish completion or be resumed at an already finished step.
            CheckpointScanner::scan(&ctx.paths.training_checkpoints)?
                .into_iter()
                .filter(|checkpoint| {
                    checkpoint.iteration > 0 && checkpoint.iteration < config.iterations
                })
                .max_by_key(|checkpoint| checkpoint.iteration)
        } else {
            None
        };
        if latest.is_none() && matching_partial && can_resume {
            state::archive(ctx)?;
        }
        std::fs::create_dir_all(&ctx.paths.training_checkpoints).map_err(io_error)?;
        state::start(ctx, fingerprint.clone())?;
        let start_iteration = latest.as_ref().map_or(0, |checkpoint| checkpoint.iteration);
        prepare_resume_ply(ctx, latest.as_ref())?;

        // Run the shared cancellable capability check immediately before GPU
        // training; the earlier desktop preflight may precede a lengthy SfM run.
        let runtime = probe_training_runtime(
            current_runtime_platform()?,
            adapter.brush_path(),
            &ctx.paths.training_logs,
            ctx.cancellation.clone(),
        )
        .await?;
        let verified_runtime = match &runtime {
            TrainingRuntimeEvidence::Metal(runtime) => Some(runtime.as_ref()),
            TrainingRuntimeEvidence::LegacyNvidia(_) => None,
        };

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

        let mut command = if let Some(profile) = ctx.execution_profile.as_ref() {
            adapter.build_train_command_for_profile(ProfiledTrainingRequest {
                config: &config,
                profile,
                verified_runtime,
                dataset_path: &ctx.paths.training_dataset,
                checkpoint_path: &ctx.paths.training_checkpoints,
                start_iteration,
                log_path: &ctx.log_path,
            })?
        } else {
            adapter.build_train_command(
                &config,
                &ctx.paths.training_dataset,
                &ctx.paths.training_checkpoints,
                start_iteration,
                &ctx.log_path,
            )
        }
        .with_cwd(&ctx.project_dir)
        .with_env(
            "RUST_LOG",
            "brush_cli=info,brush_process=info,brush_dataset::formats=info",
        )
        .with_timeout(Duration::from_secs(24 * 60 * 60));
        let live_session = splat_engine_brush::live_preview::LiveSession::start(
            &ctx.project_dir,
            live_program.is_some(),
        )
        .map_err(io_error)?;
        if let Some(program) = &live_program {
            command.program = program.clone();
            command = command
                .with_env("METORIGIN_BRUSH_LIVE_DIR", &live_session.directory)
                .with_env(
                    "METORIGIN_BRUSH_LIVE_SESSION",
                    &live_session.session.session_id,
                );
        }
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(BrushProgressParser::new(
            "BrushTraining",
            config.iterations as u64,
        )));

        let monitor_stop = CancellationToken::new();
        let monitor = splat_process::spawn_scoped(monitor_checkpoints(
            ctx.paths.training_checkpoints.clone(),
            config.iterations,
            progress_tx.clone(),
            monitor_stop.clone(),
        ));
        let process_result = ProcessRunner::with_parser(parsers)
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await;
        monitor_stop.cancel();
        let _ = monitor.await;
        drop(live_session);
        let process_result = process_result?;
        ensure_process_success(&process_result)?;

        let final_checkpoint = CheckpointScanner::find_latest(&ctx.paths.training_checkpoints)?
            .filter(|checkpoint| checkpoint.iteration == config.iterations)
            .ok_or_else(|| {
                AppError::new(
                    "E-4005",
                    ErrorCategory::Engine,
                    "Brush Final Checkpoint Missing",
                    "Brush exited successfully but did not export the expected final PLY checkpoint.",
                )
            })?;
        let metadata = ExportManager::inspect_ply(&final_checkpoint.path)?;
        if u32::from(metadata.sh_degree) != config.sh_degree
            || ctx.execution_profile.as_ref().is_some_and(|profile| {
                profile
                    .effective_training
                    .max_splats
                    .is_some_and(|maximum| metadata.vertex_count > u64::from(maximum))
            })
        {
            return Err(runtime_error(
                "Final Gaussian output does not match the effective SH degree or splat limit.",
            ));
        }

        if training_fingerprint(ctx, &config, &adapter, live_program.as_deref())? != fingerprint {
            return Err(runtime_error("Training inputs or the executable changed during training; checkpoints were preserved."));
        }

        let result = BrushTrainingResult {
            brush_version: adapter.version().to_string(),
            preset: self.preset_name.clone(),
            total_iterations: config.iterations,
            sh_degree: Some(config.sh_degree),
            resolution: ctx
                .execution_profile
                .as_ref()
                .and_then(|profile| profile.effective_training.resolution),
            resumed_from_iteration: start_iteration,
            checkpoint_path: relative_to_project(ctx, &final_checkpoint.path),
            checkpoint_size_bytes: final_checkpoint.size_bytes,
            duration_ms: process_result.duration_ms,
            final_loss: None,
            optimizer_state_restored: false,
        };
        write_json_atomic(&result, &ctx.paths.training_result)?;
        state::complete(ctx, fingerprint, &final_checkpoint.path, config.iterations)?;
        let resume_ply = ctx.paths.training_dataset.join("init.ply");
        if resume_ply.exists() {
            if let Err(error) = std::fs::remove_file(resume_ply) {
                tracing::warn!(%error, "Completed training resume copy could not be removed");
            }
        }

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !self.check_cached(ctx)? {
            return Err(runtime_error("Successful training metadata or its checkpoint no longer matches the current inputs."));
        }
        Ok(())
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
        ExportManager::validate_ply(&temporary)?;
        std::fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
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

fn effective_config(ctx: &StageContext, preset: &str) -> AppResult<TrainingConfig> {
    let requested = TrainingConfig::from_builtin(preset)?;
    match &ctx.execution_profile {
        Some(profile) => requested.with_effective_training(&profile.effective_training),
        None => Ok(requested),
    }
}

fn validate_runtime_profile(ctx: &StageContext) -> AppResult<()> {
    let platform = current_runtime_platform()?;
    if let Some(profile) = &ctx.execution_profile {
        profile.validate_for_execution()?;
        if profile.platform != platform {
            return Err(runtime_error(
                "Execution profile does not match this operating system.",
            ));
        }
    } else if platform == RuntimePlatform::Macos {
        return Err(runtime_error(
            "macOS training requires a verified execution profile.",
        ));
    }
    Ok(())
}

fn resolved_adapter(ctx: &StageContext) -> AppResult<BrushAdapter> {
    let path = ctx
        .engine_paths
        .brush
        .clone()
        .ok_or_else(|| runtime_error("Brush executable is unresolved."))?;
    BrushAdapter::from_path(path)
}

fn live_program(ctx: &StageContext, adapter: &BrushAdapter) -> Option<PathBuf> {
    match ctx.execution_profile.as_deref() {
        Some(profile) if profile.live_protocol == LiveProtocol::Disabled => None,
        Some(profile)
            if profile.brush.cli_profile == BrushCliProfile::Metorigin1
                && profile.live_protocol == LiveProtocol::PlyRequestAckV1
                && profile.brush.live_preview == CapabilityStatus::Supported =>
        {
            Some(adapter.brush_path().to_path_buf())
        }
        Some(profile) if profile.platform == RuntimePlatform::Macos => None,
        _ => adapter.live_preview_executable(),
    }
}

fn training_fingerprint(
    ctx: &StageContext,
    config: &TrainingConfig,
    adapter: &BrushAdapter,
    live_program: Option<&Path>,
) -> AppResult<String> {
    let hash = adapter.binary_sha256()?;
    let cli = adapter.cli_profile()?;
    if let Some(profile) = &ctx.execution_profile {
        profile.validate_for_execution()?;
        if hash != profile.engines.brush.binary_sha256 || cli != profile.brush.cli_profile {
            return Err(runtime_error(
                "Brush executable no longer matches the execution profile.",
            ));
        }
    }
    let live_hash = live_program.map(state::hash_file).transpose()?;
    state::fingerprint(ctx, config, adapter.version(), &hash, live_hash.as_deref())
}

fn runtime_error(detail: &str) -> AppError {
    AppError::new(
        "E-1403",
        ErrorCategory::Environment,
        "Training Runtime Changed",
        "The prepared training runtime could not be verified. Previous results were preserved.",
    )
    .with_technical(detail)
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

    #[cfg(unix)]
    #[test]
    fn negotiated_mac_live_uses_primary_engine_and_legacy_keeps_companion() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("brush-cli");
        std::fs::write(
            &program,
            "#!/bin/sh\necho 'brush-cli 1.0.0+metorigin-macos.4'\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let adapter = BrushAdapter::from_path(program.clone()).unwrap();
        let mut ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            dir.path(),
            Some("fast".into()),
        );
        let mut profile = splat_domain::ExecutionProfile::from_json(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schemas/examples/execution-profile/macos.valid.json"
        )))
        .unwrap();
        ctx.execution_profile = Some(std::sync::Arc::new(profile.clone()));
        assert!(live_program(&ctx, &adapter).is_none());
        profile.live_protocol = LiveProtocol::PlyRequestAckV1;
        profile.brush.live_preview = CapabilityStatus::Supported;
        ctx.execution_profile = Some(std::sync::Arc::new(profile.clone()));
        assert_eq!(live_program(&ctx, &adapter), Some(program));
        profile.brush.live_preview = CapabilityStatus::Unknown;
        ctx.execution_profile = Some(std::sync::Arc::new(profile));
        assert!(live_program(&ctx, &adapter).is_none());
        let companion = dir.path().join("brush_live");
        std::fs::write(
            &companion,
            "#!/bin/sh\necho 'brush_app 0.3.0+metorigin-live.1'\n",
        )
        .unwrap();
        std::fs::set_permissions(&companion, std::fs::Permissions::from_mode(0o755)).unwrap();
        ctx.execution_profile = None;
        assert_eq!(live_program(&ctx, &adapter), Some(companion));
    }

    #[test]
    fn old_training_result_remains_readable_without_effective_fields() {
        let result: BrushTrainingResult = serde_json::from_value(serde_json::json!({
            "brush_version":"0.3.0", "preset":"fast", "total_iterations":3000,
            "resumed_from_iteration":0, "checkpoint_path":"training/checkpoints/checkpoint_3000.ply",
            "checkpoint_size_bytes":1000, "duration_ms":100, "final_loss":null,
            "optimizer_state_restored":false
        })).unwrap();
        assert_eq!(result.sh_degree, None);
        assert_eq!(result.resolution, None);
        assert_eq!(result.total_iterations, 3000);
    }

    #[test]
    fn target_checkpoint_without_success_metadata_is_not_cacheable() {
        let dir = tempfile::tempdir().unwrap();
        let checkpoint_dir = dir.path().join("training/checkpoints");
        std::fs::create_dir_all(&checkpoint_dir).unwrap();
        std::fs::write(
            checkpoint_dir.join("checkpoint_003000.ply"),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
            )),
        )
        .unwrap();
        let stage = BrushTrainingStage::new("fast");
        let ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            dir.path(),
            Some("fast".into()),
        );
        assert!(!stage.check_cached(&ctx).unwrap());
    }
}
