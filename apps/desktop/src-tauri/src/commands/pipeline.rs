use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use splat_domain::project::ProjectStatus;
use splat_domain::{PipelineStageId, PipelineState, StageStatus};
use splat_pipeline::orchestrator::OrchestratorEvent;
use splat_pipeline::{CrashRecovery, PipelineConfig, PipelineOrchestrator};
use splat_project::ProjectManager;
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::state::{ActivePipeline, AppState, PipelineControlIntent, PipelineFinalization};

#[derive(Debug, Clone, serde::Serialize)]
pub struct PipelineSnapshot {
    project_id: String,
    project_path: String,
    status: String,
    state: PipelineState,
    sequence: u64,
    accepted_at: Option<String>,
    started_at: Option<String>,
    control_intent: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PipelineControlResult {
    project_id: String,
    status: String,
    stopped: bool,
    preserved_checkpoint: Option<String>,
}

const ACTIVE_PIPELINE_CONFLICT_CODE: &str = "UI-PIPELINE-ACTIVE-CONFLICT";
const PIPELINE_STATE_UNAVAILABLE_CODE: &str = "UI-PIPELINE-STATE-UNAVAILABLE";

fn state_unavailable_error() -> String {
    serde_json::json!({
        "code": PIPELINE_STATE_UNAVAILABLE_CODE,
        "message": "处理流程状态暂时不可用，请重启应用后重试。"
    })
    .to_string()
}

fn active_conflict_error(active: &ActivePipeline) -> String {
    serde_json::json!({
        "code": ACTIVE_PIPELINE_CONFLICT_CODE,
        "message": "另一个项目正在运行，当前项目未启动且未进入队列。",
        "active_project_id": active.project_id
    })
    .to_string()
}

fn ensure_no_active_pipeline(state: &AppState) -> Result<(), String> {
    let inner = state.0.lock().map_err(|_| state_unavailable_error())?;
    if let Some(active) = &inner.active_pipeline {
        return Err(active_conflict_error(active));
    }
    Ok(())
}

/// Start a pipeline in a background task and return as soon as it is accepted.
#[tauri::command]
pub async fn start_pipeline(
    project_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    // This gate must stay before path access, engine/GPU preflight, or writes.
    // A second check immediately before installation closes concurrent-start races.
    ensure_no_active_pipeline(state.inner())?;
    let _pending_work = crate::lifecycle::PendingWork::begin(state.inner())?;
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.join("project.json").exists() {
        return Err("项目文件不存在，请重新打开有效项目。".to_string());
    }

    let manager = project_manager_for(&project_dir);
    let project_lock = super::recovery::acquire_project(&project_dir, "pipeline_admission")?;
    let mut project = super::recovery::recover_project(&manager, &project_dir, &project_lock)?;

    let check_handle = app_handle.clone();
    let engine_checks = tokio::task::spawn_blocking(move || {
        crate::commands::system::check_engines_blocking(check_handle)
    })
    .await
    .map_err(|error| format!("引擎启动检查异常结束，请重试：{error}"))?;
    if let Some(blocker) = engine_check_blocker(&engine_checks) {
        return Err(blocker);
    }

    let engine_paths = crate::commands::system::resolve_engine_paths(&app_handle);
    let runtime = crate::commands::runtime::check_training_runtime(&app_handle, &engine_paths)
        .await
        .map_err(|error| format!("训练环境检查未通过：{}", error.user_message_zh()))?;
    tracing::info!(runtime = %runtime.summary(), "training runtime preflight passed");
    let execution_profile = crate::commands::runtime::execution_profile(
        state.inner(),
        engine_paths.clone(),
        project.settings.preset.clone(),
        project.settings.max_long_edge,
        &runtime,
    )
    .await
    .map_err(|error| error.user_message_zh())?
    .map(Arc::new);
    let config = PipelineConfig {
        execution_profile,
        preset: project.settings.preset.clone(),
        engine_paths,
    };
    let orchestrator = Arc::new(PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        config,
    ));
    let recovery = CrashRecovery::detect(&project.pipeline_state, &project_dir);
    orchestrator.initialize_from(recovery.state).await;
    // Transfer the admission guard without an unlock gap. Starting/Running and
    // every engine invocation remain protected until supervised finalization.
    orchestrator
        .adopt_execution_lock(project_lock)
        .await
        .map_err(|error| error.user_message_zh())?;
    let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);
    let accepted_at = Utc::now().to_rfc3339();
    let started_at = Arc::new(Mutex::new(None));
    let control_intent = Arc::new(Mutex::new(PipelineControlIntent::None));
    let sequence = Arc::new(AtomicU64::new(0));
    let abort_handle = Arc::new(Mutex::new(None));
    let finalization = Arc::new(tokio::sync::Mutex::new(PipelineFinalization::Running));
    let process_scope = splat_process::ProcessScope::default();
    let event_forwarder = Arc::new(tokio::sync::Mutex::new(None));
    let project_id = project.id.to_string();

    let app_state = state.inner().clone();
    let prevent_idle_sleep = super::system::prevent_idle_sleep_enabled(&app_handle);
    {
        let mut inner = app_state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        if inner.shutting_down {
            return Err("应用正在安全退出，请等待当前操作完成。".into());
        }
        if let Some(active) = &inner.active_pipeline {
            return Err(active_conflict_error(active));
        }
        inner.project_dir = Some(project_dir.clone());
        inner.active_pipeline = Some(ActivePipeline {
            project_id: project_id.clone(),
            project_dir: project_dir.clone(),
            orchestrator: orchestrator.clone(),
            completion: completion_rx.clone(),
            control_intent: control_intent.clone(),
            accepted_at: accepted_at.clone(),
            started_at: started_at.clone(),
            sequence: sequence.clone(),
            abort_handle: abort_handle.clone(),
            finalization: finalization.clone(),
            process_scope: process_scope.clone(),
            event_forwarder: event_forwarder.clone(),
        });
    }

    project.status = ProjectStatus::Starting;
    project.touch();
    if let Err(error) = manager.save_project(&project, &project_dir) {
        clear_active_pipeline(&app_state, &orchestrator);
        return Err(error.user_message_zh());
    }

    *event_forwarder.try_lock().expect("new event receipt") = Some(spawn_event_forwarder(
        orchestrator.subscribe(),
        app_handle.clone(),
        project_id.clone(),
        sequence.clone(),
        project_dir.clone(),
        completion_rx,
    ));

    let run_orchestrator = orchestrator.clone();
    let task_project_id = project_id.clone();
    let task_project_dir = project_dir.clone();
    let task_handle = app_handle.clone();
    let worker_scope = process_scope.clone();
    let worker = tokio::spawn(async move {
        worker_scope.run(async move {
            if let Ok(mut started) = started_at.lock() {
                *started = Some(Utc::now().to_rfc3339());
            }
            let _activity = crate::macos_activity::MacosActivityGuard::acquire(prevent_idle_sleep)
                .map_err(|detail| splat_domain::AppError::new(
                    "E-1405", splat_domain::ErrorCategory::Environment,
                    "无法启用睡眠保护", "无法阻止系统空闲睡眠，请关闭训练睡眠保护选项后重试。",
                ).with_technical(detail))?;
            let task_manager = project_manager_for(&task_project_dir);
            let mut persisted = task_manager.open_project(&task_project_dir)?;
            persisted.status = ProjectStatus::Running;
            persisted.touch();
            task_manager.save_project(&persisted, &task_project_dir)?;
            let event_sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = task_handle.emit(
                "pipeline://state-changed",
                serde_json::json!({ "project_id": task_project_id, "sequence": event_sequence, "status": "running" }),
            );
            run_orchestrator.start_with_acquired_lock().await
        }).await
    });
    *abort_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(worker.abort_handle());
    // Only the worker can be aborted. Its independent supervisor always observes
    // JoinError and retains ownership until process cleanup and durable save pass.
    let active = app_state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .active_pipeline
        .clone()
        .expect("installed active pipeline");
    tokio::spawn(async move {
        if let Some(error) = supervise_worker(&app_state, &active, worker, completion_tx).await {
            let _ = app_handle.emit(
                "pipeline://failed",
                serde_json::json!({
                    "error": error
                }),
            );
            let event_sequence = active.sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app_handle.emit(
                "pipeline://event",
                serde_json::json!({
                    "project_id": active.project_id, "sequence": event_sequence,
                    "timestamp": Utc::now().to_rfc3339(), "event": { "kind": "pipeline_failed" },
                }),
            );
        }
    });

    Ok(PipelineSnapshot {
        project_id,
        project_path: project_dir.to_string_lossy().to_string(),
        status: "starting".into(),
        state: project.pipeline_state,
        sequence: 0,
        accepted_at: Some(accepted_at),
        started_at: None,
        control_intent: "none".into(),
    })
}

/// Cancel the active pipeline and wait until cancellation is acknowledged.
#[tauri::command]
pub async fn cancel_pipeline(state: tauri::State<'_, AppState>) -> Result<(), String> {
    control_pipeline(state.inner(), PipelineControlIntent::Cancel)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn pause_pipeline(
    state: tauri::State<'_, AppState>,
) -> Result<PipelineControlResult, String> {
    control_pipeline(state.inner(), PipelineControlIntent::Pause).await
}

pub(crate) async fn control_pipeline(
    state: &AppState,
    intent: PipelineControlIntent,
) -> Result<PipelineControlResult, String> {
    let active = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        inner.active_pipeline.clone()
    };

    match active {
        Some(active) => {
            // Serialize transient writes with final persistence. A worker may
            // finish between the initial snapshot and this control request.
            let finalization = active.finalization.lock().await;
            if matches!(*finalization, PipelineFinalization::Running) {
                let request_cancel = {
                    let mut current_intent = active
                        .control_intent
                        .lock()
                        .map_err(|_| "处理流程控制状态不可用。".to_string())?;
                    if *current_intent == PipelineControlIntent::None {
                        *current_intent = intent;
                        true
                    } else {
                        false
                    }
                };
                if request_cancel {
                    if let Err(error) = persist_transient_status(
                        &active.project_dir,
                        if intent == PipelineControlIntent::Pause {
                            ProjectStatus::Pausing
                        } else {
                            ProjectStatus::Cancelling
                        },
                    ) {
                        if let Ok(mut current) = active.control_intent.lock() {
                            *current = PipelineControlIntent::None;
                        }
                        return Err(error);
                    }
                    active
                        .orchestrator
                        .cancel()
                        .await
                        .map_err(|error| error.user_message_zh())?;
                }
            }
            drop(finalization);
            finish_active_pipeline(state, &active).await?;
            let project = project_manager_for(&active.project_dir)
                .open_project(&active.project_dir)
                .map_err(|error| error.user_message_zh())?;
            Ok(PipelineControlResult {
                project_id: active.project_id,
                status: project.status.to_string(),
                stopped: true,
                preserved_checkpoint: latest_checkpoint_relative(&active.project_dir),
            })
        }
        None => Err("当前没有正在运行的处理流程。".to_string()),
    }
}

#[tauri::command]
pub async fn resume_pipeline(
    project_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    // start_pipeline performs the authoritative early gate. Avoid persisting a
    // Recovering state before that gate, so an active project A cannot mutate B.
    start_pipeline(project_path, app_handle, state).await
}

async fn active_pipeline_summary(state: &AppState) -> Result<Option<PipelineSnapshot>, String> {
    let active = {
        let inner = state.0.lock().map_err(|_| state_unavailable_error())?;
        inner.active_pipeline.clone()
    };
    match active {
        Some(active) => {
            let pipeline_state = active.orchestrator.get_state().await;
            Ok(Some(snapshot_from_active(&active, pipeline_state)))
        }
        None => Ok(None),
    }
}

/// Return only the globally active pipeline. Unlike get_pipeline_state this
/// never falls back to the selected project's persisted snapshot.
#[tauri::command]
pub async fn get_active_pipeline_summary(
    state: tauri::State<'_, AppState>,
) -> Result<Option<PipelineSnapshot>, String> {
    active_pipeline_summary(state.inner()).await
}

/// Return the live pipeline state, or the last state persisted in project.json.
#[tauri::command]
pub async fn get_pipeline_state(
    project_path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    let requested_dir = project_path.map(PathBuf::from);
    let (active, project_dir) = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        (inner.active_pipeline.clone(), inner.project_dir.clone())
    };

    if let Some(active) = active {
        let targets_active = requested_dir
            .as_ref()
            .map(|requested| same_project_path(requested, &active.project_dir))
            .unwrap_or(true);
        if targets_active {
            let state_snapshot = active.orchestrator.get_state().await;
            return Ok(snapshot_from_active(&active, state_snapshot));
        }
    }

    let requested_dir = requested_dir.or(project_dir);
    if let Some(project_dir) = requested_dir {
        return project_manager_for(&project_dir)
            .open_project(&project_dir)
            .map(|project| PipelineSnapshot {
                project_id: project.id.to_string(),
                project_path: project_dir.to_string_lossy().to_string(),
                status: project.status.to_string(),
                state: project.pipeline_state,
                sequence: 0,
                accepted_at: None,
                started_at: None,
                control_intent: "none".into(),
            })
            .map_err(|error| error.user_message_zh());
    }

    Err("尚未选择项目。".into())
}

fn project_manager_for(project_dir: &Path) -> ProjectManager {
    ProjectManager::new(project_dir.parent().unwrap_or(project_dir).to_path_buf())
}

#[tauri::command]
pub fn retry_stage(
    project_path: String,
    stage_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    rerun_from_stage(project_path, stage_id, state)
}

#[tauri::command]
pub fn rerun_from_stage(
    project_path: String,
    stage_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    rerun_from_stage_inner(project_path, stage_id, state.inner())
}

pub(crate) fn rerun_from_stage_inner(
    project_path: String,
    stage_id: String,
    state: &AppState,
) -> Result<PipelineSnapshot, String> {
    {
        let inner = state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        if inner.active_pipeline.is_some() {
            return Err("运行中的项目不能重置阶段，请先暂停或取消。".into());
        }
    }
    let project_dir = PathBuf::from(&project_path);
    let manager = project_manager_for(&project_dir);
    let mut project = manager
        .open_project(&project_dir)
        .map_err(|error| error.user_message_zh())?;
    let selected = parse_stage_id(&stage_id).ok_or_else(|| "阶段标识无效。".to_string())?;
    let start_index = PipelineStageId::all()
        .iter()
        .position(|stage| *stage == selected)
        .ok_or_else(|| "阶段不在当前流水线中。".to_string())?;
    for stage in &PipelineStageId::all()[start_index..] {
        if let Some(stage_state) = project.pipeline_state.stages.get_mut(stage) {
            stage_state.status = StageStatus::Pending;
            stage_state.progress = 0.0;
            stage_state.started_at = None;
            stage_state.ended_at = None;
            stage_state.error = None;
            stage_state.retry_count = stage_state.retry_count.saturating_add(1);
        }
    }
    project.pipeline_state.current_stage = None;
    project.pipeline_state.refresh_overall_progress();
    project.current_stage = None;
    project.status = ProjectStatus::Ready;
    project.touch();
    manager
        .save_project(&project, &project_dir)
        .map_err(|error| error.user_message_zh())?;
    Ok(PipelineSnapshot {
        project_id: project.id.to_string(),
        project_path,
        status: project.status.to_string(),
        state: project.pipeline_state,
        sequence: 0,
        accepted_at: None,
        started_at: None,
        control_intent: "none".into(),
    })
}

#[tauri::command]
pub fn accept_colmap_quality_risk(
    project_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    {
        let inner = state
            .0
            .lock()
            .map_err(|_| "无法读取 Pipeline 状态，请重启应用后重试。".to_string())?;
        if inner.active_pipeline.is_some() {
            return Err("Pipeline 运行期间不能确认质量风险，请等待当前操作结束。".into());
        }
    }
    let project_dir = PathBuf::from(&project_path);
    splat_pipeline::colmap_quality::accept_colmap_quality_risk(&project_dir)
        .map_err(|error| error.user_message_zh())?;
    rerun_from_stage(
        project_path,
        format!("{:?}", PipelineStageId::ColmapValidation),
        state,
    )
}

fn parse_stage_id(value: &str) -> Option<PipelineStageId> {
    PipelineStageId::all()
        .iter()
        .copied()
        .find(|stage| format!("{stage:?}").eq_ignore_ascii_case(value))
}

fn same_project_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn persist_transient_status(project_dir: &Path, status: ProjectStatus) -> Result<(), String> {
    let manager = project_manager_for(project_dir);
    let mut project = manager
        .open_project(project_dir)
        .map_err(|error| error.user_message_zh())?;
    project.status = status;
    project.touch();
    manager
        .save_project(&project, project_dir)
        .map_err(|error| error.user_message_zh())
}

fn clear_active_pipeline(state: &AppState, orchestrator: &Arc<PipelineOrchestrator>) {
    if let Ok(mut inner) = state.0.lock() {
        if inner
            .active_pipeline
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.orchestrator, orchestrator))
        {
            inner.active_pipeline = None;
        }
    }
}

async fn supervise_worker(
    state: &AppState,
    active: &ActivePipeline,
    worker: tokio::task::JoinHandle<splat_domain::AppResult<()>>,
    completion: tokio::sync::watch::Sender<bool>,
) -> Option<String> {
    let outcome = worker.await.unwrap_or_else(|error| {
        Err(splat_domain::AppError::new(
            "E-9003",
            splat_domain::ErrorCategory::Internal,
            "Pipeline Worker Stopped",
            "The pipeline worker stopped unexpectedly; its engine processes are being cleaned up.",
        )
        .with_technical(error.to_string()))
    });
    if let Err(error) = &outcome {
        tracing::error!(%error, "pipeline worker failed");
        active.orchestrator.cancellation_token().cancel();
    }
    let failure = outcome.as_ref().err().map(|error| error.user_message_zh());
    *active.finalization.lock().await = PipelineFinalization::Pending(outcome);
    let _ = completion.send(true);
    if let Err(error) = finish_active_pipeline(state, active).await {
        tracing::error!(%error, "pipeline finalization remains pending for retry");
        return Some(error);
    }
    failure
}

/// Retryable, serialized finalization. A shutdown timeout may drop its waiter;
/// the supervisor and all cleanup receipts remain owned by ActivePipeline.
pub(crate) async fn finish_active_pipeline(
    state: &AppState,
    active: &ActivePipeline,
) -> Result<(), String> {
    let mut completion = active.completion.clone();
    while !*completion.borrow_and_update() {
        if completion.changed().await.is_err() {
            if let Some(worker) = active
                .abort_handle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
            {
                worker.abort();
            }
            return Err("后台监督任务意外终止，应用已保持打开。".to_string());
        }
    }
    let mut finalization = active.finalization.lock().await;
    match &*finalization {
        PipelineFinalization::Running => return Err("后台任务尚未结束。".into()),
        PipelineFinalization::Complete => return Ok(()),
        PipelineFinalization::Pending(_) => {}
    }
    active
        .process_scope
        .finish()
        .await
        .map_err(|error| error.user_message_zh())?;
    {
        let mut receipt = active.event_forwarder.lock().await;
        if let Some(task) = receipt.as_mut() {
            let outcome = task.await;
            *receipt = None;
            if let Err(error) = outcome {
                *finalization = PipelineFinalization::Pending(Err(splat_domain::AppError::new(
                    "E-9003",
                    splat_domain::ErrorCategory::Internal,
                    "Pipeline Event Writer Stopped",
                    "The pipeline event writer stopped unexpectedly.",
                )
                .with_technical(error.to_string())));
            }
        }
    }
    let PipelineFinalization::Pending(outcome) = &*finalization else {
        unreachable!()
    };
    match outcome {
        Err(error) => persist_background_failure(
            &active.project_dir,
            active.orchestrator.get_state().await,
            error,
        )
        .map_err(|error| error.user_message_zh())?,
        Ok(()) => {
            apply_control_completion(
                &active.project_dir,
                &active.orchestrator,
                &active.control_intent,
            )
            .await?
        }
    }
    let project = project_manager_for(&active.project_dir)
        .open_project(&active.project_dir)
        .map_err(|error| error.user_message_zh())?;
    if !matches!(
        project.status,
        ProjectStatus::Paused
            | ProjectStatus::Cancelled
            | ProjectStatus::Completed
            | ProjectStatus::Failed
    ) {
        return Err("任务停止状态尚未保存，应用已保持打开。请查看项目日志后重试退出。".into());
    }
    active
        .orchestrator
        .release_execution_lock()
        .await
        .map_err(|error| error.user_message_zh())?;
    *finalization = PipelineFinalization::Complete;
    clear_active_pipeline(state, &active.orchestrator);
    Ok(())
}

fn persist_background_failure(
    project_dir: &Path,
    mut snapshot: PipelineState,
    error: &splat_domain::AppError,
) -> splat_domain::AppResult<()> {
    let manager = project_manager_for(project_dir);
    let mut project = manager.open_project(project_dir)?;
    for stage in snapshot.stages.values_mut() {
        if stage.status.is_active() {
            stage.status = StageStatus::Failed;
            stage.error = Some(error.user_message_zh());
            stage.ended_at = Some(Utc::now());
        }
    }
    snapshot.current_stage = None;
    snapshot.refresh_overall_progress();
    project.status = ProjectStatus::Failed;
    project.current_stage = None;
    project.pipeline_state = snapshot;
    project.touch();
    manager.save_project(&project, project_dir)
}

async fn apply_control_completion(
    project_dir: &Path,
    orchestrator: &PipelineOrchestrator,
    intent: &Arc<Mutex<PipelineControlIntent>>,
) -> Result<(), String> {
    let requested = intent
        .lock()
        .map(|intent| *intent)
        .map_err(|_| "无法读取任务停止状态。".to_string())?;
    if requested == PipelineControlIntent::None {
        // Retry the final snapshot too: a previously failed save may have left
        // an older project document even though every stage has finished.
        return project_manager_for(project_dir)
            .save_pipeline_state(project_dir, &orchestrator.get_state().await)
            .map_err(|error| error.user_message_zh());
    }
    let manager = project_manager_for(project_dir);
    let mut project = manager
        .open_project(project_dir)
        .map_err(|error| error.user_message_zh())?;
    let mut state = orchestrator.get_state().await;
    if requested == PipelineControlIntent::Pause {
        for stage in state.stages.values_mut() {
            if stage.status == StageStatus::Cancelled {
                stage.status = StageStatus::Paused;
            }
        }
        project.status = ProjectStatus::Paused;
    } else {
        project.status = ProjectStatus::Cancelled;
    }
    state.current_stage = None;
    state.refresh_overall_progress();
    project.pipeline_state = state;
    project.current_stage = None;
    project.touch();
    manager
        .save_project(&project, project_dir)
        .map_err(|error| error.user_message_zh())
}

fn snapshot_from_active(active: &ActivePipeline, state: PipelineState) -> PipelineSnapshot {
    let control = active
        .control_intent
        .lock()
        .map(|intent| match *intent {
            PipelineControlIntent::None => "none",
            PipelineControlIntent::Pause => "pause",
            PipelineControlIntent::Cancel => "cancel",
        })
        .unwrap_or("none");
    let status = match control {
        "pause" => "pausing",
        "cancel" => "cancelling",
        _ => "running",
    };
    PipelineSnapshot {
        project_id: active.project_id.clone(),
        project_path: active.project_dir.to_string_lossy().to_string(),
        status: status.into(),
        state,
        sequence: active.sequence.load(Ordering::SeqCst),
        accepted_at: Some(active.accepted_at.clone()),
        started_at: active
            .started_at
            .lock()
            .ok()
            .and_then(|started| started.clone()),
        control_intent: control.into(),
    }
}

fn latest_checkpoint_relative(project_dir: &Path) -> Option<String> {
    splat_engine_brush::CheckpointScanner::find_latest(&project_dir.join("training/checkpoints"))
        .ok()
        .flatten()
        .and_then(|checkpoint| {
            checkpoint
                .path
                .strip_prefix(project_dir)
                .ok()
                .map(|path| path.to_string_lossy().replace('\\', "/"))
        })
}

fn spawn_event_forwarder(
    mut events: broadcast::Receiver<OrchestratorEvent>,
    app_handle: tauri::AppHandle,
    project_id: String,
    sequence: Arc<AtomicU64>,
    project_dir: PathBuf,
    mut worker_stopped: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    let log_retention_bytes = crate::commands::system::log_retention_bytes(&app_handle);
    tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                biased;
                event = events.recv() => event,
                _ = async {
                    while !*worker_stopped.borrow_and_update() {
                        if worker_stopped.changed().await.is_err() { break; }
                    }
                } => break,
            };
            let event = match next {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let event_sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let envelope = match &event {
                OrchestratorEvent::StageStarted(id) => {
                    serde_json::json!({ "kind": "stage_started", "stage_id": format!("{id:?}") })
                }
                OrchestratorEvent::StageCompleted(id) => {
                    serde_json::json!({ "kind": "stage_completed", "stage_id": format!("{id:?}") })
                }
                OrchestratorEvent::StageFailed(id, _) => {
                    serde_json::json!({ "kind": "stage_failed", "stage_id": format!("{id:?}") })
                }
                OrchestratorEvent::StageSkipped(id) => {
                    serde_json::json!({ "kind": "stage_skipped", "stage_id": format!("{id:?}") })
                }
                OrchestratorEvent::StageProgress(progress) => {
                    serde_json::json!({ "kind": "stage_progress", "stage_id": progress.stage_id, "progress": progress })
                }
                OrchestratorEvent::PipelineCompleted => {
                    serde_json::json!({ "kind": "pipeline_completed" })
                }
                OrchestratorEvent::PipelineFailed(_) => {
                    serde_json::json!({ "kind": "pipeline_failed" })
                }
                OrchestratorEvent::PipelineCancelled => {
                    serde_json::json!({ "kind": "pipeline_cancelled" })
                }
            };
            let (kind, severity, stage_id, user_message) = match &event {
                OrchestratorEvent::StageStarted(id) => (
                    "stage_started",
                    "info",
                    Some(format!("{id:?}")),
                    format!("开始{}。", id.label()),
                ),
                OrchestratorEvent::StageCompleted(id) => (
                    "stage_completed",
                    "info",
                    Some(format!("{id:?}")),
                    format!("{}已完成。", id.label()),
                ),
                OrchestratorEvent::StageFailed(id, _) => (
                    "stage_failed",
                    "error",
                    Some(format!("{id:?}")),
                    format!("{}失败，请查看详细日志。", id.label()),
                ),
                OrchestratorEvent::StageSkipped(id) => (
                    "stage_skipped",
                    "info",
                    Some(format!("{id:?}")),
                    format!("{}命中有效缓存，已跳过。", id.label()),
                ),
                OrchestratorEvent::StageProgress(progress) => (
                    "stage_progress",
                    "info",
                    Some(progress.stage_id.clone()),
                    progress.message.clone(),
                ),
                OrchestratorEvent::PipelineCompleted => (
                    "pipeline_completed",
                    "info",
                    None,
                    "处理流程已完成。".into(),
                ),
                OrchestratorEvent::PipelineFailed(_) => (
                    "pipeline_failed",
                    "error",
                    None,
                    "处理流程失败，请查看错误详情。".into(),
                ),
                OrchestratorEvent::PipelineCancelled => (
                    "pipeline_cancelled",
                    "warning",
                    None,
                    "处理流程已安全停止。".into(),
                ),
            };
            crate::commands::workspace::append_pipeline_event(
                &project_dir,
                &crate::commands::workspace::PipelineEventRecord {
                    event_id: format!("{}-{}", project_id, event_sequence),
                    project_id: project_id.clone(),
                    sequence: event_sequence,
                    timestamp: Utc::now().to_rfc3339(),
                    kind: kind.into(),
                    severity: severity.into(),
                    phase_id: stage_id
                        .as_deref()
                        .and_then(phase_for_stage)
                        .map(str::to_string),
                    stage_id,
                    user_message,
                    technical_message: None,
                    metrics: envelope.clone(),
                    source_log: None,
                },
                log_retention_bytes,
            );
            let _ = app_handle.emit(
                "pipeline://event",
                serde_json::json!({
                    "project_id": project_id,
                    "sequence": event_sequence,
                    "timestamp": Utc::now().to_rfc3339(),
                    "event": envelope,
                }),
            );
            let result = match event {
                OrchestratorEvent::StageStarted(id) => app_handle.emit(
                    "pipeline://stage-started",
                    serde_json::json!({ "stage_id": format!("{id:?}"), "label": id.label() }),
                ),
                OrchestratorEvent::StageCompleted(id) => app_handle.emit(
                    "pipeline://stage-completed",
                    serde_json::json!({ "stage_id": format!("{id:?}") }),
                ),
                OrchestratorEvent::StageFailed(id, _) => app_handle.emit(
                    "pipeline://stage-failed",
                    serde_json::json!({
                        "stage_id": format!("{id:?}"),
                        "error": "处理阶段失败，请查看日志了解详细信息。"
                    }),
                ),
                OrchestratorEvent::StageSkipped(id) => app_handle.emit(
                    "pipeline://stage-skipped",
                    serde_json::json!({ "stage_id": format!("{id:?}") }),
                ),
                OrchestratorEvent::StageProgress(progress) => {
                    app_handle.emit("pipeline://progress", progress)
                }
                OrchestratorEvent::PipelineCompleted => {
                    app_handle.emit("pipeline://completed", serde_json::json!({}))
                }
                OrchestratorEvent::PipelineFailed(_) => app_handle.emit(
                    "pipeline://failed",
                    serde_json::json!({
                        "error": "处理流程失败，请查看日志了解详细信息。"
                    }),
                ),
                OrchestratorEvent::PipelineCancelled => {
                    app_handle.emit("pipeline://cancelled", serde_json::json!({}))
                }
            };
            if let Err(error) = result {
                tracing::warn!(%error, "failed to emit pipeline event");
            }
        }
    })
}

fn engine_check_blocker(checks: &[serde_json::Value]) -> Option<String> {
    let failures = checks
        .iter()
        .filter(|check| check.get("available").and_then(serde_json::Value::as_bool) != Some(true))
        .map(|check| {
            let name = check
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("未知引擎");
            let diagnostic = check
                .get("diagnostic")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("启动、版本或完整性检查未通过。请重新安装或修复应用。");
            format!("{name}：{diagnostic}")
        })
        .collect::<Vec<_>>();
    (!failures.is_empty()).then(|| format!("引擎检查未通过：{}", failures.join("；")))
}

fn phase_for_stage(stage: &str) -> Option<&'static str> {
    match stage {
        "MediaValidation" | "FrameExtraction" | "ImagePreprocessing" => Some("media"),
        "ColmapFeatureExtraction" | "ColmapMatching" | "ColmapMapping" | "ColmapValidation" => {
            Some("camera")
        }
        "TrainingPreparation" | "BrushTraining" | "ModelValidation" => Some("training"),
        "Export" | "PreviewGeneration" => Some("export"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};

    use splat_pipeline::PipelineOrchestrator;

    use crate::state::{ActivePipeline, AppState, PipelineControlIntent};

    use super::{
        active_pipeline_summary, engine_check_blocker, ensure_no_active_pipeline,
        ACTIVE_PIPELINE_CONFLICT_CODE, PIPELINE_STATE_UNAVAILABLE_CODE,
    };

    fn install_active_pipeline(state: &AppState, project_id: &str) -> Arc<PipelineOrchestrator> {
        let project_dir = PathBuf::from(format!("C:/test/{project_id}"));
        let orchestrator = Arc::new(PipelineOrchestrator::new_default(project_dir.clone()));
        let (_completion_tx, completion) = tokio::sync::watch::channel(false);
        state.0.lock().unwrap().active_pipeline = Some(ActivePipeline {
            project_id: project_id.to_string(),
            project_dir,
            orchestrator: orchestrator.clone(),
            completion,
            control_intent: Arc::new(Mutex::new(PipelineControlIntent::None)),
            accepted_at: "2026-08-14T08:00:00Z".into(),
            started_at: Arc::new(Mutex::new(Some("2026-08-14T08:00:01Z".into()))),
            sequence: Arc::new(AtomicU64::new(7)),
            abort_handle: Arc::new(Mutex::new(None)),
            finalization: Arc::new(tokio::sync::Mutex::new(
                crate::state::PipelineFinalization::Running,
            )),
            process_scope: splat_process::ProcessScope::default(),
            event_forwarder: Arc::new(tokio::sync::Mutex::new(None)),
        });
        orchestrator
    }

    fn supervised_fixture(
        directory: PathBuf,
    ) -> (AppState, ActivePipeline, tokio::sync::watch::Sender<bool>) {
        let state = AppState::new();
        let (sender, completion) = tokio::sync::watch::channel(false);
        let active = ActivePipeline {
            project_id: "supervised".into(),
            orchestrator: Arc::new(PipelineOrchestrator::new(directory.clone())),
            project_dir: directory,
            completion,
            control_intent: Arc::new(Mutex::new(PipelineControlIntent::None)),
            accepted_at: "2026-08-14T08:00:00Z".into(),
            started_at: Arc::new(Mutex::new(None)),
            sequence: Arc::new(AtomicU64::new(0)),
            abort_handle: Arc::new(Mutex::new(None)),
            finalization: Arc::new(tokio::sync::Mutex::new(
                crate::state::PipelineFinalization::Running,
            )),
            process_scope: splat_process::ProcessScope::default(),
            event_forwarder: Arc::new(tokio::sync::Mutex::new(None)),
        };
        state.0.lock().unwrap().active_pipeline = Some(active.clone());
        (state, active, sender)
    }

    #[tokio::test]
    async fn opening_own_active_project_is_read_only_and_preserves_running_state() {
        let root = std::env::temp_dir().join(format!("splat-active-view-{}", uuid::Uuid::now_v7()));
        let manager = splat_project::ProjectManager::new(root.clone());
        let (mut project, directory) = manager.create_project("active-view").unwrap();
        project.status = splat_domain::ProjectStatus::Running;
        manager.save_project(&project, &directory).unwrap();
        let before = std::fs::read(directory.join("project.json")).unwrap();
        let (state, active, _) = supervised_fixture(directory.clone());
        let guard = splat_pipeline::ProjectLock::try_lock(&directory, "pipeline").unwrap();
        active
            .orchestrator
            .adopt_execution_lock(guard)
            .await
            .unwrap();
        let (opened, writer) =
            crate::commands::recovery::open_project_for_view(&manager, &state, &directory).unwrap();
        assert!(writer.is_none());
        assert_eq!(opened.status, splat_domain::ProjectStatus::Running);
        assert_eq!(
            std::fs::read(directory.join("project.json")).unwrap(),
            before
        );
        assert!(splat_pipeline::ProjectLock::try_lock(&directory, "other-app").is_err());
        // Another application cannot open this live project for recovery.
        assert!(crate::commands::recovery::open_project_for_view(
            &manager,
            &AppState::new(),
            &directory
        )
        .is_err());
        active.orchestrator.release_execution_lock().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn adopted_admission_lock_survives_worker_abort_until_supervisor_finalizes() {
        let root =
            std::env::temp_dir().join(format!("splat-adopted-lock-{}", uuid::Uuid::now_v7()));
        let manager = splat_project::ProjectManager::new(root.clone());
        let (mut project, directory) = manager.create_project("admission").unwrap();
        let (state, active, sender) = supervised_fixture(directory.clone());
        let guard =
            splat_pipeline::ProjectLock::try_lock(&directory, "pipeline_admission").unwrap();
        active
            .orchestrator
            .adopt_execution_lock(guard)
            .await
            .unwrap();
        project.status = splat_domain::ProjectStatus::Starting;
        manager.save_project(&project, &directory).unwrap();
        let worker = tokio::spawn(std::future::pending::<splat_domain::AppResult<()>>());
        worker.abort();
        assert!(splat_pipeline::ProjectLock::try_lock(&directory, "other-app").is_err());
        assert!(super::supervise_worker(&state, &active, worker, sender)
            .await
            .is_some());
        assert!(state.0.lock().unwrap().active_pipeline.is_none());
        assert_eq!(
            manager.open_project(&directory).unwrap().status,
            splat_domain::ProjectStatus::Failed
        );
        let guard =
            splat_pipeline::ProjectLock::try_lock(&directory, "after-finalization").unwrap();
        drop(guard);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn worker_panic_and_abort_are_durably_failed_and_release_the_run() {
        for abort in [false, true] {
            let root =
                std::env::temp_dir().join(format!("splat-supervised-{}", uuid::Uuid::now_v7()));
            let manager = splat_project::ProjectManager::new(root.clone());
            let (_, directory) = manager.create_project("supervised").unwrap();
            let (state, active, sender) = supervised_fixture(directory.clone());
            let orchestrator = active.orchestrator.clone();
            let scope = active.process_scope.clone();
            let (ready, started) = tokio::sync::oneshot::channel();
            let worker = tokio::spawn(async move {
                scope
                    .run(async move {
                        // An empty pipeline acquires and retains its supervised lock.
                        orchestrator.start_with_lock("supervision-test").await?;
                        ready.send(()).unwrap();
                        if abort {
                            std::future::pending::<()>().await;
                        }
                        panic!("injected pipeline worker panic");
                        #[allow(unreachable_code)]
                        Ok(())
                    })
                    .await
            });
            started.await.unwrap();
            assert!(directory.join(".lock").exists());
            if abort {
                worker.abort();
            }
            assert!(super::supervise_worker(&state, &active, worker, sender)
                .await
                .is_some());
            assert!(*active.completion.borrow());
            assert!(state.0.lock().unwrap().active_pipeline.is_none());
            assert_eq!(
                manager.open_project(&directory).unwrap().status,
                splat_domain::ProjectStatus::Failed
            );
            assert!(!directory.join(".lock").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn failed_final_save_blocks_repeated_exit_until_retry_succeeds() {
        let root = std::env::temp_dir().join(format!("splat-final-save-{}", uuid::Uuid::now_v7()));
        let manager = splat_project::ProjectManager::new(root.clone());
        let (_, directory) = manager.create_project("save-retry").unwrap();
        let (state, active, sender) = supervised_fixture(directory.clone());
        std::fs::rename(
            directory.join("project.json"),
            directory.join("project.saved.json"),
        )
        .unwrap();
        let worker = tokio::spawn(async {
            Err(splat_domain::AppError::new(
                "E-9003",
                splat_domain::ErrorCategory::Internal,
                "Injected failure",
                "Injected failure",
            ))
        });
        assert!(super::supervise_worker(&state, &active, worker, sender)
            .await
            .is_some());
        for _ in 0..2 {
            assert!(
                super::control_pipeline(&state, PipelineControlIntent::Pause)
                    .await
                    .is_err()
            );
            state.0.lock().unwrap().shutting_down = true;
            assert!(crate::lifecycle::validate_exit_complete(
                &state,
                &crate::commands::editor::EditorState::default()
            )
            .is_err());
            assert!(state.0.lock().unwrap().active_pipeline.is_some());
        }
        std::fs::rename(
            directory.join("project.saved.json"),
            directory.join("project.json"),
        )
        .unwrap();
        let result = super::control_pipeline(&state, PipelineControlIntent::Pause)
            .await
            .unwrap();
        assert!(result.stopped);
        assert_eq!(result.status, "failed");
        assert!(state.0.lock().unwrap().active_pipeline.is_none());
        crate::lifecycle::validate_exit_complete(
            &state,
            &crate::commands::editor::EditorState::default(),
        )
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn successful_control_is_durable_and_lock_cleanup_can_be_retried() {
        for intent in [PipelineControlIntent::Pause, PipelineControlIntent::Cancel] {
            let root =
                std::env::temp_dir().join(format!("splat-final-lock-{}", uuid::Uuid::now_v7()));
            let manager = splat_project::ProjectManager::new(root.clone());
            let (_, directory) = manager.create_project("lock-retry").unwrap();
            let (state, active, sender) = supervised_fixture(directory.clone());
            *active.control_intent.lock().unwrap() = intent;
            let scope = active.process_scope.clone();
            let orchestrator = active.orchestrator.clone();
            let project_dir = directory.clone();
            let worker = tokio::spawn(async move {
                scope
                    .run(async move {
                        orchestrator.start_with_lock("lock-retry").await?;
                        std::fs::rename(project_dir.join(".lock"), project_dir.join(".lock.saved"))
                            .unwrap();
                        std::fs::create_dir(project_dir.join(".lock")).unwrap();
                        Ok(())
                    })
                    .await
            });
            assert!(super::supervise_worker(&state, &active, worker, sender)
                .await
                .is_some());
            assert!(state.0.lock().unwrap().active_pipeline.is_some());
            assert_eq!(
                manager.open_project(&directory).unwrap().status,
                if intent == PipelineControlIntent::Pause {
                    splat_domain::ProjectStatus::Paused
                } else {
                    splat_domain::ProjectStatus::Cancelled
                }
            );
            std::fs::remove_dir(directory.join(".lock")).unwrap();
            std::fs::rename(directory.join(".lock.saved"), directory.join(".lock")).unwrap();
            super::finish_active_pipeline(&state, &active)
                .await
                .unwrap();
            assert!(state.0.lock().unwrap().active_pipeline.is_none());
            assert!(!directory.join(".lock").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn successful_snapshot_is_retried_after_restoring_an_older_project_file() {
        let root =
            std::env::temp_dir().join(format!("splat-complete-save-{}", uuid::Uuid::now_v7()));
        let manager = splat_project::ProjectManager::new(root.clone());
        let (_, directory) = manager.create_project("complete-retry").unwrap();
        let (state, active, sender) = supervised_fixture(directory.clone());
        let mut completed = splat_domain::PipelineState::new();
        for stage in completed.stages.values_mut() {
            stage.status = splat_domain::StageStatus::Completed;
            stage.progress = 1.0;
        }
        completed.refresh_overall_progress();
        active.orchestrator.initialize_from(completed).await;
        std::fs::rename(
            directory.join("project.json"),
            directory.join("project.saved.json"),
        )
        .unwrap();
        assert!(
            super::supervise_worker(&state, &active, tokio::spawn(async { Ok(()) }), sender)
                .await
                .is_some()
        );
        assert!(state.0.lock().unwrap().active_pipeline.is_some());
        std::fs::rename(
            directory.join("project.saved.json"),
            directory.join("project.json"),
        )
        .unwrap();
        let result = super::control_pipeline(&state, PipelineControlIntent::Pause)
            .await
            .unwrap();
        assert_eq!(result.status, "completed");
        assert!(state.0.lock().unwrap().active_pipeline.is_none());
        assert_eq!(
            manager.open_project(&directory).unwrap().status,
            splat_domain::ProjectStatus::Completed
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn engine_gate_accepts_only_fully_available_checks() {
        let checks = vec![
            serde_json::json!({ "name": "ffmpeg", "available": true }),
            serde_json::json!({ "name": "colmap", "available": true }),
            serde_json::json!({ "name": "brush", "available": true }),
        ];
        assert!(engine_check_blocker(&checks).is_none());
    }

    #[test]
    fn engine_gate_preserves_repair_diagnostics() {
        let checks = vec![serde_json::json!({
            "name": "brush",
            "available": false,
            "diagnostic": "内置引擎包校验失败，请重新安装或修复应用。"
        })];
        let blocker = engine_check_blocker(&checks).unwrap();
        assert!(blocker.contains("brush"));
        assert!(blocker.contains("重新安装或修复应用"));
    }

    #[tokio::test]
    async fn profile_startup_failure_clears_running_status_and_preserves_evidence() {
        for future_schema in [true, false] {
            let root = std::env::temp_dir()
                .join(format!("splat-runtime-failure-{}", uuid::Uuid::now_v7()));
            let manager = splat_project::ProjectManager::new(root.clone());
            let (mut project, directory) = manager.create_project("failure-test").unwrap();
            project.status = splat_domain::ProjectStatus::Running;
            manager.save_project(&project, &directory).unwrap();
            let evidence_path = if future_schema {
                std::fs::create_dir(directory.join("runtime")).unwrap();
                directory.join("runtime/execution-profile.json")
            } else {
                // A file where the runtime directory should be makes persistence
                // fail deterministically on Windows and macOS without chmod tricks.
                directory.join("runtime")
            };
            let evidence = if future_schema {
                b"{\"schema_version\":999}".as_slice()
            } else {
                b"preserve this file"
            };
            std::fs::write(&evidence_path, evidence).unwrap();
            let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
                "../../../../../schemas/examples/execution-profile/macos.valid.json"
            ))
            .unwrap();
            let orchestrator = splat_pipeline::PipelineOrchestrator::new_with_config(
                directory.clone(),
                splat_pipeline::PipelineConfig {
                    execution_profile: Some(Arc::new(profile)),
                    ..splat_pipeline::PipelineConfig::default()
                },
            );
            let error = orchestrator
                .start_with_lock("startup-failure-test")
                .await
                .unwrap_err();
            super::persist_background_failure(&directory, orchestrator.get_state().await, &error)
                .unwrap();
            let recovered = manager.open_project(&directory).unwrap();
            assert_eq!(recovered.status, splat_domain::ProjectStatus::Failed);
            assert!(recovered.current_stage.is_none());
            assert!(recovered.pipeline_state.current_stage.is_none());
            assert_eq!(std::fs::read(evidence_path).unwrap(), evidence);
            assert!(matches!(
                splat_pipeline::ProjectLock::check(&directory),
                splat_pipeline::LockStatus::Unlocked
            ));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_acceptance_only_clears_its_own_active_run() {
        let state = AppState::new();
        let first = install_active_pipeline(&state, "first");
        let second = install_active_pipeline(&state, "second");
        super::clear_active_pipeline(&state, &first);
        assert!(state.0.lock().unwrap().active_pipeline.is_some());
        super::clear_active_pipeline(&state, &second);
        assert!(state.0.lock().unwrap().active_pipeline.is_none());
    }

    #[tokio::test]
    async fn pause_completion_is_durable_and_missing_project_is_an_error() {
        let root = std::env::temp_dir().join(format!("splat-pause-state-{}", uuid::Uuid::now_v7()));
        let manager = splat_project::ProjectManager::new(root.clone());
        let (_, directory) = manager.create_project("pause-test").unwrap();
        let orchestrator = PipelineOrchestrator::new_default(directory.clone());
        let intent = Arc::new(Mutex::new(PipelineControlIntent::Pause));
        super::apply_control_completion(&directory, &orchestrator, &intent)
            .await
            .unwrap();
        assert_eq!(
            manager.open_project(&directory).unwrap().status,
            splat_domain::ProjectStatus::Paused
        );
        std::fs::rename(
            directory.join("project.json"),
            directory.join("project-preserved.json"),
        )
        .unwrap();
        assert!(
            super::apply_control_completion(&directory, &orchestrator, &intent)
                .await
                .is_err()
        );
        assert!(directory.join("project-preserved.json").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_control_persistence_releases_intent_for_retry() {
        let state = AppState::new();
        let orchestrator = install_active_pipeline(&state, "missing-for-control");
        assert!(
            super::control_pipeline(&state, PipelineControlIntent::Pause)
                .await
                .is_err()
        );
        let active = state.0.lock().unwrap().active_pipeline.clone().unwrap();
        assert_eq!(
            *active.control_intent.lock().unwrap(),
            PipelineControlIntent::None
        );
        assert!(!orchestrator.cancellation_token().is_cancelled());
    }

    #[tokio::test]
    async fn active_summary_is_null_without_an_active_pipeline() {
        let summary = active_pipeline_summary(&AppState::new()).await.unwrap();
        assert!(summary.is_none());
    }

    #[tokio::test]
    async fn active_summary_returns_the_live_pipeline_only() {
        let state = AppState::new();
        install_active_pipeline(&state, "project-a");

        let summary = active_pipeline_summary(&state).await.unwrap().unwrap();
        assert_eq!(summary.project_id, "project-a");
        assert_eq!(summary.sequence, 7);
        assert_eq!(summary.started_at.as_deref(), Some("2026-08-14T08:00:01Z"));
    }

    #[tokio::test]
    async fn active_summary_uses_a_stable_safe_lock_error() {
        let state = AppState::new();
        let shared = state.0.clone();
        let _ = std::thread::spawn(move || {
            let _guard = shared.lock().unwrap();
            panic!("poison test lock");
        })
        .join();

        let error = active_pipeline_summary(&state).await.unwrap_err();
        assert!(error.contains(PIPELINE_STATE_UNAVAILABLE_CODE));
        assert!(!error.contains("PoisonError"));
        assert!(!error.contains("C:\\"));
    }

    #[test]
    fn early_conflict_gate_preserves_a_and_does_not_queue_or_control_it() {
        let state = AppState::new();
        let orchestrator = install_active_pipeline(&state, "project-a");

        let error = ensure_no_active_pipeline(&state).unwrap_err();
        assert!(error.contains(ACTIVE_PIPELINE_CONFLICT_CODE));
        let inner = state.0.lock().unwrap();
        let active = inner.active_pipeline.as_ref().unwrap();
        assert!(Arc::ptr_eq(&active.orchestrator, &orchestrator));
        assert_eq!(
            *active.control_intent.lock().unwrap(),
            PipelineControlIntent::None
        );
    }

    #[test]
    fn source_contract_keeps_the_gate_before_preflight_and_resume_writes() {
        let source = include_str!("pipeline.rs");
        let start = source.split("pub async fn start_pipeline").nth(1).unwrap();
        let gate = start.find("ensure_no_active_pipeline").unwrap();
        assert!(gate < start.find("project.json").unwrap());
        assert!(gate < start.find("check_engines_blocking").unwrap());
        assert!(gate < start.find("check_training_runtime").unwrap());

        let resume = source.split("pub async fn resume_pipeline").nth(1).unwrap();
        let resume = resume
            .split("async fn active_pipeline_summary")
            .next()
            .unwrap();
        assert!(!resume.contains("persist_transient_status"));
    }
}
