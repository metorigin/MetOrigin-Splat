mod commands;
mod state;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // System
            commands::system::app_version,
            commands::system::check_engines,
            commands::system::get_app_state,
            // Project
            commands::project::analyze_media,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::list_recent_projects,
            // Pipeline
            commands::pipeline::start_pipeline,
            commands::pipeline::cancel_pipeline,
            commands::pipeline::get_pipeline_state,
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
