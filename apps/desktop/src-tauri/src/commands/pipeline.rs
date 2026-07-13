use std::path::{Path, PathBuf};
use std::sync::Arc;

use splat_domain::PipelineState;
use splat_hardware::EngineLocator;
use splat_pipeline::orchestrator::OrchestratorEvent;
use splat_pipeline::{CrashRecovery, PipelineConfig, PipelineOrchestrator};
use splat_project::ProjectManager;
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

use crate::state::{ActivePipeline, AppState};

/// Start a pipeline in a background task and return as soon as it is accepted.
#[tauri::command]
pub async fn start_pipeline(
    project_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.join("project.json").exists() {
        return Err("项目文件不存在，请重新打开有效项目。".to_string());
    }

    let manager = project_manager_for(&project_dir);
    let project = manager
        .open_project(&project_dir)
        .map_err(|error| error.user_message_zh())?;
    let resource_engines = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("engines"));
    let config = PipelineConfig {
        preset: project.settings.preset.clone(),
        engine_paths: EngineLocator::resolve(resource_engines.as_deref()),
    };
    let orchestrator = Arc::new(PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        config,
    ));
    let recovery = CrashRecovery::detect(&project.pipeline_state, &project_dir);
    orchestrator.initialize_from(recovery.state).await;
    let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);

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
            project_dir: project_dir.clone(),
            orchestrator: orchestrator.clone(),
            completion: completion_rx,
        });
    }

    spawn_event_forwarder(orchestrator.subscribe(), app_handle.clone());

    let run_orchestrator = orchestrator.clone();
    tokio::spawn(async move {
        if let Err(error) = run_orchestrator.start_with_lock("pipeline").await {
            tracing::error!(error = %error, "pipeline execution failed");
        }
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

    Ok(())
}

/// Cancel the active pipeline and wait until cancellation is acknowledged.
#[tauri::command]
pub async fn cancel_pipeline(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let active = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        inner.active_pipeline.clone()
    };

    match active {
        Some(active) => {
            active
                .orchestrator
                .cancel()
                .await
                .map_err(|error| error.user_message_zh())?;
            let mut completion = active.completion;
            if !*completion.borrow() {
                completion
                    .changed()
                    .await
                    .map_err(|_| "处理流程后台任务意外终止，请检查项目状态。".to_string())?;
            }
            Ok(())
        }
        None => Err("当前没有正在运行的处理流程。".to_string()),
    }
}

/// Return the live pipeline state, or the last state persisted in project.json.
#[tauri::command]
pub async fn get_pipeline_state(
    state: tauri::State<'_, AppState>,
) -> Result<PipelineState, String> {
    let (active, project_dir) = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "处理流程状态不可用，请重启应用后重试。".to_string())?;
        (
            inner
                .active_pipeline
                .as_ref()
                .map(|active| active.orchestrator.clone()),
            inner.project_dir.clone(),
        )
    };

    if let Some(orchestrator) = active {
        return Ok(orchestrator.get_state().await);
    }

    if let Some(project_dir) = project_dir {
        return project_manager_for(&project_dir)
            .open_project(&project_dir)
            .map(|project| project.pipeline_state)
            .map_err(|error| error.user_message_zh());
    }

    Ok(PipelineState::new())
}

fn project_manager_for(project_dir: &Path) -> ProjectManager {
    ProjectManager::new(project_dir.parent().unwrap_or(project_dir).to_path_buf())
}

fn spawn_event_forwarder(
    mut events: broadcast::Receiver<OrchestratorEvent>,
    app_handle: tauri::AppHandle,
) {
    tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
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
