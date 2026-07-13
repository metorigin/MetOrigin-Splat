use crate::state::AppState;
use splat_domain::hardware::EngineInfo;
use splat_hardware::EngineLocator;
use tauri::Manager;

/// Returns the application version from Cargo.toml.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Detects all engines and returns their availability status.
#[tauri::command]
pub fn check_engines(app_handle: tauri::AppHandle) -> Vec<serde_json::Value> {
    let resource_engines = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("engines"));
    let paths = EngineLocator::resolve(resource_engines.as_deref());

    let ffmpeg = match (paths.ffmpeg, paths.ffprobe) {
        (Some(ffmpeg), Some(ffprobe)) => {
            splat_engine_ffmpeg::FfmpegAdapter::from_paths(ffmpeg, ffprobe)
                .map(|adapter| adapter.engine_info())
                .unwrap_or_else(|_| EngineInfo::new("ffmpeg"))
        }
        _ => EngineInfo::new("ffmpeg"),
    };
    let colmap = paths
        .colmap
        .and_then(|path| splat_engine_colmap::ColmapAdapter::from_path(path).ok())
        .map(|adapter| adapter.engine_info())
        .unwrap_or_else(|| EngineInfo::new("colmap"));
    let brush = paths
        .brush
        .and_then(|path| splat_engine_brush::BrushAdapter::from_path(path).ok())
        .map(|adapter| adapter.engine_info())
        .unwrap_or_else(|| EngineInfo::new("brush"));
    let engines = [ffmpeg, colmap, brush];

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
    let inner = state
        .0
        .lock()
        .map_err(|_| "读取应用状态失败，请重启应用后重试。".to_string())?;
    Ok(serde_json::json!({
        "recent_projects": inner.recent_projects,
    }))
}
