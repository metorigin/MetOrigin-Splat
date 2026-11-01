mod commands;
mod lifecycle;
mod macos_activity;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod state;

use state::AppState;
#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_debug_engine_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .manage(lifecycle::ExitState::default())
        .manage(commands::editor::EditorState::default())
        .invoke_handler(tauri::generate_handler![
            lifecycle::finish_app_exit,
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
            commands::workspace::get_project_thumbnail,
            commands::workspace::get_sparse_preview_pack,
            commands::workspace::inspect_ply,
            commands::preview::get_gaussian_preview,
            commands::preview::get_gaussian_camera,
            commands::preview::read_gaussian_ply,
            commands::preview::poll_live_preview,
            commands::preview::get_preview_resource_policy,
            commands::editor::open_model_editor,
            commands::editor::close_model_editor,
            commands::editor::save_edited_ply,
            commands::editor::save_editor_image,
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            lifecycle::install_native_exit_guard(_app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            macos_titlebar::install(_app.handle());
            #[cfg(debug_assertions)]
            {
                if std::env::var("METORIGIN_OPEN_DEVTOOLS").as_deref() == Ok("1") {
                    if let Some(window) = _app.get_webview_window("main") {
                        window.open_devtools();
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            lifecycle::handle_event(_app, _event);
        });
}

#[cfg(all(debug_assertions, target_os = "macos", target_arch = "aarch64"))]
fn configure_debug_engine_dir() {
    use splat_hardware::engine_layout::macos_development_search_roots;
    let explicit = std::env::var_os("METORIGIN_ENGINE_DIR");
    let current_directory = std::env::current_dir().ok();
    let executable = std::env::current_exe().ok();
    // This existing debug-only anchor also covers an external CARGO_TARGET_DIR
    // launched from an unrelated cwd. Release discovery never embeds it.
    let anchor = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let roots = macos_development_search_roots(current_directory.as_deref(), executable.as_deref());
    let selected = macos_default_debug_engine_dir(explicit.as_deref(), &anchor, &roots);
    match selected {
        Ok(Some(engine_dir)) => std::env::set_var("METORIGIN_ENGINE_DIR", engine_dir),
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(%error, "Cannot discover the configured macOS development engines")
        }
    }
}

#[cfg(any(
    all(debug_assertions, target_os = "macos", target_arch = "aarch64"),
    test
))]
fn macos_default_debug_engine_dir(
    explicit: Option<&std::ffi::OsStr>,
    anchor: &std::path::Path,
    roots: &[std::path::PathBuf],
) -> Result<Option<std::path::PathBuf>, splat_hardware::engine_layout::EngineLayoutError> {
    if explicit.is_some() {
        return Ok(None);
    }
    splat_hardware::engine_layout::macos_development_engine_dir_with_anchor(anchor, roots)
}

#[cfg(all(
    debug_assertions,
    not(target_os = "windows"),
    not(all(target_os = "macos", target_arch = "aarch64"))
))]
fn configure_debug_engine_dir() {
    if std::env::var_os("METORIGIN_ENGINE_DIR").is_some() {
        return;
    }
    let engine_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.engines");
    if engine_dir.is_dir() {
        std::env::set_var("METORIGIN_ENGINE_DIR", engine_dir);
    }
}

#[cfg(any(not(debug_assertions), target_os = "windows"))]
fn configure_debug_engine_dir() {}

#[cfg(test)]
mod macos_debug_discovery_tests {
    use super::macos_default_debug_engine_dir;

    #[test]
    fn explicit_environment_is_not_replaced_by_a_checkout_default() {
        let root = std::env::temp_dir().join(format!("mac-debug-{}", uuid::Uuid::now_v7()));
        let development = splat_hardware::engine_layout::macos_development_root(&root).unwrap();
        std::fs::create_dir_all(&development).unwrap();
        let roots = [root.clone()];
        assert_eq!(
            macos_default_debug_engine_dir(None, &root, &roots).unwrap(),
            Some(development)
        );
        assert!(macos_default_debug_engine_dir(
            Some(std::ffi::OsStr::new("user-selected-engine-directory")),
            &root,
            &roots
        )
        .unwrap()
        .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
