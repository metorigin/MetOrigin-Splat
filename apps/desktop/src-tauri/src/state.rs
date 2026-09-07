use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use splat_pipeline::PipelineOrchestrator;
use tokio::sync::watch;
use uuid::Uuid;

const ACTION_PREVIEW_TTL_MINUTES: i64 = 10;
const MAX_ACTION_PREVIEWS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceActionKind {
    Pause,
    Cancel,
    RerunStage,
    RestoreCheckpoint,
    DeleteCheckpoint,
    DeleteProject,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActionRequest {
    pub project_id: String,
    pub project_path: String,
    pub action: WorkspaceActionKind,
    pub stage_id: Option<String>,
    pub checkpoint_iteration: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ActionPreviewToken {
    pub token: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionPreviewRecord {
    pub request: WorkspaceActionRequest,
    pub fingerprint: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionTokenError {
    UnknownOrReplayed,
    Expired,
}

/// Lightweight project info for the recent projects list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub status: String,
    pub updated_at: String,
    pub stage_label: Option<String>,
}

/// Global application state accessible from Tauri commands.
pub struct AppStateInner {
    pub recent_projects: Vec<ProjectInfo>,
    pub project_dir: Option<std::path::PathBuf>,
    pub active_pipeline: Option<ActivePipeline>,
    pub active_creation: Option<ActiveProjectCreation>,
    action_previews: HashMap<String, ActionPreviewRecord>,
}

#[derive(Clone)]
pub struct ActiveProjectCreation {
    pub id: String,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct ActivePipeline {
    pub project_id: String,
    pub project_dir: std::path::PathBuf,
    pub orchestrator: Arc<PipelineOrchestrator>,
    pub completion: watch::Receiver<bool>,
    pub control_intent: Arc<Mutex<PipelineControlIntent>>,
    pub accepted_at: String,
    pub started_at: Arc<Mutex<Option<String>>>,
    pub sequence: Arc<AtomicU64>,
    pub abort_handle: Arc<Mutex<Option<tokio::task::AbortHandle>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineControlIntent {
    None,
    Pause,
    Cancel,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<AppStateInner>>, Arc<Mutex<()>>);

impl AppState {
    pub fn new() -> Self {
        AppState(
            Arc::new(Mutex::new(AppStateInner {
                recent_projects: Vec::new(),
                project_dir: None,
                active_pipeline: None,
                active_creation: None,
                action_previews: HashMap::new(),
            })),
            Arc::new(Mutex::new(())),
        )
    }

    pub(crate) fn recent_index_write_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.1
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn issue_action_preview(
        &self,
        request: WorkspaceActionRequest,
        fingerprint: String,
    ) -> Result<ActionPreviewToken, String> {
        self.issue_action_preview_at(request, fingerprint, Utc::now())
    }

    fn issue_action_preview_at(
        &self,
        request: WorkspaceActionRequest,
        fingerprint: String,
        now: DateTime<Utc>,
    ) -> Result<ActionPreviewToken, String> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "操作确认状态不可用，请重新打开确认窗口。".to_string())?;
        inner
            .action_previews
            .retain(|_, record| record.expires_at > now);
        if inner.action_previews.len() >= MAX_ACTION_PREVIEWS {
            if let Some(oldest) = inner
                .action_previews
                .iter()
                .min_by_key(|(_, record)| record.created_at)
                .map(|(token, _)| token.clone())
            {
                inner.action_previews.remove(&oldest);
            }
        }
        let token = Uuid::now_v7().to_string();
        let expires_at = now + Duration::minutes(ACTION_PREVIEW_TTL_MINUTES);
        inner.action_previews.insert(
            token.clone(),
            ActionPreviewRecord {
                request,
                fingerprint,
                created_at: now,
                expires_at,
            },
        );
        Ok(ActionPreviewToken {
            token,
            created_at: now,
            expires_at,
        })
    }

    pub fn consume_action_preview(
        &self,
        token: &str,
    ) -> Result<ActionPreviewRecord, ActionTokenError> {
        self.consume_action_preview_at(token, Utc::now())
    }

    fn consume_action_preview_at(
        &self,
        token: &str,
        now: DateTime<Utc>,
    ) -> Result<ActionPreviewRecord, ActionTokenError> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| ActionTokenError::UnknownOrReplayed)?;
        let record = inner
            .action_previews
            .remove(token)
            .ok_or(ActionTokenError::UnknownOrReplayed)?;
        if record.expires_at <= now {
            return Err(ActionTokenError::Expired);
        }
        Ok(record)
    }
}

#[cfg(test)]
mod action_preview_tests {
    use super::*;

    fn request() -> WorkspaceActionRequest {
        WorkspaceActionRequest {
            project_id: "project-a".into(),
            project_path: "project-a".into(),
            action: WorkspaceActionKind::Cancel,
            stage_id: None,
            checkpoint_iteration: None,
        }
    }

    #[test]
    fn preview_token_is_single_use_and_bound_to_its_record() {
        let state = AppState::new();
        let issued = state
            .issue_action_preview(request(), "fingerprint-a".into())
            .unwrap();
        let record = state.consume_action_preview(&issued.token).unwrap();
        assert_eq!(record.request.project_id, "project-a");
        assert_eq!(record.fingerprint, "fingerprint-a");
        assert_eq!(
            state.consume_action_preview(&issued.token),
            Err(ActionTokenError::UnknownOrReplayed)
        );
    }

    #[test]
    fn preview_token_expires_after_ten_minutes_without_leaking_a_record() {
        let state = AppState::new();
        let now = Utc::now();
        let issued = state
            .issue_action_preview_at(request(), "fingerprint".into(), now)
            .unwrap();
        assert_eq!(issued.expires_at, now + Duration::minutes(10));
        assert_eq!(
            state.consume_action_preview_at(&issued.token, now + Duration::minutes(10)),
            Err(ActionTokenError::Expired)
        );
        assert_eq!(
            state.consume_action_preview_at(&issued.token, now + Duration::minutes(9)),
            Err(ActionTokenError::UnknownOrReplayed)
        );
    }

    #[test]
    fn preview_registry_cleanup_stays_bounded() {
        let state = AppState::new();
        let now = Utc::now();
        for index in 0..(MAX_ACTION_PREVIEWS + 20) {
            state
                .issue_action_preview_at(
                    request(),
                    index.to_string(),
                    now + Duration::seconds(index as i64),
                )
                .unwrap();
        }
        let inner = state.0.lock().unwrap();
        assert!(inner.action_previews.len() <= MAX_ACTION_PREVIEWS);
    }
}
