//! macOS window closing keeps work reachable through the Dock. Explicit quit
//! waits for the normal pause/cancel persistence and process-group cleanup.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Emitter;
use tauri::Manager;

use crate::commands::{editor::EditorState, pipeline};
use crate::state::{AppState, PipelineControlIntent};

#[cfg(target_os = "macos")]
mod native_exit;

#[cfg(target_os = "macos")]
pub(crate) fn install_native_exit_guard(app: &tauri::AppHandle) -> Result<(), String> {
    native_exit::install(app)
}

#[derive(Default)]
pub struct ExitState {
    allowed: AtomicBool,
}

/// Keep preflight/import commands alive until their engines and files finish.
/// Admission shares the same mutex as shutdown, closing the start/quit race.
pub(crate) struct PendingWork(AppState);

impl PendingWork {
    pub fn begin(state: &AppState) -> Result<Self, String> {
        let mut inner = state.0.lock().map_err(|_| "无法读取任务状态。")?;
        if inner.shutting_down {
            return Err("应用正在安全退出，请等待当前操作完成。".into());
        }
        inner.pending_work += 1;
        Ok(Self(state.clone()))
    }
}

impl Drop for PendingWork {
    fn drop(&mut self) {
        let mut inner = self
            .0
             .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.pending_work = inner.pending_work.saturating_sub(1);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show().and_then(|_| window.set_focus()) {
            tracing::warn!(%error, "Unable to restore the main window");
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn request_safe_exit(app: &tauri::AppHandle) {
    if app.state::<EditorState>().has_sessions() {
        show_main(app);
        if let Err(error) = app.emit("app-exit-requested", ()) {
            tracing::error!(%error, "Unable to ask the editor to finish before quitting");
        }
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = finish_exit(app.clone()).await {
                show_main(&app);
                let _ = app.emit("app-exit-failed", error);
            }
        });
    }
}

#[cfg(target_os = "windows")]
pub fn handle_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if app.state::<ExitState>().allowed.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            request_safe_exit(app);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            // Match the existing editor's first-close save/discard/cancel flow.
            // The next close drains engines and persisted state before exit.
            if !app.state::<EditorState>().has_sessions() {
                request_safe_exit(app);
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub fn handle_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if app.state::<ExitState>().allowed.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            request_safe_exit(app);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            // The editor's existing close listener offers save/discard/cancel.
            if !app.state::<EditorState>().has_sessions() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.hide() {
                        tracing::warn!(%error, "Unable to hide the main window");
                    }
                }
            }
        }
        tauri::RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    }
}

#[tauri::command]
pub async fn finish_app_exit(app: tauri::AppHandle) -> Result<(), String> {
    finish_exit(app).await
}

async fn finish_exit(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<EditorState>().has_sessions() {
        return Err("请先保存或放弃模型编辑，再退出应用。".into());
    }
    let state = app.state::<AppState>().inner().clone();
    if !begin_shutdown(&state)? {
        return Ok(());
    }
    let result = tokio::time::timeout(Duration::from_secs(30), stop_work(&state))
        .await
        .unwrap_or_else(|_| Err("任务尚未停止，应用已保持打开。请等待任务结束后再退出。".into()))
        .and_then(|()| validate_exit_complete(&state, &app.state::<EditorState>()));
    match result {
        Ok(()) => {
            app.state::<ExitState>()
                .allowed
                .store(true, Ordering::SeqCst);
            app.exit(0);
            Ok(())
        }
        Err(error) => {
            if let Ok(mut inner) = state.0.lock() {
                inner.shutting_down = false;
            }
            Err(error)
        }
    }
}

pub(crate) fn validate_exit_complete(
    state: &AppState,
    editors: &EditorState,
) -> Result<(), String> {
    {
        let inner = state.0.lock().map_err(|_| "无法读取任务状态。")?;
        if !inner.shutting_down
            || inner.pending_work != 0
            || inner.active_creation.is_some()
            || inner.active_pipeline.is_some()
        {
            return Err("后台操作尚未结束，应用已保持打开。".into());
        }
    }
    // An editor open may have passed its last gate immediately before shutdown
    // began. PendingWork drains it first; then this final check preserves it.
    if editors.has_sessions() {
        return Err("模型编辑器已打开，请先保存或放弃编辑后再退出。".into());
    }
    Ok(())
}

fn begin_shutdown(state: &AppState) -> Result<bool, String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "无法读取任务状态，应用已保持打开。")?;
    if inner.shutting_down {
        return Ok(false);
    }
    inner.shutting_down = true;
    if let Some(creation) = &inner.active_creation {
        creation.cancel.store(true, Ordering::SeqCst);
    }
    Ok(true)
}

async fn stop_work(state: &AppState) -> Result<(), String> {
    let active = state
        .0
        .lock()
        .map_err(|_| "无法读取任务状态。")?
        .active_pipeline
        .clone();
    if let Some(active) = active {
        let intent = *active
            .control_intent
            .lock()
            .map_err(|_| "无法读取任务控制状态。")?;
        if intent == PipelineControlIntent::None && !*active.completion.borrow() {
            pipeline::control_pipeline(state, PipelineControlIntent::Pause).await?;
        } else {
            pipeline::finish_active_pipeline(state, &active).await?;
        }
        // Completion must include durable state, not only process termination.
        let manager = splat_project::ProjectManager::new(
            active
                .project_dir
                .parent()
                .unwrap_or(&active.project_dir)
                .to_path_buf(),
        );
        let project = manager
            .open_project(&active.project_dir)
            .map_err(|error| error.user_message_zh())?;
        if !matches!(
            project.status,
            splat_domain::ProjectStatus::Paused
                | splat_domain::ProjectStatus::Cancelled
                | splat_domain::ProjectStatus::Completed
                | splat_domain::ProjectStatus::Failed
        ) {
            return Err("任务停止状态尚未保存，应用已保持打开。请查看项目日志后重试退出。".into());
        }
    }
    loop {
        let idle = {
            let inner = state.0.lock().map_err(|_| "无法读取项目创建状态。")?;
            inner.active_creation.is_none() && inner.pending_work == 0
        };
        if idle {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Probes/imports outside an accepted pipeline retain failed process cleanup
    // receipts. Drain them only after PendingWork has stopped producing handles.
    splat_process::ProcessScope::finish_pending_cleanup()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "Pending engine cleanup still prevents application exit");
            "引擎清理尚未完成，应用已保持打开。请稍后重试退出。".to_string()
        })?;
    Ok(())
}

#[cfg(test)]
async fn wait_for_completion(
    mut completion: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    loop {
        if *completion.borrow_and_update() {
            return Ok(());
        }
        completion
            .changed()
            .await
            .map_err(|_| "后台任务意外终止，应用已保持打开。请检查项目状态。")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_exit_requires_shutdown_and_no_pending_or_retained_run_owner() {
        use crate::state::{ActivePipeline, PipelineFinalization};
        use std::sync::atomic::AtomicU64;
        use std::sync::{Arc, Mutex};

        let state = AppState::new();
        let editors = EditorState::default();
        // A quiescent-looking state is insufficient until admission is closed.
        assert!(validate_exit_complete(&state, &editors).is_err());
        let pending = PendingWork::begin(&state).unwrap();
        begin_shutdown(&state).unwrap();
        assert!(validate_exit_complete(&state, &editors).is_err());
        assert!(PendingWork::begin(&state).is_err());
        drop(pending);
        validate_exit_complete(&state, &editors).unwrap();

        let cancellation = Arc::new(AtomicBool::new(false));
        state.0.lock().unwrap().active_creation = Some(crate::state::ActiveProjectCreation {
            id: "retained-creation".into(),
            cancel: cancellation,
        });
        assert!(validate_exit_complete(&state, &editors).is_err());
        state.0.lock().unwrap().active_creation = None;

        let directory = std::path::PathBuf::from("retained-finalization-owner");
        let (_completed, completion) = tokio::sync::watch::channel(true);
        state.0.lock().unwrap().active_pipeline = Some(ActivePipeline {
            project_id: "retained-run".into(),
            orchestrator: Arc::new(splat_pipeline::PipelineOrchestrator::new(directory.clone())),
            project_dir: directory,
            completion,
            control_intent: Arc::new(Mutex::new(PipelineControlIntent::Pause)),
            accepted_at: "2026-10-30T00:00:00Z".into(),
            started_at: Arc::new(Mutex::new(None)),
            sequence: Arc::new(AtomicU64::new(0)),
            abort_handle: Arc::new(Mutex::new(None)),
            // Even a completed finalization receipt is insufficient while the
            // application still retains the accepted run's ownership record.
            finalization: Arc::new(tokio::sync::Mutex::new(PipelineFinalization::Complete)),
            process_scope: splat_process::ProcessScope::default(),
            event_forwarder: Arc::new(tokio::sync::Mutex::new(None)),
        });
        assert!(validate_exit_complete(&state, &editors).is_err());
        state.0.lock().unwrap().active_pipeline = None;
        validate_exit_complete(&state, &editors).unwrap();
    }

    #[test]
    fn poisoned_state_cannot_authorize_exit_or_lose_pending_work_cleanup() {
        let state = AppState::new();
        let pending = PendingWork::begin(&state).unwrap();
        let poisoned = state.clone();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poisoned.0.lock().unwrap();
            panic!("injected lifecycle state poison");
        }));
        assert!(outcome.is_err());
        assert!(begin_shutdown(&state).is_err());
        assert!(PendingWork::begin(&state).is_err());
        assert!(validate_exit_complete(&state, &EditorState::default()).is_err());
        drop(pending);
        let recovered = state.0.lock().err().unwrap().into_inner();
        assert_eq!(recovered.pending_work, 0);
        assert!(!recovered.shutting_down);
    }

    #[tokio::test]
    async fn idle_shutdown_closes_gate_and_is_idempotent() {
        let state = AppState::new();
        assert!(begin_shutdown(&state).unwrap());
        assert!(!begin_shutdown(&state).unwrap());
        assert!(state.0.lock().unwrap().shutting_down);
        stop_work(&state).await.unwrap();
    }

    #[tokio::test]
    async fn creation_is_cancelled_and_exit_waits_for_cleanup() {
        let state = AppState::new();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        state.0.lock().unwrap().active_creation = Some(crate::state::ActiveProjectCreation {
            id: "creation".into(),
            cancel: cancel.clone(),
        });
        begin_shutdown(&state).unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), stop_work(&state))
                .await
                .is_err()
        );
        state.0.lock().unwrap().active_creation = None;
        stop_work(&state).await.unwrap();
    }

    #[tokio::test]
    async fn preflight_work_is_drained_and_new_work_is_rejected() {
        let state = AppState::new();
        let pending = PendingWork::begin(&state).unwrap();
        begin_shutdown(&state).unwrap();
        assert!(PendingWork::begin(&state).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), stop_work(&state))
                .await
                .is_err()
        );
        drop(pending);
        stop_work(&state).await.unwrap();
    }

    #[tokio::test]
    async fn completion_requires_true_and_does_not_accept_a_closed_channel() {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        assert!(tokio::time::timeout(
            Duration::from_millis(5),
            wait_for_completion(receiver.clone())
        )
        .await
        .is_err());
        sender.send(true).unwrap();
        wait_for_completion(receiver).await.unwrap();
        let (sender, receiver) = tokio::sync::watch::channel(false);
        drop(sender);
        assert!(wait_for_completion(receiver).await.is_err());
    }
}
