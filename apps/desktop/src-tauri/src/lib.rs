mod commands;
mod state;

use state::AppState;
#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_debug_engine_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // System
            commands::system::app_version,
            commands::system::check_engines,
            commands::system::open_engine_location,
            commands::system::get_app_state,
            commands::system::get_app_settings,
            commands::system::save_app_settings,
            commands::system::set_engine_directory,
            commands::system::set_engine_executable,
            commands::system::clear_engine_override,
            commands::system::get_resource_metrics,
            commands::system::export_diagnostics,
            // Project
            commands::project::analyze_media,
            commands::project::get_image_previews,
            commands::project::preflight_project,
            commands::project::create_project,
            commands::project::cancel_project_creation,
            commands::project::open_project,
            commands::project::list_recent_projects,
            commands::project::list_recent_project_index,
            commands::project::check_recent_project_availability,
            commands::project::relink_recent_project,
            commands::project::remove_recent_project,
            commands::project::delete_project,
            commands::actions::preview_workspace_action,
            commands::actions::execute_workspace_action,
            // Pipeline
            commands::pipeline::start_pipeline,
            commands::pipeline::cancel_pipeline,
            commands::pipeline::pause_pipeline,
            commands::pipeline::resume_pipeline,
            commands::pipeline::get_pipeline_state,
            commands::pipeline::get_active_pipeline_summary,
            commands::pipeline::retry_stage,
            commands::pipeline::rerun_from_stage,
            commands::pipeline::accept_colmap_quality_risk,
            // Workspace data
            commands::workspace::get_pipeline_events,
            commands::workspace::read_stage_log,
            commands::workspace::list_checkpoints,
            commands::workspace::delete_checkpoint,
            commands::workspace::restore_checkpoint,
            commands::workspace::get_project_artifacts,
            commands::workspace::ensure_output_directory,
            commands::workspace::open_project_location,
            commands::workspace::get_frame_preview,
            commands::workspace::get_sparse_preview_pack,
            commands::workspace::inspect_ply,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(debug_assertions)]
fn configure_debug_engine_dir() {
    if std::env::var_os("METORIGIN_ENGINE_DIR").is_some() {
        return;
    }
    let engine_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.engines");
    if engine_dir.is_dir() {
        std::env::set_var("METORIGIN_ENGINE_DIR", engine_dir);
    }
}

#[cfg(not(debug_assertions))]
fn configure_debug_engine_dir() {}
