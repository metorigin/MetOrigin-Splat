use std::sync::Arc;
use std::time::{Duration, Instant};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EnginePaths;
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

mod invalidation;

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

/// Immutable settings shared by every stage in one pipeline run.
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub preset: String,
    pub engine_paths: EnginePaths,
    /// Frozen evidence and effective settings. None supports legacy projects
    /// and standalone stage tests; macOS training requires a verified profile.
    pub execution_profile: Option<Arc<splat_domain::ExecutionProfile>>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            preset: "balanced".to_string(),
            engine_paths: EnginePaths::default(),
            execution_profile: None,
        }
    }
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
    /// Preset and resolved engine paths for this run.
    config: PipelineConfig,
}

impl PipelineOrchestrator {
    /// Create a new pipeline orchestrator for a project.
    pub fn new(project_dir: std::path::PathBuf) -> Self {
        Self::new_with_config(project_dir, PipelineConfig::default())
    }

    pub fn new_with_config(project_dir: std::path::PathBuf, config: PipelineConfig) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            state: Arc::new(RwLock::new(PipelineState::new())),
            stages: Vec::new(),
            event_tx,
            project_dir,
            lock_guard: Arc::new(RwLock::new(None)),
            cancellation: CancellationToken::new(),
            config,
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
    /// 5. ColmapMatching       11. Export
    /// 6. ColmapMapping        12. PreviewGeneration
    pub fn new_default(project_dir: std::path::PathBuf) -> Self {
        Self::new_default_with_config(project_dir, PipelineConfig::default())
    }

    pub fn new_default_with_config(
        project_dir: std::path::PathBuf,
        config: PipelineConfig,
    ) -> Self {
        let preset = config.preset.clone();
        let mut orch = Self::new_with_config(project_dir, config);

        // Stage 1: Media validation
        orch.register_stage(Box::new(MediaValidationStage::new()));

        // Stage 2: Frame extraction
        orch.register_stage(Box::new(FrameExtractionStage::new(&preset)));

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
        orch.register_stage(Box::new(TrainingPreparationStage::new(&preset)));

        // Stage 9: Brush training
        orch.register_stage(Box::new(BrushTrainingStage::new(&preset)));

        // Stage 10: Model validation
        orch.register_stage(Box::new(ModelValidationStage::new()));

        // Stage 11: Publish the final PLY.
        orch.register_stage(Box::new(ExportStage::new()));

        // Stage 12: Write the manifest after scene.ply exists.
        orch.register_stage(Box::new(PreviewGenerationStage::new()));

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

        self.adopt_execution_lock(guard).await?;
        self.start_with_acquired_lock().await
    }

    /// Retain an admission lock acquired before any project state is changed.
    /// The supervisor keeps this receipt even when the worker is aborted.
    pub async fn adopt_execution_lock(&self, guard: LockGuard) -> AppResult<()> {
        let mut owned = self.lock_guard.write().await;
        if owned.is_some() || !guard.covers_project(&self.project_dir) {
            return Err(AppError::new(
                "E-9002",
                ErrorCategory::Internal,
                "Invalid Project Lock",
                "The pipeline admission lock is missing, already installed, or belongs to another project.",
            ));
        }
        *owned = Some(guard);
        Ok(())
    }

    /// Execute while retaining an already adopted lock through finalization.
    pub async fn start_with_acquired_lock(&self) -> AppResult<()> {
        if !self
            .lock_guard
            .read()
            .await
            .as_ref()
            .is_some_and(|guard| guard.covers_project(&self.project_dir))
        {
            return Err(AppError::new(
                "E-9002",
                ErrorCategory::Internal,
                "Missing Project Lock",
                "Pipeline execution requires its project admission lock.",
            ));
        }

        // Run the pipeline
        let result = self.start().await;

        // Release the lock on completion
        if !splat_process::ProcessScope::is_active() {
            self.release_execution_lock().await?;
        }

        result
    }

    /// A supervisor may release a lock after an aborted/panicked worker has
    /// joined and its owned engine processes have been cleaned up.
    pub async fn release_execution_lock(&self) -> AppResult<()> {
        let mut owned = self.lock_guard.write().await;
        if let Some(guard) = owned.as_mut() {
            guard.try_release().map_err(|error| {
                AppError::new(
                    "E-9002",
                    ErrorCategory::Internal,
                    "Project Lock Cleanup Failed",
                    "The project lock could not be released; cleanup remains pending.",
                )
                .with_technical(error.to_string())
            })?;
            *owned = None;
        }
        Ok(())
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

        // Every platform protects explicit existing evidence, including future
        // schemas. None only means a legacy project when no evidence exists.
        let previous = splat_project::load_execution_profile(&self.project_dir)?;
        let mut pending = invalidation::load(&self.project_dir)?;
        if let Some(profile) = &self.config.execution_profile {
            profile.validate_for_execution()?;
            let force_from = invalidation::earlier(
                crate::runtime::profile_invalidation_stage(previous.as_ref(), profile),
                pending.as_ref().map(|pending| pending.next_stage),
            );
            if let Some(first) = force_from {
                // Persist intent before changing the profile: cancellation or
                // an application restart must not turn old outputs into caches.
                pending = Some(invalidation::begin(
                    &self.project_dir,
                    profile,
                    first,
                    pending.as_ref(),
                )?);
            }
            splat_project::save_execution_profile(&self.project_dir, profile)?;
            if let Some(first) = force_from {
                self.invalidate_from(first).await;
            }
        } else if previous.is_some() || pending.is_some() {
            return Err(AppError::new(
                "E-1403",
                ErrorCategory::Environment,
                "Explicit Execution Profile Required",
                "This project contains an explicit runtime profile or pending rebuild. Run preflight with a compatible engine pack before continuing.",
            ));
        }

        // Execute stages in order
        for stage_reg in &self.stages {
            if self.cancellation.is_cancelled() {
                self.finish_cancelled().await?;
                return Ok(());
            }
            let sid = stage_reg.id();
            let mut force_execute = invalidation::requires_execution(pending.as_ref(), sid);

            // Build stage context
            let mut ctx = StageContext::with_configuration(
                sid,
                &self.project_dir,
                Some(self.config.preset.clone()),
                self.config.engine_paths.clone(),
                self.cancellation.clone(),
            );
            ctx.execution_profile = self.config.execution_profile.clone();

            // Check stage status from state
            let mut should_run = {
                let state = self.state.read().await;
                let should = state
                    .stages
                    .get(&sid)
                    .map(|s| s.status != StageStatus::Completed && s.status != StageStatus::Skipped)
                    .unwrap_or(true);
                should
            };

            // Completed project state alone cannot bypass current output contracts
            // or profile-aware caches. Changed frames invalidate every dependent stage.
            match self.config.execution_profile.as_ref() {
                Some(profile)
                    if !should_run
                        && matches!(
                            sid,
                            PipelineStageId::FrameExtraction
                                | PipelineStageId::ColmapFeatureExtraction
                                | PipelineStageId::ColmapMatching
                                | PipelineStageId::ColmapMapping
                                | PipelineStageId::TrainingPreparation
                                | PipelineStageId::BrushTraining
                        )
                        && !stage_reg.check_cached(&ctx)? =>
                {
                    pending = Some(invalidation::begin(
                        &self.project_dir,
                        profile,
                        sid,
                        pending.as_ref(),
                    )?);
                    self.invalidate_from(sid).await;
                    force_execute = true;
                    should_run = true;
                }
                _ => {}
            }
            if !should_run {
                continue;
            }

            // Check if this stage can be skipped (cached outputs exist)
            let cached = !force_execute && stage_reg.check_cached(&ctx).unwrap_or(false);
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
            let (progress_tx, mut progress_rx) = broadcast::channel::<TaskProgress>(64);
            let event_tx = self.event_tx.clone();
            let progress_state = self.state.clone();
            let progress_project_dir = self.project_dir.clone();
            let mut progress_forwarder = splat_process::spawn_scoped(async move {
                let mut last_persisted = Instant::now();
                while let Ok(progress) = progress_rx.recv().await {
                    let snapshot =
                        apply_stage_progress(&progress_state, sid, progress.percent).await;

                    if last_persisted.elapsed() >= Duration::from_secs(1) {
                        if let Err(error) = persist_state_snapshot(&progress_project_dir, &snapshot)
                        {
                            tracing::warn!(error = %error, "failed to persist throttled pipeline progress");
                        }
                        last_persisted = Instant::now();
                    }
                    let _ = event_tx.send(OrchestratorEvent::StageProgress(progress));
                }
            });
            let result = stage_reg.execute(&ctx, progress_tx).await;
            if tokio::time::timeout(Duration::from_millis(100), &mut progress_forwarder)
                .await
                .is_err()
            {
                progress_forwarder.abort();
            }

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
                    pending = invalidation::completed(&self.project_dir, pending, sid)?;
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
    async fn invalidate_from(&self, first: PipelineStageId) {
        let mut state = self.state.write().await;
        let mut affected = false;
        for id in PipelineStageId::all() {
            affected |= *id == first;
            if affected {
                state.stages.insert(*id, StageState::new(*id));
            }
        }
        state.current_stage = None;
        state.overall_progress = state.weighted_progress();
    }

    pub async fn get_state(&self) -> PipelineState {
        self.state.read().await.clone()
    }

    /// Subscribe to orchestrator events.
    pub fn subscribe(&self) -> broadcast::Receiver<OrchestratorEvent> {
        self.event_tx.subscribe()
    }

    /// Recompute overall pipeline progress.
    ///
    /// Progress uses the product-level phase weights defined by `PipelineState`.
    async fn update_overall_progress(&self) {
        let mut state = self.state.write().await;
        state.refresh_overall_progress();
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
            // StageState.error is a legacy persisted string. Keep its schema
            // stable, but never persist raw engine-facing English or technical
            // details into the default UI surface.
            stage.error = Some(error.localized_for_ui().to_string());
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
        persist_state_snapshot(&self.project_dir, &state)
    }
}

fn persist_state_snapshot(project_dir: &std::path::Path, state: &PipelineState) -> AppResult<()> {
    if !project_dir.join("project.json").exists() {
        return Ok(());
    }
    let projects_dir = project_dir.parent().unwrap_or(project_dir).to_path_buf();
    splat_project::ProjectManager::new(projects_dir).save_pipeline_state(project_dir, state)
}

async fn apply_stage_progress(
    state: &Arc<RwLock<PipelineState>>,
    stage_id: PipelineStageId,
    progress: f64,
) -> PipelineState {
    let mut state = state.write().await;
    if let Some(stage) = state.stages.get_mut(&stage_id) {
        stage.status = StageStatus::Running;
        stage.progress = progress.clamp(0.0, 1.0);
    }
    state.current_stage = Some(stage_id);
    state.refresh_overall_progress();
    state.clone()
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

    #[tokio::test]
    async fn adopted_lock_must_belong_to_project_and_span_execution() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let orchestrator = PipelineOrchestrator::new(project.path().to_owned());
        assert!(orchestrator.start_with_acquired_lock().await.is_err());
        let wrong = ProjectLock::try_lock(other.path(), "wrong").unwrap();
        assert!(orchestrator.adopt_execution_lock(wrong).await.is_err());
        let correct = ProjectLock::try_lock(project.path(), "admission").unwrap();
        orchestrator.adopt_execution_lock(correct).await.unwrap();
        assert!(ProjectLock::try_lock(project.path(), "other-app").is_err());
        let scope = splat_process::ProcessScope::default();
        scope
            .run(orchestrator.start_with_acquired_lock())
            .await
            .unwrap();
        assert!(ProjectLock::try_lock(project.path(), "other-app").is_err());
        orchestrator.release_execution_lock().await.unwrap();
        assert!(ProjectLock::try_lock(project.path(), "after-completion").is_ok());
    }

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

    struct ProfileStage {
        executions: Arc<std::sync::atomic::AtomicUsize>,
        expected_profile: splat_domain::ExecutionProfile,
    }

    struct JournalStage {
        id: PipelineStageId,
        calls: Arc<std::sync::Mutex<Vec<PipelineStageId>>>,
        cache_checks: Option<Arc<std::sync::Mutex<Vec<PipelineStageId>>>>,
        cached: bool,
        cancel: bool,
        invalid_output: bool,
    }

    #[async_trait::async_trait]
    impl PipelineStage for JournalStage {
        fn id(&self) -> PipelineStageId {
            self.id
        }
        fn validate_inputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }
        fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
            if let Some(checks) = &self.cache_checks {
                checks.lock().unwrap().push(self.id);
            }
            Ok(self.cached)
        }
        async fn execute(
            &self,
            ctx: &StageContext,
            _progress: broadcast::Sender<TaskProgress>,
        ) -> AppResult<StageState> {
            self.calls.lock().unwrap().push(self.id);
            if self.cancel {
                ctx.cancellation.cancel();
            }
            Ok(StageState::new(self.id))
        }
        fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
            if self.invalid_output {
                Err(AppError::new(
                    "E-9001",
                    ErrorCategory::Engine,
                    "Invalid Output",
                    "Injected output failure",
                ))
            } else {
                Ok(())
            }
        }
    }

    fn completed_state() -> PipelineState {
        let mut state = PipelineState::new();
        for stage in state.stages.values_mut() {
            stage.status = StageStatus::Completed;
            stage.progress = 1.0;
        }
        state
    }

    fn register_journal_stages(
        orchestrator: &mut PipelineOrchestrator,
        calls: &Arc<std::sync::Mutex<Vec<PipelineStageId>>>,
        cancel: Option<PipelineStageId>,
    ) {
        for id in PipelineStageId::all().iter().skip(1) {
            orchestrator.register_stage(Box::new(JournalStage {
                id: *id,
                calls: calls.clone(),
                cache_checks: None,
                cached: true,
                cancel: cancel == Some(*id),
                invalid_output: false,
            }));
        }
    }

    fn frame_cache_fixture(status: StageStatus) -> (tempfile::TempDir, PipelineConfig) {
        let root = tempfile::tempdir().unwrap();
        let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        splat_project::save_execution_profile(root.path(), &profile).unwrap();
        let mut project = splat_domain::Project::new("frame cache contract");
        project.pipeline_state = completed_state();
        project
            .pipeline_state
            .stages
            .get_mut(&PipelineStageId::FrameExtraction)
            .unwrap()
            .status = status;
        std::fs::create_dir(root.path().join("source")).unwrap();
        std::fs::write(root.path().join("source/original.mp4"), b"original source").unwrap();
        splat_project::ProjectManager::new(root.path().to_path_buf())
            .save_project(&project, root.path())
            .unwrap();
        (
            root,
            PipelineConfig {
                execution_profile: Some(Arc::new(profile)),
                ..PipelineConfig::default()
            },
        )
    }

    fn register_frame_cache_stages(
        orchestrator: &mut PipelineOrchestrator,
        calls: &Arc<std::sync::Mutex<Vec<PipelineStageId>>>,
        checks: &Arc<std::sync::Mutex<Vec<PipelineStageId>>>,
        frames_cached: bool,
        cancel: Option<PipelineStageId>,
    ) {
        for id in PipelineStageId::all() {
            orchestrator.register_stage(Box::new(JournalStage {
                id: *id,
                calls: calls.clone(),
                cache_checks: Some(checks.clone()),
                cached: *id != PipelineStageId::FrameExtraction || frames_cached,
                cancel: cancel == Some(*id),
                invalid_output: false,
            }));
        }
    }

    #[tokio::test]
    async fn completed_frame_cache_contract_invalidates_every_dependent_stage() {
        for status in [StageStatus::Completed, StageStatus::Skipped] {
            for existing_journal in [None, Some(PipelineStageId::ColmapFeatureExtraction)] {
                let (root, config) = frame_cache_fixture(status);
                let manager = splat_project::ProjectManager::new(root.path().to_path_buf());
                let original = manager.open_project(root.path()).unwrap();
                if let Some(first) = existing_journal {
                    invalidation::begin(
                        root.path(),
                        config.execution_profile.as_ref().unwrap(),
                        first,
                        None,
                    )
                    .unwrap();
                }
                let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
                let checks = Arc::new(std::sync::Mutex::new(Vec::new()));
                let mut orchestrator = PipelineOrchestrator::new_with_config(
                    root.path().to_path_buf(),
                    config.clone(),
                );
                register_frame_cache_stages(&mut orchestrator, &calls, &checks, false, None);
                orchestrator.initialize_from(original.pipeline_state).await;
                orchestrator
                    .start_with_lock("frame-contract")
                    .await
                    .unwrap();

                assert_eq!(*calls.lock().unwrap(), PipelineStageId::all()[1..]);
                // A stale frame cache cannot be followed by any downstream cache hit.
                assert_eq!(*checks.lock().unwrap(), [PipelineStageId::FrameExtraction]);
                assert!(invalidation::load(root.path()).unwrap().is_none());
                let saved = manager.open_project(root.path()).unwrap();
                assert!(saved
                    .pipeline_state
                    .stages
                    .values()
                    .all(|stage| stage.status == StageStatus::Completed));
                assert_eq!(saved.schema_version, 1);
                assert_eq!(saved.id, original.id);
                assert_eq!(
                    std::fs::read(root.path().join("source/original.mp4")).unwrap(),
                    b"original source"
                );
                assert_eq!(
                    splat_project::load_execution_profile(root.path())
                        .unwrap()
                        .as_ref(),
                    config.execution_profile.as_deref()
                );
            }
        }
    }

    #[tokio::test]
    async fn completed_frame_cache_invalidation_survives_cancel_and_disk_reload() {
        for cancel_at in [
            PipelineStageId::FrameExtraction,
            PipelineStageId::ImagePreprocessing,
        ] {
            let (root, config) = frame_cache_fixture(StageStatus::Completed);
            let manager = splat_project::ProjectManager::new(root.path().to_path_buf());
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let checks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut first =
                PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config.clone());
            register_frame_cache_stages(&mut first, &calls, &checks, false, Some(cancel_at));
            first
                .initialize_from(manager.open_project(root.path()).unwrap().pipeline_state)
                .await;
            first
                .start_with_lock("frame-contract-cancel")
                .await
                .unwrap();
            assert_eq!(
                invalidation::load(root.path()).unwrap().unwrap().next_stage,
                cancel_at
            );
            drop(first);

            // Simulate an application restart after the new frames are now cacheable.
            let mut resumed =
                PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config);
            register_frame_cache_stages(&mut resumed, &calls, &checks, true, None);
            resumed
                .initialize_from(manager.open_project(root.path()).unwrap().pipeline_state)
                .await;
            resumed
                .start_with_lock("frame-contract-resume")
                .await
                .unwrap();
            assert!(invalidation::load(root.path()).unwrap().is_none());
            let calls = calls.lock().unwrap();
            for id in PipelineStageId::all().iter().skip(1) {
                assert_eq!(
                    calls.iter().filter(|call| **call == *id).count(),
                    if *id == cancel_at { 2 } else { 1 },
                    "{id}"
                );
            }
            let saved = manager.open_project(root.path()).unwrap();
            assert!(saved
                .pipeline_state
                .stages
                .values()
                .all(|s| s.status == StageStatus::Completed));
            assert_eq!(saved.schema_version, 1);
        }
    }

    #[tokio::test]
    async fn completed_frame_cache_cannot_discharge_unadvanced_journal() {
        let (root, config) = frame_cache_fixture(StageStatus::Completed);
        let manager = splat_project::ProjectManager::new(root.path().to_path_buf());
        invalidation::begin(
            root.path(),
            config.execution_profile.as_ref().unwrap(),
            PipelineStageId::FrameExtraction,
            None,
        )
        .unwrap();
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let checks = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut orchestrator =
            PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config);
        register_frame_cache_stages(&mut orchestrator, &calls, &checks, true, None);
        orchestrator
            .initialize_from(manager.open_project(root.path()).unwrap().pipeline_state)
            .await;
        orchestrator
            .start_with_lock("frame-contract-crash-window")
            .await
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), PipelineStageId::all()[1..]);
        assert!(checks.lock().unwrap().is_empty());
        assert!(invalidation::load(root.path()).unwrap().is_none());
    }

    #[tokio::test]
    async fn completed_frame_cache_retains_valid_outputs() {
        let (root, config) = frame_cache_fixture(StageStatus::Completed);
        let manager = splat_project::ProjectManager::new(root.path().to_path_buf());
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let checks = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut orchestrator =
            PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config);
        register_frame_cache_stages(&mut orchestrator, &calls, &checks, true, None);
        orchestrator
            .initialize_from(manager.open_project(root.path()).unwrap().pipeline_state)
            .await;
        orchestrator
            .start_with_lock("frame-contract-valid")
            .await
            .unwrap();
        assert!(calls.lock().unwrap().is_empty());
        assert!(checks
            .lock()
            .unwrap()
            .contains(&PipelineStageId::FrameExtraction));
        assert!(invalidation::load(root.path()).unwrap().is_none());
    }

    #[tokio::test]
    async fn pending_invalidation_survives_cancellation_after_profile_save_and_ignores_old_caches()
    {
        for cancel_at in [
            PipelineStageId::FrameExtraction,
            PipelineStageId::ImagePreprocessing,
        ] {
            let root = tempfile::tempdir().unwrap();
            let previous = splat_domain::ExecutionProfile::from_json(include_bytes!(
                "../../../schemas/examples/execution-profile/macos.valid.json"
            ))
            .unwrap();
            splat_project::save_execution_profile(root.path(), &previous).unwrap();
            let mut current = previous.clone();
            current.engines.ffmpeg.binary_sha256 = "f".repeat(64);
            let config = PipelineConfig {
                execution_profile: Some(Arc::new(current.clone())),
                ..PipelineConfig::default()
            };
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut first =
                PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config.clone());
            register_journal_stages(&mut first, &calls, Some(cancel_at));
            first.initialize_from(completed_state()).await;
            first.start_with_lock("journal-cancel-test").await.unwrap();
            assert_eq!(
                splat_project::load_execution_profile(root.path()).unwrap(),
                Some(current.clone())
            );
            assert_eq!(
                invalidation::load(root.path()).unwrap().unwrap().next_stage,
                cancel_at
            );
            assert_eq!(
                crate::runtime::profile_invalidation_stage(Some(&current), &current),
                None
            );

            let mut resumed =
                PipelineOrchestrator::new_with_config(root.path().to_path_buf(), config);
            register_journal_stages(&mut resumed, &calls, None);
            resumed.initialize_from(first.get_state().await).await;
            resumed
                .start_with_lock("journal-resume-test")
                .await
                .unwrap();
            assert!(invalidation::load(root.path()).unwrap().is_none());
            let calls = calls.lock().unwrap();
            for id in PipelineStageId::all().iter().skip(1) {
                let expected = if *id == cancel_at { 2 } else { 1 };
                assert_eq!(
                    calls.iter().filter(|call| **call == *id).count(),
                    expected,
                    "{id}"
                );
            }
        }
    }

    #[tokio::test]
    async fn output_validation_failure_does_not_advance_pending_invalidation() {
        let root = tempfile::tempdir().unwrap();
        let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        splat_project::save_execution_profile(root.path(), &profile).unwrap();
        invalidation::begin(root.path(), &profile, PipelineStageId::Export, None).unwrap();
        let mut orchestrator = PipelineOrchestrator::new_with_config(
            root.path().to_path_buf(),
            PipelineConfig {
                execution_profile: Some(Arc::new(profile)),
                ..PipelineConfig::default()
            },
        );
        orchestrator.register_stage(Box::new(JournalStage {
            id: PipelineStageId::Export,
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            cache_checks: None,
            cached: true,
            cancel: false,
            invalid_output: true,
        }));
        orchestrator.initialize_from(completed_state()).await;
        assert!(orchestrator
            .start_with_lock("journal-failure-test")
            .await
            .is_err());
        assert_eq!(
            invalidation::load(root.path()).unwrap().unwrap().next_stage,
            PipelineStageId::Export
        );
    }

    #[tokio::test]
    async fn profile_save_failure_leaves_old_evidence_and_durable_pending_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let previous = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        splat_project::save_execution_profile(root.path(), &previous).unwrap();
        let mut next = previous.clone();
        next.effective_training.threads += 1;
        next.engine_pack_id = Some("x".repeat(70 * 1024));
        next.validate_for_execution().unwrap();
        let orchestrator = PipelineOrchestrator::new_with_config(
            root.path().to_path_buf(),
            PipelineConfig {
                execution_profile: Some(Arc::new(next)),
                ..PipelineConfig::default()
            },
        );
        orchestrator.initialize_from(completed_state()).await;
        assert_eq!(
            orchestrator
                .start_with_lock("journal-save-failure")
                .await
                .unwrap_err()
                .code,
            "E-1402"
        );
        assert_eq!(
            splat_project::load_execution_profile(root.path()).unwrap(),
            Some(previous)
        );
        assert_eq!(
            invalidation::load(root.path()).unwrap().unwrap().next_stage,
            PipelineStageId::ColmapFeatureExtraction
        );
        assert!(orchestrator
            .get_state()
            .await
            .stages
            .values()
            .all(|state| state.status == StageStatus::Completed));
    }

    #[tokio::test]
    async fn absent_current_profile_cannot_downgrade_explicit_or_unknown_saved_evidence() {
        let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        for bytes in [
            serde_json::to_vec(&profile).unwrap(),
            b"{\"schema_version\":2,\"new_contract\":true}".to_vec(),
            b"broken profile".to_vec(),
        ] {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("runtime")).unwrap();
            let path = splat_project::execution_profile_path(root.path());
            std::fs::write(&path, &bytes).unwrap();
            let orchestrator = PipelineOrchestrator::new(root.path().to_path_buf());
            assert!(orchestrator.start_with_lock("no-downgrade").await.is_err());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            assert!(!invalidation::path(root.path()).exists());
        }
        let root = tempfile::tempdir().unwrap();
        invalidation::begin(
            root.path(),
            &profile,
            PipelineStageId::FrameExtraction,
            None,
        )
        .unwrap();
        let orchestrator = PipelineOrchestrator::new(root.path().to_path_buf());
        assert_eq!(
            orchestrator
                .start_with_lock("pending-no-downgrade")
                .await
                .unwrap_err()
                .code,
            "E-1403"
        );
    }

    #[async_trait::async_trait]
    impl PipelineStage for ProfileStage {
        fn id(&self) -> PipelineStageId {
            PipelineStageId::TrainingPreparation
        }
        fn validate_inputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }
        fn check_cached(&self, _ctx: &StageContext) -> AppResult<bool> {
            Ok(true)
        }
        async fn execute(
            &self,
            ctx: &StageContext,
            _progress: broadcast::Sender<TaskProgress>,
        ) -> AppResult<StageState> {
            assert_eq!(
                ctx.execution_profile.as_deref(),
                Some(&self.expected_profile)
            );
            assert_eq!(
                splat_project::load_execution_profile(&ctx.project_dir)
                    .unwrap()
                    .as_ref(),
                Some(&self.expected_profile)
            );
            self.executions
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(StageState::new(self.id()))
        }
        fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn changed_profile_reexecutes_completed_stage_and_passes_frozen_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let previous = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        splat_project::save_execution_profile(root.path(), &previous).unwrap();
        let mut next = previous;
        next.engines.brush.binary_sha256 = "a".repeat(64);
        let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut orch = PipelineOrchestrator::new_with_config(
            root.path().to_path_buf(),
            PipelineConfig {
                execution_profile: Some(Arc::new(next.clone())),
                ..PipelineConfig::default()
            },
        );
        orch.register_stage(Box::new(ProfileStage {
            executions: executions.clone(),
            expected_profile: next,
        }));
        let mut completed = PipelineState::new();
        for stage in completed.stages.values_mut() {
            stage.status = StageStatus::Completed;
            stage.progress = 1.0;
        }
        orch.initialize_from(completed).await;
        orch.start_with_lock("profile-test").await.unwrap();
        assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unknown_probe_does_not_launch_or_replace_execution_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        splat_project::save_execution_profile(root.path(), &profile).unwrap();
        let before = std::fs::read(splat_project::execution_profile_path(root.path())).unwrap();
        profile.brush.probe_result.status = splat_domain::runtime::CapabilityStatus::Unknown;
        let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut orch = PipelineOrchestrator::new_with_config(
            root.path().to_path_buf(),
            PipelineConfig {
                execution_profile: Some(Arc::new(profile.clone())),
                ..PipelineConfig::default()
            },
        );
        orch.register_stage(Box::new(ProfileStage {
            executions: executions.clone(),
            expected_profile: profile,
        }));
        assert!(orch.start_with_lock("profile-test").await.is_err());
        assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read(splat_project::execution_profile_path(root.path())).unwrap(),
            before
        );
        assert!(matches!(
            ProjectLock::check(root.path()),
            crate::lock::LockStatus::Unlocked
        ));
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
        let error = state
            .stages
            .get(&PipelineStageId::MediaValidation)
            .and_then(|stage| stage.error.as_deref())
            .expect("failed stage should persist a safe user-facing error");
        assert!(error.contains("E-9999"));
        assert!(error.contains("应用内部"));
        assert!(!error.contains("Simulated stage failure"));
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
    async fn test_live_stage_progress_updates_weighted_snapshot() {
        let state = Arc::new(RwLock::new(PipelineState::new()));
        let state = apply_stage_progress(&state, PipelineStageId::FrameExtraction, 0.5).await;
        assert_eq!(
            state.stages[&PipelineStageId::FrameExtraction].status,
            StageStatus::Running
        );
        assert_eq!(state.current_stage, Some(PipelineStageId::FrameExtraction));
        assert!((state.overall_progress - (0.08 * 0.5 / 3.0)).abs() < 1e-9);
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
