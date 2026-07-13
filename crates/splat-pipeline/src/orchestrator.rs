use std::sync::Arc;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, PipelineState, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::{broadcast, RwLock};
use tokio_util::sync::CancellationToken;

use crate::lock::{LockGuard, ProjectLock};
use crate::stage::{PipelineStage, StageContext};
use crate::stages::{
    BrushTrainingStage, ColmapFeatureStage, ColmapMappingStage, ColmapMatchingStage,
    ColmapValidationStage, ExportStage, FrameExtractionStage, ImagePreprocessingStage,
    MediaValidationStage, ModelValidationStage, PreviewGenerationStage, TrainingPreparationStage,
};

/// Events emitted by the pipeline orchestrator.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum OrchestratorEvent {
    /// A stage has started execution
    StageStarted(PipelineStageId),
    /// A stage has completed successfully
    StageCompleted(PipelineStageId),
    /// A stage has failed
    StageFailed(PipelineStageId, String),
    /// A stage has been skipped (cached output found)
    StageSkipped(PipelineStageId),
    /// A stage progress update
    StageProgress(TaskProgress),
    /// The entire pipeline has completed
    PipelineCompleted,
    /// The pipeline has failed
    PipelineFailed(String),
    /// The pipeline was cancelled
    PipelineCancelled,
}

/// Orchestrates the execution of all pipeline stages.
///
/// Manages the pipeline state machine, stage dependencies, retries,
/// caching, crash recovery, and project locking.
pub struct PipelineOrchestrator {
    /// Current pipeline state
    state: Arc<RwLock<PipelineState>>,
    /// Registered stages in execution order
    stages: Vec<Box<dyn PipelineStage>>,
    /// Events broadcast channel
    event_tx: broadcast::Sender<OrchestratorEvent>,
    /// Project directory path
    project_dir: std::path::PathBuf,
    /// Optional project lock guard (held while pipeline runs)
    lock_guard: Arc<RwLock<Option<LockGuard>>>,
    /// Shared cancellation signal propagated to every stage.
    cancellation: CancellationToken,
}

impl PipelineOrchestrator {
    /// Create a new pipeline orchestrator for a project.
    pub fn new(project_dir: std::path::PathBuf) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            state: Arc::new(RwLock::new(PipelineState::new())),
            stages: Vec::new(),
            event_tx,
            project_dir,
            lock_guard: Arc::new(RwLock::new(None)),
            cancellation: CancellationToken::new(),
        }
    }

    /// Create a default pipeline with all 12 stages registered in order.
    ///
    /// This is the standard factory method for production use. Stages are:
    ///
    /// 1. MediaValidation      7. ColmapValidation (TODO)
    /// 2. FrameExtraction      8. TrainingPreparation (TODO)
    /// 3. ImagePreprocessing (TODO)  9. BrushTraining
    /// 4. ColmapFeatureExtraction   10. ModelValidation (TODO)
    /// 5. ColmapMatching       11. PreviewGeneration (TODO)
    /// 6. ColmapMapping        12. Export (TODO)
    pub fn new_default(project_dir: std::path::PathBuf) -> Self {
        let mut orch = Self::new(project_dir);

        // Stage 1: Media validation
        orch.register_stage(Box::new(MediaValidationStage::new()));

        // Stage 2: Frame extraction
        orch.register_stage(Box::new(FrameExtractionStage::new("balanced")));

        // Stage 3: Image preprocessing (copy frames → processed/)
        orch.register_stage(Box::new(ImagePreprocessingStage::new()));

        // Stage 4: COLMAP feature extraction
        orch.register_stage(Box::new(ColmapFeatureStage::new()));

        // Stage 5: COLMAP feature matching
        orch.register_stage(Box::new(ColmapMatchingStage::new()));

        // Stage 6: COLMAP sparse mapping
        orch.register_stage(Box::new(ColmapMappingStage::new()));

        // Stage 7: COLMAP validation
        orch.register_stage(Box::new(ColmapValidationStage::new()));

        // Stage 8: Training preparation
        orch.register_stage(Box::new(TrainingPreparationStage::new("balanced")));

        // Stage 9: Brush training
        orch.register_stage(Box::new(BrushTrainingStage::new("balanced")));

        // Stage 10: Model validation
        orch.register_stage(Box::new(ModelValidationStage::new()));

        // Stage 11: Preview generation
        orch.register_stage(Box::new(PreviewGenerationStage::new()));

        // Stage 12: Export — pipeline loop closure!
        orch.register_stage(Box::new(ExportStage::new()));

        orch
    }

    /// Register a stage in the pipeline (appended to execution order).
    pub fn register_stage(&mut self, stage: Box<dyn PipelineStage>) {
        self.stages.push(stage);
    }

    /// Initialize the pipeline state from an existing state (e.g. after recovery).
    pub async fn initialize_from(&self, state: PipelineState) {
        let mut current = self.state.write().await;
        *current = state;
    }

    /// Start the pipeline execution with a project lock.
    ///
    /// Acquires a file-system lock to prevent concurrent execution, then
    /// runs all stages. The lock is automatically released when the
    /// pipeline completes or fails.
    pub async fn start_with_lock(&self, stage: &str) -> AppResult<()> {
        // Acquire project lock
        let guard = ProjectLock::try_lock(&self.project_dir, stage).map_err(|e| {
            AppError::new(
                "E-9002",
                ErrorCategory::Internal,
                "Project Already Running",
                format!("Cannot start pipeline — {}", e),
            )
        })?;

        // Store lock guard
        {
            let mut lock = self.lock_guard.write().await;
            *lock = Some(guard);
        }

        // Run the pipeline
        let result = self.start().await;

        // Release the lock on completion
        {
            let mut lock = self.lock_guard.write().await;
            if let Some(g) = lock.take() {
                g.release();
            }
        }

        result
    }

    /// Start the pipeline execution from the first pending stage.
    pub async fn start(&self) -> AppResult<()> {
        let state = self.state.read().await;
        if state.current_stage.is_some() {
            return Err(AppError::new(
                "E-9001",
                ErrorCategory::Internal,
                "Pipeline Already Running",
                "The pipeline is already running. Wait for it to finish or cancel it first.",
            ));
        }
        drop(state);

        // Execute stages in order
        for stage_reg in &self.stages {
            if self.cancellation.is_cancelled() {
                self.finish_cancelled().await?;
                return Ok(());
            }
            let sid = stage_reg.id();

            // Build stage context
            let ctx = StageContext::with_cancellation(
                sid,
                &self.project_dir,
                None,
                self.cancellation.clone(),
            );

            // Check stage status from state
            let should_run = {
                let state = self.state.read().await;
                let should = state
                    .stages
                    .get(&sid)
                    .map(|s| s.status != StageStatus::Completed && s.status != StageStatus::Skipped)
                    .unwrap_or(true);
                should
            };

            if !should_run {
                continue;
            }

            // Check if this stage can be skipped (cached outputs exist)
            let cached = stage_reg.check_cached(&ctx).unwrap_or(false);
            if cached {
                let mut state = self.state.write().await;
                if let Some(s) = state.stages.get_mut(&sid) {
                    s.status = StageStatus::Skipped;
                    s.progress = 1.0;
                    s.ended_at = Some(chrono::Utc::now());
                }
                let _ = self.event_tx.send(OrchestratorEvent::StageSkipped(sid));
                drop(state);
                self.update_overall_progress().await;
                self.persist_state().await?;
                continue;
            }

            // Mark as running
            {
                let mut state = self.state.write().await;
                if let Some(s) = state.stages.get_mut(&sid) {
                    s.status = StageStatus::Running;
                    s.started_at = Some(chrono::Utc::now());
                    s.ended_at = None;
                    s.error = None;
                    s.log_path = Some(
                        ctx.log_path
                            .strip_prefix(&self.project_dir)
                            .unwrap_or(&ctx.log_path)
                            .to_string_lossy()
                            .to_string(),
                    );
                }
                state.current_stage = Some(sid);
            }
            let _ = self.event_tx.send(OrchestratorEvent::StageStarted(sid));
            self.persist_state().await?;

            // Validate inputs
            if let Err(error) = stage_reg.validate_inputs(&ctx) {
                self.fail_stage(sid, &error).await?;
                return Err(error);
            }

            // Execute the stage
            let (progress_tx, mut progress_rx) = broadcast::channel(64);
            let event_tx = self.event_tx.clone();
            let progress_forwarder = tokio::spawn(async move {
                while let Ok(progress) = progress_rx.recv().await {
                    let _ = event_tx.send(OrchestratorEvent::StageProgress(progress));
                }
            });
            let result = stage_reg.execute(&ctx, progress_tx).await;
            progress_forwarder.abort();

            if self.cancellation.is_cancelled() {
                self.finish_cancelled().await?;
                return Ok(());
            }

            match result {
                Ok(stage_state) => {
                    // Validate outputs
                    if let Err(error) = stage_reg.validate_outputs(&ctx) {
                        self.fail_stage(sid, &error).await?;
                        return Err(error);
                    }

                    let mut state = self.state.write().await;
                    let mut completed = stage_state;
                    completed.status = StageStatus::Completed;
                    completed.progress = 1.0;
                    completed.ended_at = Some(chrono::Utc::now());
                    completed.log_path = Some(
                        ctx.log_path
                            .strip_prefix(&self.project_dir)
                            .unwrap_or(&ctx.log_path)
                            .to_string_lossy()
                            .to_string(),
                    );
                    state.stages.insert(sid, completed);
                    state.current_stage = None;

                    let _ = self.event_tx.send(OrchestratorEvent::StageCompleted(sid));
                    drop(state);
                    self.update_overall_progress().await;
                    self.persist_state().await?;
                }
                Err(e) => {
                    self.fail_stage(sid, &e).await?;
                    return Err(e);
                }
            }
        }

        self.persist_state().await?;
        let _ = self.event_tx.send(OrchestratorEvent::PipelineCompleted);
        Ok(())
    }

    /// Cancel the running pipeline.
    pub async fn cancel(&self) -> AppResult<()> {
        self.cancellation.cancel();
        let mut state = self.state.write().await;
        if let Some(stage_id) = state.current_stage {
            if let Some(stage) = state.stages.get_mut(&stage_id) {
                stage.status = StageStatus::Cancelling;
            }
        }
        drop(state);
        self.persist_state().await?;

        Ok(())
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// Get the current pipeline state.
    pub async fn get_state(&self) -> PipelineState {
        self.state.read().await.clone()
    }

    /// Subscribe to orchestrator events.
    pub fn subscribe(&self) -> broadcast::Receiver<OrchestratorEvent> {
        self.event_tx.subscribe()
    }

    /// Recompute overall pipeline progress.
    ///
    /// Progress is the average of all individual stage progress values.
    async fn update_overall_progress(&self) {
        let mut state = self.state.write().await;
        let total = state.stages.len() as f64;
        if total > 0.0 {
            let sum: f64 = state.stages.values().map(|s| s.progress).sum();
            state.overall_progress = (sum / total).clamp(0.0, 1.0);
        }
    }

    async fn finish_cancelled(&self) -> AppResult<()> {
        let mut state = self.state.write().await;
        if let Some(stage_id) = state.current_stage {
            if let Some(stage) = state.stages.get_mut(&stage_id) {
                stage.status = StageStatus::Cancelled;
                stage.ended_at = Some(chrono::Utc::now());
            }
        }
        state.current_stage = None;
        drop(state);
        self.persist_state().await?;
        let _ = self.event_tx.send(OrchestratorEvent::PipelineCancelled);
        Ok(())
    }

    async fn fail_stage(&self, stage_id: PipelineStageId, error: &AppError) -> AppResult<()> {
        let mut state = self.state.write().await;
        if let Some(stage) = state.stages.get_mut(&stage_id) {
            stage.status = StageStatus::Failed;
            stage.error = Some(error.to_string());
            stage.ended_at = Some(chrono::Utc::now());
        }
        state.current_stage = None;
        drop(state);
        self.persist_state().await?;
        let _ = self
            .event_tx
            .send(OrchestratorEvent::StageFailed(stage_id, error.to_string()));
        let _ = self
            .event_tx
            .send(OrchestratorEvent::PipelineFailed(format!(
                "Stage {} failed: {}",
                stage_id.label(),
                error
            )));
        Ok(())
    }

    async fn persist_state(&self) -> AppResult<()> {
        if !self.project_dir.join("project.json").exists() {
            return Ok(());
        }
        let state = self.state.read().await.clone();
        let projects_dir = self
            .project_dir
            .parent()
            .unwrap_or(&self.project_dir)
            .to_path_buf();
        splat_project::ProjectManager::new(projects_dir)
            .save_pipeline_state(&self.project_dir, &state)
    }
}

// ─── Skeleton stage for unimplemented pipeline stages ─────────────────────

/// A skeleton stage that always succeeds immediately.
///
/// Used for stages that are defined in the pipeline but not yet implemented.
/// These stages do no work — they just mark themselves as completed.
pub struct SkeletonStage(pub PipelineStageId);

#[async_trait::async_trait]
impl PipelineStage for SkeletonStage {
    fn id(&self) -> PipelineStageId {
        self.0
    }

    fn validate_inputs(&self, _ctx: &StageContext) -> AppResult<()> {
        Ok(())
    }

    fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
        // Skeleton stages are never cached — they always "run" (trivially)
        Ok(false)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::debug!(
            "Skeleton stage '{}' completed (no-op)",
            ctx.stage_id.label()
        );
        let mut state = StageState::new(self.0);
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stage::StageContext;
    use tokio::sync::broadcast;

    struct FakeStage {
        id: PipelineStageId,
        should_fail: bool,
        cached: bool,
    }

    impl FakeStage {
        fn new(id: PipelineStageId) -> Self {
            Self {
                id,
                should_fail: false,
                cached: false,
            }
        }

        fn with_cached(id: PipelineStageId, cached: bool) -> Self {
            Self {
                id,
                should_fail: false,
                cached,
            }
        }
    }

    #[async_trait::async_trait]
    impl PipelineStage for FakeStage {
        fn id(&self) -> PipelineStageId {
            self.id
        }

        fn validate_inputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }

        fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
            Ok(self.cached)
        }

        async fn execute(
            &self,
            _ctx: &StageContext,
            _progress_tx: broadcast::Sender<TaskProgress>,
        ) -> AppResult<StageState> {
            if self.should_fail {
                return Err(AppError::new(
                    "E-9999",
                    ErrorCategory::Internal,
                    "Fake Failure",
                    "Simulated stage failure for testing.",
                ));
            }
            let mut state = StageState::new(self.id);
            state.status = StageStatus::Completed;
            state.progress = 1.0;
            Ok(state)
        }

        fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_orchestrator_creation() {
        let orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        let state = orch.get_state().await;
        assert_eq!(state.stages.len(), 12);
        assert!(state.current_stage.is_none());
    }

    #[tokio::test]
    async fn test_orchestrator_runs_stages() {
        let mut orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        orch.register_stage(Box::new(FakeStage::new(PipelineStageId::MediaValidation)));
        orch.register_stage(Box::new(FakeStage::new(PipelineStageId::FrameExtraction)));

        let result = orch.start().await;
        assert!(result.is_ok());

        let state = orch.get_state().await;
        assert_eq!(
            state
                .stages
                .get(&PipelineStageId::MediaValidation)
                .unwrap()
                .status,
            StageStatus::Completed
        );
        assert_eq!(
            state
                .stages
                .get(&PipelineStageId::FrameExtraction)
                .unwrap()
                .status,
            StageStatus::Completed
        );
    }

    #[tokio::test]
    async fn test_orchestrator_handles_failure() {
        let mut orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        let mut stage = FakeStage::new(PipelineStageId::MediaValidation);
        stage.should_fail = true;
        orch.register_stage(Box::new(stage));

        let result = orch.start().await;
        assert!(result.is_err());

        let state = orch.get_state().await;
        assert_eq!(
            state
                .stages
                .get(&PipelineStageId::MediaValidation)
                .unwrap()
                .status,
            StageStatus::Failed
        );
    }

    #[tokio::test]
    async fn test_orchestrator_skips_cached() {
        let mut orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        orch.register_stage(Box::new(FakeStage::with_cached(
            PipelineStageId::MediaValidation,
            true,
        )));
        orch.register_stage(Box::new(FakeStage::new(PipelineStageId::FrameExtraction)));

        let result = orch.start().await;
        assert!(result.is_ok());

        let state = orch.get_state().await;
        assert_eq!(
            state
                .stages
                .get(&PipelineStageId::MediaValidation)
                .unwrap()
                .status,
            StageStatus::Skipped
        );
        assert_eq!(
            state
                .stages
                .get(&PipelineStageId::FrameExtraction)
                .unwrap()
                .status,
            StageStatus::Completed
        );
    }

    #[tokio::test]
    async fn test_new_default_registers_all_stages() {
        let orch = PipelineOrchestrator::new_default(std::path::PathBuf::from("/test"));
        let state = orch.get_state().await;
        // Should have 12 registered stages
        // Each stage starts at Pending
        let pending_count = state
            .stages
            .values()
            .filter(|s| s.status == StageStatus::Pending)
            .count();
        assert_eq!(pending_count, 12);
    }

    #[tokio::test]
    async fn test_skeleton_stage_immediately_completes() {
        let orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));

        // Register a skeleton stage
        let mut orch = orch;
        orch.register_stage(Box::new(SkeletonStage(PipelineStageId::Export)));

        let result = orch.start().await;
        assert!(result.is_ok());

        let state = orch.get_state().await;
        assert_eq!(
            state.stages.get(&PipelineStageId::Export).unwrap().status,
            StageStatus::Completed
        );
    }

    #[tokio::test]
    async fn test_overall_progress_updates() {
        let mut orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        orch.register_stage(Box::new(FakeStage::new(PipelineStageId::MediaValidation)));

        let _ = orch.start().await;
        let state = orch.get_state().await;
        assert!(state.overall_progress > 0.0);
    }

    #[tokio::test]
    async fn test_cancel_before_start_keeps_pipeline_non_running() {
        let orch = PipelineOrchestrator::new(std::path::PathBuf::from("/test"));
        orch.cancel().await.unwrap();
        orch.start().await.unwrap();
        let state = orch.get_state().await;
        assert!(state.current_stage.is_none());
        assert!(orch.cancellation_token().is_cancelled());
    }
}
