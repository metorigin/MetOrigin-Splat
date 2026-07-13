use std::sync::{Arc, Mutex};

use splat_pipeline::PipelineOrchestrator;
use tokio::sync::watch;

/// Lightweight project info for the recent projects list.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Clone)]
pub struct ActivePipeline {
    pub project_dir: std::path::PathBuf,
    pub orchestrator: Arc<PipelineOrchestrator>,
    pub completion: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<AppStateInner>>);

impl AppState {
    pub fn new() -> Self {
        AppState(Arc::new(Mutex::new(AppStateInner {
            recent_projects: Vec::new(),
            project_dir: None,
            active_pipeline: None,
        })))
    }
}
