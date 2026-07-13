use std::sync::Mutex;

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
}

pub struct AppState(pub Mutex<AppStateInner>);

impl AppState {
    pub fn new() -> Self {
        AppState(Mutex::new(AppStateInner {
            recent_projects: Vec::new(),
            project_dir: None,
        }))
    }
}
