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

use crate::state::{ActivePipeline, AppState, PipelineControlIntent};

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

/// Start a pipeline in a background task and return as soon as it is accepted.
#[tauri::command]
pub async fn start_pipeline(
    project_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PipelineSnapshot, String> {
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.join("project.json").exists() {
        return Err("项目文件不存在，请重新打开有效项目。".to_string());
    }

    let manager = project_manager_for(&project_dir);
    let mut project = manager
        .open_project(&project_dir)
        .map_err(|error| error.user_message_zh())?;
    if matches!(
        project.status,
        ProjectStatus::Running
            | ProjectStatus::Starting
            | ProjectStatus::Pausing
            | ProjectStatus::Cancelling
    ) {
        return Err("该项目仍处于活动状态，请先刷新状态或等待当前控制操作完成。".into());
    }

    let check_handle = app_handle.clone();
    let engine_checks = tokio::task::spawn_blocking(move || {
        crate::commands::system::check_engines_blocking(check_handle)
    })
    .await
    .map_err(|error| format!("引擎启动检查异常结束，请重试：{error}"))?;
    if let Some(blocker) = engine_check_blocker(&engine_checks) {
        return Err(blocker);
    }

    let gpu = tokio::task::spawn_blocking(splat_engine_brush::require_nvidia_smi)
        .await
        .map_err(|error| format!("NVIDIA 训练环境检查异常结束，请重试：{error}"))?
        .map_err(|error| format!("训练环境检查未通过：{}", error.user_message_zh()))?;
    tracing::info!(
        gpu = %gpu.gpu_name,
        driver = %gpu.driver_version,
        vram_bytes = gpu.memory_total_bytes,
        "NVIDIA training runtime preflight passed"
    );
    let config = PipelineConfig {
        preset: project.settings.preset.clone(),
        engine_paths: crate::commands::system::resolve_engine_paths(&app_handle),
    };
    let orchestrator = Arc::new(PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        config,
    ));
    let recovery = CrashRecovery::detect(&project.pipeline_state, &project_dir);
    orchestrator.initialize_from(recovery.state).await;
    let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);
    let accepted_at = Utc::now().to_rfc3339();
    let started_at = Arc::new(Mutex::new(None));
    let control_intent = Arc::new(Mutex::new(PipelineControlIntent::None));
    let sequence = Arc::new(AtomicU64::new(0));
    let abort_handle = Arc::new(Mutex::new(None));
    let project_id = project.id.to_string();

    let app_state = state.inner().clone();
    {
        let mut inner = app_state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        if let Some(active) = &inner.active_pipeline {
            let project_name = active
                .project_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("当前项目");
            return Err(format!(
                "项目“{project_name}”已有处理流程正在运行，请先等待完成或取消。"
            ));
        }
        inner.project_dir = Some(project_dir.clone());
        inner.active_pipeline = Some(ActivePipeline {
            project_id: project_id.clone(),
            project_dir: project_dir.clone(),
            orchestrator: orchestrator.clone(),
            completion: completion_rx,
            control_intent: control_intent.clone(),
            accepted_at: accepted_at.clone(),
            started_at: started_at.clone(),
            sequence: sequence.clone(),
            abort_handle: abort_handle.clone(),
        });
    }

    project.status = ProjectStatus::Starting;
    project.touch();
    manager
        .save_project(&project, &project_dir)
        .map_err(|error| error.user_message_zh())?;

    spawn_event_forwarder(
        orchestrator.subscribe(),
        app_handle.clone(),
        project_id.clone(),
        sequence.clone(),
        project_dir.clone(),
    );

    let run_orchestrator = orchestrator.clone();
    let task_project_id = project_id.clone();
    let task_project_dir = project_dir.clone();
    let task_handle = app_handle.clone();
    let join = tokio::spawn(async move {
        if let Ok(mut started) = started_at.lock() {
            *started = Some(Utc::now().to_rfc3339());
        }
        let task_manager = project_manager_for(&task_project_dir);
        if let Ok(mut persisted) = task_manager.open_project(&task_project_dir) {
            persisted.status = ProjectStatus::Running;
            persisted.touch();
            let _ = task_manager.save_project(&persisted, &task_project_dir);
        }
        let event_sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = task_handle.emit(
            "pipeline://state-changed",
            serde_json::json!({ "project_id": task_project_id, "sequence": event_sequence, "status": "running" }),
        );

        if let Err(error) = run_orchestrator.start_with_lock("pipeline").await {
            tracing::error!(error = %error, "pipeline execution failed");
        }
        apply_control_completion(&task_project_dir, &run_orchestrator, &control_intent).await;
        let _ = completion_tx.send(true);

        if let Ok(mut inner) = app_state.0.lock() {
            let should_clear = inner
                .active_pipeline
                .as_ref()
                .map(|active| Arc::ptr_eq(&active.orchestrator, &run_orchestrator))
                .unwrap_or(false);
            if should_clear {
                inner.active_pipeline = None;
            }
        }
    });
    if let Ok(mut handle) = abort_handle.lock() {
        *handle = Some(join.abort_handle());
    }

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

async fn control_pipeline(
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
            {
                let mut current_intent = active
                    .control_intent
                    .lock()
                    .map_err(|_| "处理流程控制状态不可用。".to_string())?;
                if *current_intent != PipelineControlIntent::None {
                    return Err("处理流程已有控制操作正在执行，请等待完成。".into());
                }
                *current_intent = intent;
            }
            persist_transient_status(
                &active.project_dir,
                if intent == PipelineControlIntent::Pause {
                    ProjectStatus::Pausing
                } else {
                    ProjectStatus::Cancelling
                },
            )?;
            active
                .orchestrator
                .cancel()
                .await
                .map_err(|error| error.user_message_zh())?;
            let mut completion = active.completion;
            if !*completion.borrow() && completion.changed().await.is_err() {
                if let Ok(handle) = active.abort_handle.lock() {
                    if let Some(handle) = handle.as_ref() {
                        handle.abort();
                    }
                }
                return Err("处理流程后台任务意外终止，请检查项目状态。".to_string());
            }
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
    let project_dir = PathBuf::from(&project_path);
    persist_transient_status(&project_dir, ProjectStatus::Recovering)?;
    start_pipeline(project_path, app_handle, state).await
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

async fn apply_control_completion(
    project_dir: &Path,
    orchestrator: &PipelineOrchestrator,
    intent: &Arc<Mutex<PipelineControlIntent>>,
) {
    let requested = intent
        .lock()
        .map(|intent| *intent)
        .unwrap_or(PipelineControlIntent::None);
    if requested == PipelineControlIntent::None {
        return;
    }
    let manager = project_manager_for(project_dir);
    let Ok(mut project) = manager.open_project(project_dir) else {
        return;
    };
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
    let _ = manager.save_project(&project, project_dir);
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
) {
    let log_retention_bytes = crate::commands::system::log_retention_bytes(&app_handle);
    tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
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
    });
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
    use super::engine_check_blocker;

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
}
