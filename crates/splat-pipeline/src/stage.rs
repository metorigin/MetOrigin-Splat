use std::path::{Path, PathBuf};

use splat_domain::error::AppResult;
use splat_domain::hardware::EnginePaths;
use splat_domain::pipeline::{PipelineStageId, StageState};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

/// Standard subdirectory and file names within a `.splat-project` directory.
pub const DIR_SOURCE: &str = "source";
pub const DIR_FRAMES: &str = "frames";
pub const DIR_PROCESSED: &str = "processed";
pub const DIR_COLMAP: &str = "colmap";
pub const DIR_TRAINING: &str = "training";
pub const DIR_TRAINING_CHECKPOINTS: &str = "training/checkpoints";
pub const DIR_TRAINING_CONFIG: &str = "training/config";
pub const DIR_OUTPUT: &str = "output";
pub const DIR_CACHE: &str = "cache";
pub const DIR_LOGS: &str = "logs";
pub const FILE_FRAMES_MANIFEST: &str = "frames.json";
pub const FILE_OUTPUT_MANIFEST: &str = "manifest.json";
pub const FILE_COLMAP_DB: &str = "database.db";
pub const FILE_COLMAP_RESULT: &str = "result.json";
pub const FILE_COLMAP_VALIDATION: &str = "validation.json";
pub const FILE_SPARSE_MODEL: &str = "0";
pub const FILE_PLY: &str = "scene.ply";

/// Convenience path builder for project subdirectories.
///
/// Avoids repeating path construction logic across all stage implementations.
#[derive(Debug, Clone)]
pub struct StagePaths {
    /// Project root directory.
    pub project_dir: PathBuf,

    // Source / input
    pub source_dir: PathBuf,
    pub frames_dir: PathBuf,
    pub frames_manifest: PathBuf,

    // Preprocessing
    pub processed_dir: PathBuf,

    // COLMAP
    pub colmap_dir: PathBuf,
    pub colmap_db: PathBuf,
    pub colmap_sparse: PathBuf,
    pub colmap_logs: PathBuf,
    pub colmap_result: PathBuf,
    pub colmap_validation: PathBuf,

    // Training
    pub training_dir: PathBuf,
    pub training_checkpoints: PathBuf,
    pub training_config: PathBuf,
    pub training_logs: PathBuf,

    // Output
    pub output_dir: PathBuf,
    pub output_ply: PathBuf,
    pub output_manifest: PathBuf,

    // Cache & logs
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl StagePaths {
    /// Create a new StagePaths for the given project directory.
    ///
    /// All paths are lazily constructed — no directories are created.
    pub fn new(project_dir: &Path) -> Self {
        Self {
            project_dir: project_dir.to_path_buf(),
            source_dir: project_dir.join(DIR_SOURCE),
            frames_dir: project_dir.join(DIR_FRAMES),
            frames_manifest: project_dir.join(DIR_FRAMES).join(FILE_FRAMES_MANIFEST),
            processed_dir: project_dir.join(DIR_PROCESSED),
            colmap_dir: project_dir.join(DIR_COLMAP),
            colmap_db: project_dir.join(DIR_COLMAP).join(FILE_COLMAP_DB),
            colmap_sparse: project_dir.join(DIR_COLMAP).join("sparse"),
            colmap_logs: project_dir.join(DIR_COLMAP).join("logs"),
            colmap_result: project_dir.join(DIR_COLMAP).join(FILE_COLMAP_RESULT),
            colmap_validation: project_dir.join(DIR_COLMAP).join(FILE_COLMAP_VALIDATION),
            training_dir: project_dir.join(DIR_TRAINING),
            training_checkpoints: project_dir.join(DIR_TRAINING_CHECKPOINTS),
            training_config: project_dir.join(DIR_TRAINING_CONFIG),
            training_logs: project_dir.join(DIR_TRAINING).join("logs"),
            output_dir: project_dir.join(DIR_OUTPUT),
            output_ply: project_dir.join(DIR_OUTPUT).join(FILE_PLY),
            output_manifest: project_dir.join(DIR_OUTPUT).join(FILE_OUTPUT_MANIFEST),
            cache_dir: project_dir.join(DIR_CACHE),
            logs_dir: project_dir.join(DIR_LOGS),
        }
    }

    /// Return the path to a log file for a specific stage.
    pub fn stage_log(&self, stage_id: &PipelineStageId) -> PathBuf {
        let name = stage_id.label().to_lowercase().replace(' ', "_");
        self.logs_dir.join(format!("{}.log", name))
    }

    /// Return the path to the best COLMAP sparse model directory.
    pub fn colmap_model_dir(&self) -> PathBuf {
        self.colmap_sparse.join(FILE_SPARSE_MODEL)
    }
}

/// Context provided to a stage during execution.
#[derive(Debug, Clone)]
pub struct StageContext {
    /// The stage being executed.
    pub stage_id: PipelineStageId,
    /// Project root directory.
    pub project_dir: PathBuf,
    /// Standardized project paths.
    pub paths: StagePaths,
    /// Path to the log file for this stage.
    pub log_path: PathBuf,
    /// Training preset name (e.g. "fast", "balanced", "quality").
    pub preset: Option<String>,
    /// Executable paths resolved once when the pipeline is created.
    pub engine_paths: EnginePaths,
    /// Shared cancellation token for the active pipeline run.
    pub cancellation: CancellationToken,
}

impl StageContext {
    /// Create a new stage context for the given stage and project.
    pub fn new(stage_id: PipelineStageId, project_dir: &Path, preset: Option<String>) -> Self {
        Self::with_cancellation(stage_id, project_dir, preset, CancellationToken::new())
    }

    pub fn with_cancellation(
        stage_id: PipelineStageId,
        project_dir: &Path,
        preset: Option<String>,
        cancellation: CancellationToken,
    ) -> Self {
        Self::with_configuration(
            stage_id,
            project_dir,
            preset,
            EnginePaths::default(),
            cancellation,
        )
    }

    pub fn with_configuration(
        stage_id: PipelineStageId,
        project_dir: &Path,
        preset: Option<String>,
        engine_paths: EnginePaths,
        cancellation: CancellationToken,
    ) -> Self {
        let paths = StagePaths::new(project_dir);
        let log_path = paths.stage_log(&stage_id);
        Self {
            stage_id,
            project_dir: project_dir.to_path_buf(),
            paths,
            log_path,
            preset,
            engine_paths,
            cancellation,
        }
    }
}

/// A single executable stage in the Gaussian Splatting pipeline.
///
/// Each stage is independently executable, resumable, and cacheable.
/// Stages communicate progress via a broadcast channel.
///
/// # Lifecycle
///
/// 1. `check_cached()` — check if outputs already exist (skip if true)
/// 2. `validate_inputs()` — verify required inputs are present
/// 3. `execute()` — perform the stage work, sending progress events
/// 4. `validate_outputs()` — verify outputs are correct after execution
#[async_trait::async_trait]
pub trait PipelineStage: Send + Sync {
    /// Return the unique identifier for this stage.
    fn id(&self) -> PipelineStageId;

    /// Return a human-readable name for this stage.
    fn name(&self) -> &'static str {
        self.id().label()
    }

    /// Validate that the stage inputs are present and correct.
    ///
    /// Called before `execute()` and before `check_cached()`.
    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()>;

    /// Check if this stage can be skipped because outputs already exist.
    ///
    /// Called after `validate_inputs()`. If this returns `true`, the
    /// orchestrator will skip `execute()` and `validate_outputs()`.
    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool>;

    /// Execute the stage, sending progress events via the broadcast channel.
    ///
    /// The implementation should periodically check for cancellation
    /// by monitoring the receiver side of the progress channel and
    /// exit early if appropriate.
    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState>;

    /// Validate that the stage outputs are correct after execution.
    ///
    /// Called after `execute()` completes successfully. Use this to
    /// verify that output files exist and contain valid data.
    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stage_paths_new() {
        let paths = StagePaths::new(Path::new("/test/project.splat-project"));
        assert!(paths.source_dir.ends_with("source"));
        assert!(paths.frames_dir.ends_with("frames"));
        assert!(paths.colmap_db.ends_with("database.db"));
        assert!(paths.colmap_sparse.ends_with("sparse"));
        assert!(paths.output_ply.ends_with("scene.ply"));
        assert!(paths.logs_dir.ends_with("logs"));
    }

    #[test]
    fn test_stage_log_path() {
        let paths = StagePaths::new(Path::new("/p"));
        let log = paths.stage_log(&PipelineStageId::FrameExtraction);
        assert!(log.to_string_lossy().contains("frame_extraction.log"));
    }

    #[test]
    fn test_stage_context_new() {
        let ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            Path::new("/project.splat-project"),
            Some("balanced".into()),
        );
        assert_eq!(ctx.stage_id, PipelineStageId::BrushTraining);
        assert_eq!(ctx.preset.as_deref(), Some("balanced"));
    }

    #[test]
    fn test_stage_context_paths() {
        let ctx = StageContext::new(
            PipelineStageId::MediaValidation,
            Path::new("/p.splat-project"),
            None,
        );
        assert!(ctx.paths.frames_manifest.ends_with("frames.json"));
    }

    #[test]
    fn test_pipeline_stage_id_labels() {
        assert_eq!(PipelineStageId::MediaValidation.label(), "Media Validation");
        assert_eq!(PipelineStageId::FrameExtraction.label(), "Frame Extraction");
        assert_eq!(PipelineStageId::BrushTraining.label(), "Brush Training");
    }

    struct MockStage;

    #[async_trait::async_trait]
    impl PipelineStage for MockStage {
        fn id(&self) -> PipelineStageId {
            PipelineStageId::MediaValidation
        }

        fn validate_inputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }

        fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
            Ok(false)
        }

        async fn execute(
            &self,
            _ctx: &StageContext,
            _progress_tx: broadcast::Sender<TaskProgress>,
        ) -> AppResult<StageState> {
            Ok(StageState::new(PipelineStageId::MediaValidation))
        }

        fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }
    }

    #[test]
    fn test_mock_stage() {
        let stage = MockStage;
        assert_eq!(stage.id(), PipelineStageId::MediaValidation);
        assert_eq!(stage.name(), "Media Validation");
    }
}
