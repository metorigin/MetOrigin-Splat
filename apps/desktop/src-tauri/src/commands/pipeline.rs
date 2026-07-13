use std::path::PathBuf;
use std::sync::Arc;

use splat_pipeline::orchestrator::OrchestratorEvent;
use splat_pipeline::PipelineOrchestrator;
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::state::AppState;

/// Start a pipeline for the given project.
///
/// This spawns a background tokio task that runs the pipeline and emits
/// Tauri events to the frontend for real-time updates.
#[tauri::command]
pub async fn start_pipeline(
    project_path: String,
    app_handle: tauri::AppHandle,
    _state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let project_dir = PathBuf::from(&project_path);

    // Create the orchestrator
    let orch = Arc::new(PipelineOrchestrator::new_default(project_dir.clone()));

    // Subscribe to events
    let mut event_rx = orch.subscribe();
    let handle_clone = app_handle.clone();

    // Spawn event forwarding task
    tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    let _ = match &event {
                        OrchestratorEvent::StageStarted(id) => handle_clone.emit(
                            "pipeline://stage-started",
                            serde_json::json!({
                                "stage_id": format!("{:?}", id),
                                "label": id.label(),
                            }),
                        ),
                        OrchestratorEvent::StageCompleted(id) => handle_clone.emit(
                            "pipeline://stage-completed",
                            serde_json::json!({
                                "stage_id": format!("{:?}", id),
                            }),
                        ),
                        OrchestratorEvent::StageFailed(id, _error) => handle_clone.emit(
                            "pipeline://stage-failed",
                            serde_json::json!({
                                "stage_id": format!("{:?}", id),
                                "error": "处理阶段失败，请查看日志了解详细信息。",
                            }),
                        ),
                        OrchestratorEvent::StageSkipped(id) => handle_clone.emit(
                            "pipeline://stage-skipped",
                            serde_json::json!({
                                "stage_id": format!("{:?}", id),
                            }),
                        ),
                        OrchestratorEvent::StageProgress(progress) => handle_clone.emit(
                            "pipeline://progress",
                            serde_json::json!({
                                "stage_id": progress.stage_id,
                                "percent": progress.percent,
                                "message": progress.message,
                                "current_item": progress.current_item,
                                "total_items": progress.total_items,
                            }),
                        ),
                        OrchestratorEvent::PipelineCompleted => {
                            handle_clone.emit("pipeline://completed", serde_json::json!({}))
                        }
                        OrchestratorEvent::PipelineFailed(_error) => handle_clone.emit(
                            "pipeline://failed",
                            serde_json::json!({
                                "error": "处理流程失败，请查看日志了解详细信息。",
                            }),
                        ),
                        OrchestratorEvent::PipelineCancelled => {
                            handle_clone.emit("pipeline://cancelled", serde_json::json!({}))
                        }
                    };
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Run the pipeline
    // TODO: Use start_with_lock when lock is integrated
    let result = orch.start().await;

    match result {
        Ok(()) => {
            let _ = app_handle.emit("pipeline://completed", serde_json::json!({}));
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "pipeline execution failed");
            let user_message = e.user_message_zh();
            let _ = app_handle.emit(
                "pipeline://failed",
                serde_json::json!({
                    "error": user_message,
                }),
            );
            Err(e.user_message_zh())
        }
    }
}

/// Cancel the currently running pipeline.
#[tauri::command]
pub async fn cancel_pipeline() -> Result<(), String> {
    // TODO: retrieve the stored pipeline handle and cancel
    Ok(())
}

/// Get the current pipeline state.
#[tauri::command]
pub async fn get_pipeline_state() -> Result<serde_json::Value, String> {
    // TODO: retrieve from stored pipeline handle
    Ok(serde_json::json!({
        "stages": {},
        "current_stage": null,
        "overall_progress": 0.0,
    }))
}
