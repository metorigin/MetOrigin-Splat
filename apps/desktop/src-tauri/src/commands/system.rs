use crate::state::AppState;

/// Returns the application version from Cargo.toml.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Detects all engines and returns their availability status.
#[tauri::command]
pub fn check_engines() -> Vec<serde_json::Value> {
    let engines = [
        splat_engine_ffmpeg::FfmpegAdapter::detect(),
        splat_engine_colmap::ColmapAdapter::detect(),
        splat_engine_brush::BrushAdapter::detect(),
    ];

    engines
        .iter()
        .map(|info| {
            serde_json::json!({
                "name": info.name,
                "version": info.version,
                "path": info.path,
                "available": info.available,
            })
        })
        .collect()
}

/// Returns a list of recent projects from application state.
#[tauri::command]
pub fn get_app_state(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "recent_projects": inner.recent_projects,
    }))
}
