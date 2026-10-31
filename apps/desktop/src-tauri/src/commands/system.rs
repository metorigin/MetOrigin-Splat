use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use splat_domain::hardware::{EngineInfo, EnginePaths};
use splat_hardware::{
    version_matches, EngineIntegrityCacheOptions, EngineLocator, EngineLocatorOptions,
    EnginePackSource, EnginePackStatus, EngineResolution, IntegrityStatus,
};
use splat_process::background_command;
use sysinfo::System;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

#[cfg(target_os = "macos")]
mod cpu;
pub(super) mod resources;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AppSettings {
    engine_directory: Option<String>,
    engine_executables: BTreeMap<String, String>,
    default_project_root: Option<String>,
    default_preset: String,
    create_and_start: bool,
    prevent_idle_sleep: bool,
    log_retention_mb: u64,
    thumbnail_cache_mb: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            engine_directory: None,
            engine_executables: BTreeMap::new(),
            default_project_root: None,
            default_preset: "fast".into(),
            create_and_start: true,
            prevent_idle_sleep: false,
            log_retention_mb: 512,
            thumbnail_cache_mb: 256,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GpuMetrics {
    name: String,
    driver_version: Option<String>,
    memory_total_bytes: Option<u64>,
    memory_used_bytes: Option<u64>,
    utilization_percent: Option<f64>,
    temperature_celsius: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ResourceMetrics {
    timestamp: String,
    operating_system: String,
    cpu_name: Option<String>,
    cpu_usage_percent: Option<f32>,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    project_disk_available_bytes: Option<u64>,
    disk_path: Option<String>,
    gpu: Option<GpuMetrics>,
    memory: resources::MemoryObservation,
    processes: Vec<resources::ProcessMemory>,
    runtime: Option<resources::RuntimeResourceSummary>,
    preview_policy: resources::PreviewResourcePolicy,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiagnosticExport {
    path: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenEngineLocationResult {
    opened: bool,
    engine_name: String,
}

/// Returns the application version from Cargo.toml.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn resolve_engine_paths(app_handle: &tauri::AppHandle) -> EnginePaths {
    resolve_engine_resolution(app_handle).paths
}

/// Resolve engine paths together with manifest provenance and integrity
/// diagnostics. Project preflight and startup checks share this exact result.
pub fn resolve_engine_resolution(app_handle: &tauri::AppHandle) -> EngineResolution {
    let settings = read_settings(app_handle).unwrap_or_default();
    let resource_base = app_handle.path().resource_dir().ok().or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(Path::to_path_buf))
    });
    #[cfg(not(debug_assertions))]
    let resource_engines = resource_base.map(|path| {
        let primary = path.join("resources").join("engines");
        let legacy = path.join("engines");
        if primary.is_dir() || !legacy.is_dir() {
            primary
        } else {
            legacy
        }
    });
    #[cfg(debug_assertions)]
    let resource_engines = resource_base
        .and_then(|path| {
            [path.join("resources").join("engines"), path.join("engines")]
                .into_iter()
                .find(|candidate| candidate.is_dir())
        })
        .or_else(local_engine_dir);

    let configured_executables = settings
        .engine_executables
        .into_iter()
        .map(|(name, value)| (name, PathBuf::from(value)))
        .collect();
    let integrity_cache =
        app_handle
            .path()
            .app_cache_dir()
            .ok()
            .map(|path| EngineIntegrityCacheOptions {
                path: path.join("engine-pack-integrity.json"),
                app_version: env!("CARGO_PKG_VERSION").into(),
            });
    let require_resource_manifest = cfg!(target_os = "windows")
        && resource_engines.as_ref().is_some_and(|path| {
            path.ends_with("target/distribution/windows-x64/engines")
                || path.ends_with("target/distribution/windows-x64-alignment/engines")
                || std::env::var_os("METORIGIN_PREPARED_ENGINE_DIR").is_some()
        });
    EngineLocator::resolve_detailed(EngineLocatorOptions {
        configured_dir: settings.engine_directory.map(PathBuf::from),
        configured_executables,
        resource_dir: resource_engines,
        integrity_cache,
        require_resource_manifest,
        ..EngineLocatorOptions::default()
    })
}

/// Finds a portable/developer `.engines` pack without embedding a machine
/// path into the application. This covers launching from the repository root
/// and launching `target/debug/splat-desktop.exe` directly.
#[cfg(all(debug_assertions, not(target_os = "windows")))]
fn local_engine_dir() -> Option<PathBuf> {
    let current_directory = std::env::current_dir()
        .ok()
        .map(|path| path.join(".engines"));
    if let Some(path) = current_directory.filter(|path| path.is_dir()) {
        return Some(path);
    }

    std::env::current_exe().ok().and_then(|executable| {
        executable
            .ancestors()
            .take(6)
            .map(|ancestor| ancestor.join(".engines"))
            .find(|path| path.is_dir())
    })
}

#[cfg(all(debug_assertions, target_os = "windows"))]
fn local_engine_dir() -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")];
    // A dev launcher hint is lower priority than saved overrides. It never
    // changes METORIGIN_ENGINE_DIR and never affects release discovery.
    if let Some(path) = std::env::var_os("METORIGIN_PREPARED_ENGINE_DIR") {
        return Some(PathBuf::from(path));
    }
    if let Ok(directory) = std::env::current_dir() {
        roots.push(directory);
    }
    if let Ok(executable) = std::env::current_exe() {
        roots.extend(
            executable
                .ancestors()
                .skip(1)
                .take(6)
                .map(Path::to_path_buf),
        );
    }
    windows_development_engine_dir(&roots)
}

#[cfg(any(all(debug_assertions, target_os = "windows"), test))]
fn windows_development_engine_dir(roots: &[PathBuf]) -> Option<PathBuf> {
    // All prepared candidates precede compatibility directories. Merely having
    // a directory selects it: a missing/damaged manifest must remain an error.
    for suffix in ["target/distribution/windows-x64/engines", ".engines"] {
        if let Some(path) = roots
            .iter()
            .map(|root| root.join(suffix))
            .find(|path| path.is_dir())
        {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod windows_discovery_tests {
    use super::*;

    #[test]
    fn prepared_pack_precedes_compatibility_directory_across_launch_roots() {
        let root = std::env::temp_dir().join(format!("windows-discovery-{}", uuid::Uuid::now_v7()));
        let checkout = root.join("checkout");
        let launch = root.join("other-cwd");
        let prepared = checkout.join("target/distribution/windows-x64/engines");
        std::fs::create_dir_all(&prepared).unwrap();
        std::fs::create_dir_all(launch.join(".engines")).unwrap();
        assert_eq!(
            windows_development_engine_dir(&[launch.clone(), checkout.clone()]),
            Some(prepared.clone())
        );
        std::fs::remove_dir(&prepared).unwrap();
        assert_eq!(
            windows_development_engine_dir(&[launch.clone(), checkout]),
            Some(launch.join(".engines"))
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Detects all engines and returns their availability status.
#[tauri::command]
pub async fn check_engines(app_handle: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || check_engines_blocking(app_handle))
        .await
        .map_err(|error| format!("Engine check worker terminated unexpectedly: {error}"))
}

/// Blocking implementation shared by startup, project preflight and pipeline
/// guards. Keep it off Tauri's command dispatcher because first launch hashes
/// the complete embedded engine pack.
pub(crate) fn check_engines_blocking(app_handle: tauri::AppHandle) -> Vec<serde_json::Value> {
    check_engines_with_resolution(app_handle.state::<AppState>().inner(), || {
        resolve_engine_resolution(&app_handle)
    })
}

fn check_engines_with_resolution(
    state: &AppState,
    resolve: impl FnOnce() -> EngineResolution,
) -> Vec<serde_json::Value> {
    // The blocking worker owns this receipt even when its IPC await is dropped.
    let _pending = match crate::lifecycle::PendingWork::begin(state) {
        Ok(pending) => pending,
        Err(error) => {
            return vec![
                serde_json::json!({"name": "runtime", "available": false, "diagnostic": error}),
            ]
        }
    };
    let resolution = resolve();
    let paths = &resolution.paths;

    let (mut ffmpeg, mut ffmpeg_diagnostic, ffprobe_version) = match (&paths.ffmpeg, &paths.ffprobe)
    {
        (Some(ffmpeg), Some(ffprobe)) => {
            match splat_engine_ffmpeg::FfmpegAdapter::from_paths(ffmpeg.clone(), ffprobe.clone()) {
                Ok(adapter) => (adapter.engine_info(), None, Some(adapter.ffprobe_version())),
                Err(error) => (
                    unavailable_engine("ffmpeg", Some(ffmpeg)),
                    Some(format!("FFmpeg 启动检查失败：{error}")),
                    None,
                ),
            }
        }
        _ => (
            unavailable_engine("ffmpeg", paths.ffmpeg.as_ref()),
            Some("FFmpeg 或 FFprobe 未定位。".into()),
            None,
        ),
    };
    if let Some(version) = ffprobe_version {
        match version {
            Ok(actual) if !actual.trim().is_empty() && actual != "unknown" => {
                if let Some(expected) = resolution
                    .status("ffprobe")
                    .and_then(|status| status.expected_version.as_deref())
                {
                    if !version_matches(expected, &actual) {
                        ffmpeg.available = false;
                        append_diagnostic(
                            &mut ffmpeg_diagnostic,
                            format!(
                                "FFprobe 版本不匹配：期望 {expected}，实际 {actual}。请重新安装或修复应用。"
                            ),
                        );
                    }
                }
            }
            Ok(_) => {
                ffmpeg.available = false;
                append_diagnostic(
                    &mut ffmpeg_diagnostic,
                    "FFprobe 未报告可识别的版本。请重新安装或修复应用。".into(),
                );
            }
            Err(error) => {
                ffmpeg.available = false;
                append_diagnostic(
                    &mut ffmpeg_diagnostic,
                    format!("FFprobe 启动检查失败：{error}"),
                );
            }
        }
    }

    let (colmap, colmap_diagnostic) = match paths.colmap.as_ref() {
        Some(path) => match splat_engine_colmap::ColmapAdapter::from_path(path.clone()) {
            Ok(adapter) => (adapter.engine_info(), None),
            Err(error) => (
                unavailable_engine("colmap", Some(path)),
                Some(format!("COLMAP 启动检查失败：{error}")),
            ),
        },
        None => (
            unavailable_engine("colmap", None),
            Some("COLMAP 未定位。".into()),
        ),
    };
    let (brush, brush_diagnostic) = match paths.brush.as_ref() {
        Some(path) => match splat_engine_brush::BrushAdapter::from_path(path.clone()) {
            Ok(adapter) => (adapter.engine_info(), None),
            Err(error) => (
                unavailable_engine("brush", Some(path)),
                Some(format!("Brush 启动检查失败：{error}")),
            ),
        },
        None => (
            unavailable_engine("brush", None),
            Some("Brush 未定位。".into()),
        ),
    };

    [
        (ffmpeg, resolution.status("ffmpeg"), ffmpeg_diagnostic),
        (colmap, resolution.status("colmap"), colmap_diagnostic),
        (brush, resolution.status("brush"), brush_diagnostic),
    ]
    .into_iter()
    .map(|(info, status, diagnostic)| engine_check_json(info, status, diagnostic))
    .collect()
}

#[tauri::command]
pub fn open_engine_location(
    app_handle: tauri::AppHandle,
    engine_name: String,
) -> Result<OpenEngineLocationResult, String> {
    let paths = resolve_engine_paths(&app_handle);
    let path = match engine_name.as_str() {
        "ffmpeg" => paths.ffmpeg,
        "ffprobe" => paths.ffprobe,
        "colmap" => paths.colmap,
        "brush" => paths.brush,
        _ => return Err("未知的引擎名称。".into()),
    }
    .ok_or_else(|| "该引擎尚未定位。".to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "引擎文件已移动或删除，请重新检测。".to_string())?;
    if !canonical.is_file() {
        return Err("定位结果不是有效的引擎可执行文件。".into());
    }
    app_handle
        .opener()
        .reveal_item_in_dir(&canonical)
        .map_err(|error| format!("无法在资源管理器中定位引擎：{error}"))?;
    Ok(OpenEngineLocationResult {
        opened: true,
        engine_name,
    })
}

#[tauri::command]
pub fn get_app_settings(app_handle: tauri::AppHandle) -> Result<AppSettings, String> {
    read_settings(&app_handle)
}

#[tauri::command]
pub fn save_app_settings(
    app_handle: tauri::AppHandle,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.log_retention_mb = settings.log_retention_mb.clamp(64, 4096);
    settings.thumbnail_cache_mb = settings.thumbnail_cache_mb.clamp(64, 4096);
    write_settings(&app_handle, &settings)?;
    Ok(settings)
}

/// Capture this opt-in once when accepting a run; never enable it on a read error.
pub(crate) fn prevent_idle_sleep_enabled(app_handle: &tauri::AppHandle) -> bool {
    match read_settings(app_handle) {
        Ok(settings) => settings.prevent_idle_sleep,
        Err(error) => {
            tracing::warn!(%error, "idle-sleep setting unavailable; leaving system sleep unchanged");
            false
        }
    }
}

pub fn log_retention_bytes(app_handle: &tauri::AppHandle) -> u64 {
    read_settings(app_handle)
        .unwrap_or_default()
        .log_retention_mb
        .clamp(64, 4096)
        .saturating_mul(1024 * 1024)
}

#[tauri::command]
pub fn set_engine_directory(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<AppSettings, String> {
    if !Path::new(&path).is_dir() {
        return Err("所选引擎目录不存在。".into());
    }
    let mut settings = read_settings(&app_handle)?;
    settings.engine_directory = Some(path);
    write_settings(&app_handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn set_engine_executable(
    app_handle: tauri::AppHandle,
    name: String,
    path: String,
) -> Result<AppSettings, String> {
    if !Path::new(&path).is_file() {
        return Err("所选引擎可执行文件不存在。".into());
    }
    if !matches!(name.as_str(), "ffmpeg" | "ffprobe" | "colmap" | "brush") {
        return Err("未知引擎名称。".into());
    }
    let mut settings = read_settings(&app_handle)?;
    settings
        .engine_executables
        .insert(name.clone(), path.clone());
    if name == "ffmpeg" {
        let executable_name = if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        };
        let ffprobe = Path::new(&path).with_file_name(executable_name);
        if ffprobe.is_file() {
            settings
                .engine_executables
                .insert("ffprobe".into(), ffprobe.to_string_lossy().to_string());
        }
    }
    write_settings(&app_handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn clear_engine_override(
    app_handle: tauri::AppHandle,
    name: Option<String>,
) -> Result<AppSettings, String> {
    let mut settings = read_settings(&app_handle)?;
    if let Some(name) = name {
        settings.engine_executables.remove(&name);
    } else {
        settings.engine_directory = None;
        settings.engine_executables.clear();
    }
    write_settings(&app_handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn get_resource_metrics(project_path: Option<String>) -> ResourceMetrics {
    collect_resource_metrics(project_path.as_deref().map(Path::new))
}

#[tauri::command]
pub fn export_diagnostics(
    project_path: String,
    app_handle: tauri::AppHandle,
) -> Result<DiagnosticExport, String> {
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.join("project.json").is_file() {
        return Err("项目路径无效。".into());
    }
    let output_dir = project_dir.join("output");
    std::fs::create_dir_all(&output_dir).map_err(|_| "创建诊断输出目录失败。".to_string())?;
    let output = output_dir.join(format!(
        "diagnostics-{}.zip",
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let file = File::create(&output).map_err(|_| "创建诊断包失败。".to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let settings = read_settings(&app_handle).unwrap_or_default();
    let engine_root = settings.engine_directory.as_deref().map(Path::new);
    let home = dirs_next::home_dir();
    let redact = |content: String| redact_text(content, &project_dir, engine_root, home.as_deref());

    if let Ok(project_json) = std::fs::read_to_string(project_dir.join("project.json")) {
        if let Some(sanitized) = sanitize_json_document(&project_json, &redact, true) {
            zip.start_file("project-summary.json", options)
                .map_err(|_| "写入诊断包失败。".to_string())?;
            zip.write_all(sanitized.as_bytes())
                .map_err(|_| "写入诊断包失败。".to_string())?;
        }
    }
    if let Ok(events) = tail_file(&project_dir.join("logs/events.jsonl"), 512 * 1024) {
        zip.start_file("events-tail.jsonl", options)
            .map_err(|_| "写入诊断包失败。".to_string())?;
        zip.write_all(sanitize_event_tail(&events, &redact).as_bytes())
            .map_err(|_| "写入诊断包失败。".to_string())?;
    }
    let metrics = collect_resource_metrics(Some(&project_dir));
    zip.start_file("system.json", options)
        .map_err(|_| "写入诊断包失败。".to_string())?;
    zip.write_all(serialize_diagnostic_system_metrics(&metrics, &redact).as_bytes())
        .map_err(|_| "写入诊断包失败。".to_string())?;
    let engines = check_engines_blocking(app_handle);
    zip.start_file("engines.json", options)
        .map_err(|_| "写入诊断包失败。".to_string())?;
    let engine_json = serde_json::to_string_pretty(&engines).unwrap_or_default();
    let sanitized_engines =
        sanitize_json_document(&engine_json, &redact, false).unwrap_or_else(|| "[]".to_string());
    zip.write_all(sanitized_engines.as_bytes())
        .map_err(|_| "写入诊断包失败。".to_string())?;
    zip.finish().map_err(|_| "完成诊断包失败。".to_string())?;
    Ok(DiagnosticExport {
        path: output.to_string_lossy().to_string(),
        size_bytes: std::fs::metadata(&output)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    })
}

/// Returns a list of recent projects from application state.
#[tauri::command]
pub fn get_app_state(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let inner = state
        .0
        .lock()
        .map_err(|_| "读取应用状态失败，请重启应用后重试。".to_string())?;
    Ok(serde_json::json!({ "recent_projects": inner.recent_projects }))
}

fn settings_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_config_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|_| "无法定位应用设置目录。".to_string())
}

fn read_settings(app_handle: &tauri::AppHandle) -> Result<AppSettings, String> {
    read_settings_at(&settings_path(app_handle)?)
}

fn read_settings_at(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(path).map_err(|_| "读取应用设置失败。".to_string())?;
    serde_json::from_str(&content).map_err(|_| "应用设置已损坏，请恢复默认设置。".to_string())
}

fn write_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    write_settings_at(&settings_path(app_handle)?, settings)
}

fn write_settings_at(path: &Path, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "创建应用设置目录失败。".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(settings).map_err(|_| "序列化应用设置失败。".to_string())?,
    )
    .map_err(|_| "写入应用设置失败。".to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|_| "更新应用设置失败。".to_string())?;
    }
    std::fs::rename(temporary, path).map_err(|_| "保存应用设置失败。".to_string())
}

fn unavailable_engine(name: &str, path: Option<&PathBuf>) -> EngineInfo {
    let mut info = EngineInfo::new(name);
    info.path = path.map(|path| path.to_string_lossy().to_string());
    info
}

fn engine_check_json(
    mut info: EngineInfo,
    status: Option<&EnginePackStatus>,
    runtime_diagnostic: Option<String>,
) -> serde_json::Value {
    let mut status = status.cloned().unwrap_or(EnginePackStatus {
        source: EnginePackSource::Missing,
        pack_version: None,
        integrity_status: IntegrityStatus::NotApplicable,
        expected_version: None,
        actual_version: None,
        diagnostic: Some("未找到引擎定位状态。".into()),
    });
    status.actual_version = info.version.clone();
    if let Some(runtime_diagnostic) = runtime_diagnostic {
        append_diagnostic(&mut status.diagnostic, runtime_diagnostic);
    }
    if status.integrity_status == IntegrityStatus::Invalid {
        info.available = false;
    }
    if info.available {
        if let (Some(expected), Some(actual)) = (
            status.expected_version.as_deref(),
            status.actual_version.as_deref(),
        ) {
            if !version_matches(expected, actual) {
                info.available = false;
                append_diagnostic(
                    &mut status.diagnostic,
                    format!(
                        "引擎版本不匹配：期望 {expected}，实际 {actual}。请重新安装或修复应用。"
                    ),
                );
            }
        }
    }

    serde_json::json!({
        "name": info.name,
        "version": info.version,
        "path": info.path,
        "available": info.available,
        "source": status.source,
        "pack_version": status.pack_version,
        "integrity_status": status.integrity_status,
        "expected_version": status.expected_version,
        "actual_version": status.actual_version,
        "diagnostic": status.diagnostic,
        "checked_at": Utc::now().to_rfc3339(),
    })
}

fn append_diagnostic(target: &mut Option<String>, message: String) {
    match target {
        Some(existing) if !existing.contains(&message) => {
            existing.push(' ');
            existing.push_str(&message);
        }
        None => *target = Some(message),
        _ => {}
    }
}

fn collect_disk_metrics(project_path: Option<&Path>) -> (Option<String>, Option<u64>) {
    // Home has no project path: use the installed executable, not the process's
    // working directory (which can be changed by a shortcut or shell).
    let disk_path = project_path.map(Path::to_path_buf).or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(Path::to_path_buf))
    });
    let available = disk_path
        .as_deref()
        .and_then(|path| fs2::available_space(path).ok());
    (
        disk_path.map(|path| path.to_string_lossy().into_owned()),
        available,
    )
}

fn collect_resource_metrics(project_path: Option<&Path>) -> ResourceMetrics {
    let mut system = System::new_all();
    system.refresh_all();
    #[cfg(target_os = "macos")]
    let cpu_usage_percent = cpu::observe_cpu_usage();
    #[cfg(not(target_os = "macos"))]
    let cpu_usage_percent = Some(system.global_cpu_usage());
    let (disk_path, project_disk_available_bytes) = collect_disk_metrics(project_path);
    let mut warnings = Vec::new();
    let runtime = match resources::runtime_summary(project_path) {
        Ok(runtime) => runtime,
        Err(warning) => {
            warnings.push(warning);
            None
        }
    };
    let gpu = if cfg!(target_os = "macos") {
        runtime
            .as_ref()
            .and_then(|runtime| runtime.device_name.as_ref())
            .map(|name| GpuMetrics {
                name: name.clone(),
                driver_version: None,
                memory_total_bytes: None,
                memory_used_bytes: None,
                utilization_percent: None,
                temperature_celsius: None,
            })
    } else {
        query_nvidia_gpu()
    };
    let memory = resources::observe_memory(&system);
    let preview_policy = resources::preview_policy(
        cfg!(target_os = "macos"),
        system.total_memory(),
        memory.available_bytes,
        memory.pressure,
    );
    match preview_policy.action {
        resources::PreviewAction::Pause => warnings.push(
            if preview_policy.reason == Some("low_available_memory") {
                "可用内存偏低，已暂停新预览帧，训练继续。"
            } else {
                "内存压力升高，已暂停新预览帧，训练继续。"
            }
            .into(),
        ),
        resources::PreviewAction::Release => {
            warnings.push("可用内存不足，已释放预览模型，训练与检查点保持不变。".into())
        }
        resources::PreviewAction::Allow => {}
    }
    if let Some(gpu) = &gpu {
        let ratio = gpu
            .memory_total_bytes
            .zip(gpu.memory_used_bytes)
            .filter(|(total, _)| *total > 0)
            .map_or(0.0, |(total, used)| used as f64 / total as f64);
        if ratio >= 0.95 {
            warnings.push("VRAM 使用率已超过 95%。".into());
        } else if ratio >= 0.85 {
            warnings.push("VRAM 使用率已超过 85%。".into());
        }
    }
    ResourceMetrics {
        timestamp: Utc::now().to_rfc3339(),
        operating_system: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.into()),
        cpu_name: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().to_string())
            .filter(|name| !name.is_empty()),
        cpu_usage_percent,
        memory_total_bytes: system.total_memory(),
        memory_used_bytes: system.used_memory(),
        project_disk_available_bytes,
        disk_path,
        gpu,
        memory,
        processes: resources::process_memory(&system, std::process::id()),
        runtime,
        preview_policy,
        warnings,
    }
}

fn query_nvidia_gpu() -> Option<GpuMetrics> {
    let output = splat_process::probe_output_sync(background_command("nvidia-smi").args([
        "--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]))
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .to_string();
    let values = line.split(',').map(str::trim).collect::<Vec<_>>();
    if values.len() < 6 {
        return None;
    }
    Some(GpuMetrics {
        name: values[0].into(),
        driver_version: Some(values[1].into()),
        memory_total_bytes: Some(values[2].parse::<u64>().ok()?.saturating_mul(1024 * 1024)),
        memory_used_bytes: Some(values[3].parse::<u64>().ok()?.saturating_mul(1024 * 1024)),
        utilization_percent: values[4].parse().ok(),
        temperature_celsius: values[5].parse().ok(),
    })
}

fn tail_file(path: &Path, max_bytes: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "读取日志失败。".to_string())?;
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if length > max_bytes {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(length - max_bytes))
            .map_err(|_| "读取日志失败。".to_string())?;
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|_| "读取日志失败。".to_string())?;
    Ok(content)
}

fn serialize_diagnostic_system_metrics<F>(metrics: &ResourceMetrics, redact: &F) -> String
where
    F: Fn(String) -> String,
{
    let content = serde_json::to_string_pretty(metrics).unwrap_or_default();
    sanitize_json_document(&content, redact, false).unwrap_or_else(|| "{}".into())
}

fn sanitize_json_document<F>(content: &str, redact: &F, redact_identity: bool) -> Option<String>
where
    F: Fn(String) -> String,
{
    let mut value = serde_json::from_str::<serde_json::Value>(content).ok()?;
    sanitize_json_value(&mut value, redact, redact_identity);
    serde_json::to_string_pretty(&value).ok()
}

fn sanitize_event_tail<F>(content: &str, redact: &F) -> String
where
    F: Fn(String) -> String,
{
    content
        .lines()
        .filter_map(|line| {
            let mut value = serde_json::from_str::<serde_json::Value>(line).ok()?;
            if let Some(object) = value.as_object_mut() {
                for field in ["technical_message", "source_log", "metrics"] {
                    object.remove(field);
                }
            }
            sanitize_json_value(&mut value, redact, false);
            serde_json::to_string(&value).ok()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn sanitize_json_value<F>(value: &mut serde_json::Value, redact: &F, redact_identity: bool)
where
    F: Fn(String) -> String,
{
    match value {
        serde_json::Value::Object(object) => {
            for (key, nested) in object.iter_mut() {
                let normalized = key.to_ascii_lowercase();
                if [
                    "token",
                    "password",
                    "secret",
                    "api_key",
                    "authorization",
                    "private_key",
                ]
                .contains(&normalized.as_str())
                {
                    *nested = serde_json::Value::String("[REDACTED]".into());
                } else if [
                    "technical_message",
                    "source_log",
                    "stdout",
                    "stderr",
                    "stack",
                    "raw_output",
                    "command",
                    "arguments",
                ]
                .contains(&normalized.as_str())
                {
                    *nested = serde_json::Value::Null;
                } else if normalized.contains("path")
                    || normalized.contains("directory")
                    || normalized.contains("executable")
                {
                    if nested.is_string() {
                        *nested = serde_json::Value::String("[REDACTED_PATH]".into());
                    } else {
                        sanitize_json_value(nested, redact, redact_identity);
                    }
                } else if redact_identity && matches!(normalized.as_str(), "name" | "id") {
                    *nested = serde_json::Value::String("[REDACTED_PROJECT]".into());
                } else {
                    sanitize_json_value(nested, redact, redact_identity);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                sanitize_json_value(nested, redact, redact_identity);
            }
        }
        serde_json::Value::String(text) => *text = redact(std::mem::take(text)),
        _ => {}
    }
}

fn redact_marker_value(mut content: String, marker: &str) -> String {
    let mut search_from = 0;
    loop {
        let lowercase = content.to_ascii_lowercase();
        let Some(relative_start) = lowercase[search_from..].find(marker) else {
            break;
        };
        let marker_start = search_from + relative_start;
        let value_start = marker_start + marker.len();
        let value_end = content[value_start..]
            .char_indices()
            .find_map(|(offset, character)| {
                (character.is_whitespace() || matches!(character, ',' | ';' | '"' | '\''))
                    .then_some(value_start + offset)
            })
            .unwrap_or(content.len());
        content.replace_range(value_start..value_end, "[REDACTED]");
        search_from = value_start + "[REDACTED]".len();
    }
    content
}

fn redact_inline_secrets(mut content: String) -> String {
    for marker in [
        "token=",
        "token:",
        "password=",
        "password:",
        "secret=",
        "secret:",
        "api_key=",
        "api-key=",
        "authorization=",
        "bearer ",
    ] {
        content = redact_marker_value(content, marker);
    }
    content
}

fn redact_text(
    mut content: String,
    project_root: &Path,
    engine_root: Option<&Path>,
    home: Option<&Path>,
) -> String {
    for (path, replacement) in [
        (Some(project_root), "<PROJECT_ROOT>"),
        (engine_root, "<ENGINE_ROOT>"),
        (home, "<USER_HOME>"),
    ] {
        if let Some(path) = path {
            let display = path.to_string_lossy();
            content = content
                .replace(display.as_ref(), replacement)
                .replace(&display.replace('\\', "/"), replacement);
        }
    }
    redact_inline_secrets(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    struct VersionFixture(PathBuf);

    #[cfg(unix)]
    impl VersionFixture {
        fn new(ffprobe_exit: i32) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir()
                .join(format!("engine-version-中文 空格-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir(&root).unwrap();
            // Captured release output: the compiler and library versions must
            // never replace the n8.1.2 version on the program's first line.
            let output = "ffprobe version n8.1.2 Copyright (c) 2007-2026 the FFmpeg developers\n\
                built with Apple clang version 21.0.0 (clang-2100.3.34.2)\n\
                configuration: --arch=arm64 --target-os=darwin --disable-network\n\
                libavutil      60. 26.102 / 60. 26.102\n\
                libavcodec     62. 28.102 / 62. 28.102\n";
            for (name, code) in [("ffmpeg", 0), ("ffprobe", ffprobe_exit)] {
                let program = root.join(name);
                let output = output.replacen("ffprobe version", &format!("{name} version"), 1);
                std::fs::write(
                    &program,
                    format!(
                        "#!/bin/sh\n[ \"$1\" = -version ] || exit 64\ncat <<'VERSION'\n{output}VERSION\nexit {code}\n"
                    ),
                )
                .unwrap();
                std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            Self(root)
        }

        fn check(&self, expected_ffprobe: &str) -> serde_json::Value {
            self.check_with_expected(Some(expected_ffprobe))
        }

        fn check_with_expected(&self, expected_ffprobe: Option<&str>) -> serde_json::Value {
            let state = AppState::new();
            let checks = check_engines_with_resolution(&state, || {
                assert_eq!(state.0.lock().unwrap().pending_work, 1);
                let status = |version: Option<&str>| EnginePackStatus {
                    source: EnginePackSource::Resource,
                    pack_version: Some("0.1.0-alpha.6".into()),
                    integrity_status: IntegrityStatus::Valid,
                    expected_version: version.map(str::to_owned),
                    actual_version: None,
                    diagnostic: None,
                };
                EngineResolution {
                    paths: EnginePaths {
                        ffmpeg: Some(self.0.join("ffmpeg")),
                        ffprobe: Some(self.0.join("ffprobe")),
                        ..Default::default()
                    },
                    statuses: BTreeMap::from([
                        ("ffmpeg".into(), status(Some("8.1.2"))),
                        ("ffprobe".into(), status(expected_ffprobe)),
                    ]),
                    pack_error: None,
                }
            });
            assert_eq!(state.0.lock().unwrap().pending_work, 0);
            checks
                .into_iter()
                .find(|check| check["name"] == "ffmpeg")
                .unwrap()
        }
    }

    #[cfg(unix)]
    impl Drop for VersionFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn ffprobe_release_version_uses_adapter_instead_of_compiler_version() {
        let check = VersionFixture::new(0).check("8.1.2");
        assert_eq!(check["available"], true, "{check}");
        assert_eq!(check["actual_version"], "8.1.2");
        assert!(check["diagnostic"].is_null(), "{check}");
    }

    #[cfg(unix)]
    #[test]
    fn ffprobe_mismatch_reports_companion_version_and_nonzero_exit_is_rejected() {
        let check = VersionFixture::new(0).check("8.1.1");
        assert_eq!(check["available"], false);
        let diagnostic = check["diagnostic"].as_str().unwrap();
        assert!(
            diagnostic.contains("期望 8.1.1，实际 8.1.2"),
            "{diagnostic}"
        );
        assert!(!diagnostic.contains("21.0.0"), "{diagnostic}");

        let failed = VersionFixture::new(7).check("8.1.2");
        assert_eq!(failed["available"], false);
        assert!(failed["diagnostic"]
            .as_str()
            .unwrap()
            .contains("启动检查失败"));
    }

    #[cfg(unix)]
    #[test]
    fn ffprobe_missing_banner_is_unavailable_without_a_pinned_version() {
        let fixture = VersionFixture::new(0);
        std::fs::write(
            fixture.0.join("ffprobe"),
            "#!/bin/sh\nprintf 'built with Apple clang version 21.0.0\\n'\n",
        )
        .unwrap();
        let check = fixture.check_with_expected(None);
        assert_eq!(check["available"], false, "{check}");
        assert!(check["diagnostic"]
            .as_str()
            .unwrap()
            .contains("FFprobe 未报告可识别的版本"));
    }

    /// The startup/preflight body, including its pending-work receipt, against
    /// an explicit frozen pack. Only version/help probes run; no Metal or training.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires METORIGIN_TEST_ENGINE_PACK and METORIGIN_TEST_ENGINE_MANIFEST_SHA256"]
    fn frozen_macos_engine_pack_passes_application_version_checks() {
        let root = PathBuf::from(
            std::env::var_os("METORIGIN_TEST_ENGINE_PACK")
                .expect("set METORIGIN_TEST_ENGINE_PACK to the frozen engine pack"),
        );
        let expected_digest = std::env::var("METORIGIN_TEST_ENGINE_MANIFEST_SHA256")
            .expect("set METORIGIN_TEST_ENGINE_MANIFEST_SHA256 to the selected manifest digest");
        let manifest = splat_hardware::EnginePackManifest::load(&root).unwrap();
        let hash_output = splat_process::probe_output_sync(
            background_command("/usr/bin/shasum")
                .args(["-a", "256"])
                .arg(root.join("engine-manifest.json")),
        )
        .unwrap();
        assert!(hash_output.status.success());
        let digest = String::from_utf8(hash_output.stdout)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
        assert!(digest.eq_ignore_ascii_case(&expected_digest));
        let state = AppState::new();
        let checks = check_engines_with_resolution(&state, || {
            assert_eq!(state.0.lock().unwrap().pending_work, 1);
            let resolution = EngineLocator::resolve_detailed(EngineLocatorOptions {
                resource_dir: Some(root.clone()),
                mode: splat_hardware::EngineResolutionMode::Release,
                ..Default::default()
            });
            assert!(
                resolution.pack_error.is_none() && resolution.bundled_pack_is_valid(),
                "frozen pack rejected: {:?}",
                resolution.pack_error
            );
            resolution
        });
        assert_eq!(state.0.lock().unwrap().pending_work, 0);
        assert_eq!(checks.len(), 3);
        for name in ["ffmpeg", "colmap", "brush"] {
            let check = checks.iter().find(|check| check["name"] == name).unwrap();
            assert_eq!(check["available"], true, "{check}");
            assert_eq!(check["source"], "resource");
            assert_eq!(check["integrity_status"], "valid");
            assert!(check["diagnostic"].is_null(), "{check}");
            assert_eq!(
                PathBuf::from(check["path"].as_str().unwrap()),
                std::fs::canonicalize(root.join(&manifest.engines[name].executables[name]))
                    .unwrap()
            );
        }
        println!(
            "{}",
            serde_json::json!({
                "engine_pack": root,
                "manifest_sha256": digest,
                "declared_file_count": manifest.engines.values().map(|engine| engine.files.len()).sum::<usize>(),
                "mode": "release", "integrity_cache": false,
                "application_version_checks": "passed", "pending_work_after": 0,
                "engine_version_help_probes_executed": true, "gpu_or_training_executed": false,
                "checks": checks,
            })
        );
    }

    #[test]
    fn idle_sleep_setting_defaults_off_for_new_and_legacy_settings() {
        assert!(!AppSettings::default().prevent_idle_sleep);
        let legacy: AppSettings = serde_json::from_str(r#"{"create_and_start":true}"#).unwrap();
        assert!(!legacy.prevent_idle_sleep);
        assert!(legacy.create_and_start);
        assert!(serde_json::from_str::<AppSettings>(r#"{"prevent_idle_sleep":"true"}"#).is_err());
    }

    #[test]
    fn idle_sleep_opt_in_round_trips_through_local_settings_file() {
        let dir = std::env::temp_dir().join(format!("settings-sleep-{}", uuid::Uuid::now_v7()));
        let path = dir.join("settings.json");
        assert!(!read_settings_at(&path).unwrap().prevent_idle_sleep);
        let mut settings = AppSettings {
            prevent_idle_sleep: true,
            ..Default::default()
        };
        write_settings_at(&path, &settings).unwrap();
        assert!(read_settings_at(&path).unwrap().prevent_idle_sleep);
        settings.prevent_idle_sleep = false;
        write_settings_at(&path, &settings).unwrap();
        assert!(!read_settings_at(&path).unwrap().prevent_idle_sleep);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn disk_metrics_default_to_the_application_directory() {
        let executable = std::env::current_exe().unwrap();
        let expected = executable.parent().unwrap();
        let (path, available) = collect_disk_metrics(None);
        assert_eq!(path.as_deref(), expected.to_str());
        let available = available.expect("application disk should be readable");
        assert!(available <= fs2::total_space(expected).unwrap());
    }

    #[test]
    fn disk_metrics_use_the_project_directory_when_provided() {
        let project = std::env::temp_dir();
        let (path, available) = collect_disk_metrics(Some(&project));
        assert_eq!(path.as_deref(), project.to_str());
        assert!(available.is_some());
    }

    #[test]
    fn disk_metrics_report_unknown_instead_of_zero_for_unreadable_paths() {
        #[cfg(windows)]
        let missing = PathBuf::from(format!(r"\\?\Volume{{{}}}\", uuid::Uuid::now_v7()));
        #[cfg(not(windows))]
        let missing = std::env::temp_dir().join(uuid::Uuid::now_v7().to_string());
        let (path, available) = collect_disk_metrics(Some(&missing));
        assert_eq!(path.as_deref(), missing.to_str());
        assert_eq!(available, None);
    }

    #[test]
    fn diagnostic_system_metrics_redact_paths_and_secrets_without_changing_observations() {
        let project_root = Path::new("/Users/DiagnosticUser/projects/private-project");
        let engine_root = Path::new("/Users/DiagnosticUser/engines/private-pack");
        let home = Path::new("/Users/DiagnosticUser");
        let redact =
            |content: String| redact_text(content, project_root, Some(engine_root), Some(home));
        let metrics = ResourceMetrics {
            timestamp: "2026-10-28T18:16:26Z".into(),
            operating_system: "macOS 27.0.1".into(),
            cpu_name: Some("Apple M1 Pro".into()),
            cpu_usage_percent: Some(21.5),
            memory_total_bytes: 32 * 1024 * 1024 * 1024,
            memory_used_bytes: 18 * 1024 * 1024 * 1024,
            project_disk_available_bytes: None,
            disk_path: Some(project_root.to_string_lossy().into_owned()),
            gpu: Some(GpuMetrics {
                name: "Apple M1 Pro".into(),
                driver_version: None,
                memory_total_bytes: None,
                memory_used_bytes: None,
                utilization_percent: None,
                temperature_celsius: None,
            }),
            memory: resources::MemoryObservation {
                kind: "unified",
                available_bytes: Some(12 * 1024 * 1024 * 1024),
                available_source: Some("mach_host_statistics64_free_plus_inactive"),
                available_is_estimate: true,
                free_bytes: Some(4 * 1024 * 1024 * 1024),
                inactive_bytes: Some(8 * 1024 * 1024 * 1024),
                compressed_bytes: None,
                pressure: Some(resources::MemoryPressure::Normal),
                pressure_source: Some("kern.memorystatus_vm_pressure_level"),
                swap_total_bytes: Some(2 * 1024 * 1024 * 1024),
                swap_used_bytes: Some(0),
            },
            processes: vec![resources::ProcessMemory {
                pid: 287,
                role: "application",
                resident_bytes: 175_898_624,
            }],
            runtime: Some(resources::RuntimeResourceSummary {
                requested_preset: Some("fast".into()),
                colmap_backend: "CPU".into(),
                brush_backend: "Metal".into(),
                device_name: Some("Apple M1 Pro".into()),
                training_budget_bytes: Some(16 * 1024 * 1024 * 1024),
                recommended_working_set_bytes: None,
                effective_training: splat_domain::runtime::EffectiveTraining {
                    iterations: 3_000,
                    sh_degree: 0,
                    resolution: Some(1_280),
                    image_cache_budget_bytes: Some(1024 * 1024 * 1024),
                    max_splats: Some(1_500_000),
                    threads: 6,
                    lod_levels: Some(0),
                },
            }),
            preview_policy: resources::PreviewResourcePolicy {
                action: resources::PreviewAction::Allow,
                reason: None,
                memory_pressure: Some(resources::MemoryPressure::Normal),
                poll_interval_ms: 2_000,
                max_snapshot_bytes: 1024 * 1024 * 1024,
                recovery_samples: None,
            },
            warnings: vec![format!(
                "Read {} with {} using {}/settings token=SYSTEM_DIAGNOSTIC_SECRET",
                project_root.display(),
                engine_root.display(),
                home.display(),
            )],
        };

        // Exercise the same ResourceMetrics serialization used by the ZIP entry.
        let content = serialize_diagnostic_system_metrics(&metrics, &redact);
        let actual: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(actual["disk_path"], "[REDACTED_PATH]");
        for canary in [
            "DiagnosticUser",
            "private-project",
            "private-pack",
            "SYSTEM_DIAGNOSTIC_SECRET",
        ] {
            assert!(!content.contains(canary), "system.json leaked {canary}");
        }
        let mut expected = serde_json::to_value(&metrics).unwrap();
        expected["disk_path"] = serde_json::json!("[REDACTED_PATH]");
        expected["warnings"] = serde_json::json!([
            "Read <PROJECT_ROOT> with <ENGINE_ROOT> using <USER_HOME>/settings token=[REDACTED]"
        ]);
        assert_eq!(
            actual, expected,
            "non-sensitive observations must be preserved"
        );
    }

    #[test]
    fn diagnostic_documents_redact_credentials_paths_and_unrelated_event_content() {
        let project_root = Path::new(r"D:\projects\private-project");
        let engine_root = Path::new(r"D:\engines\private-pack");
        let home = Path::new(r"C:\Users\PrivateUser");
        let redact =
            |content: String| redact_text(content, project_root, Some(engine_root), Some(home));
        let project = serde_json::json!({
            "id": "private-project-id",
            "name": "private-project-name",
            "project_path": project_root,
            "authorization": "Bearer METORIGIN_TEST_SECRET_DO_NOT_EXPOSE",
            "technical_message": "RAW_ENGINE_OUTPUT_CANARY",
            "nested": { "message": "token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE" }
        });
        let sanitized_project = sanitize_json_document(&project.to_string(), &redact, true)
            .expect("valid diagnostic JSON");

        for canary in [
            "METORIGIN_TEST_SECRET_DO_NOT_EXPOSE",
            "PrivateUser",
            "private-project-name",
            "RAW_ENGINE_OUTPUT_CANARY",
        ] {
            assert!(!sanitized_project.contains(canary));
        }
        assert!(sanitized_project.contains("[REDACTED]"));
        assert!(sanitized_project.contains("[REDACTED_PATH]"));

        let event = serde_json::json!({
            "event_id": "event-1",
            "user_message": "failed token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\scene.json",
            "technical_message": "RAW_ENGINE_OUTPUT_CANARY",
            "source_log": "UNRELATED_LOG_CANARY",
            "metrics": { "path": "C:\\Users\\PrivateUser\\metrics.json" }
        });
        let sanitized_events = sanitize_event_tail(&event.to_string(), &redact);
        for canary in [
            "METORIGIN_TEST_SECRET_DO_NOT_EXPOSE",
            "PrivateUser",
            "RAW_ENGINE_OUTPUT_CANARY",
            "UNRELATED_LOG_CANARY",
        ] {
            assert!(!sanitized_events.contains(canary));
        }
    }

    #[test]
    fn pinned_version_mismatch_marks_engine_unavailable() {
        let info = EngineInfo {
            name: "ffmpeg".into(),
            version: Some("8.1.1".into()),
            path: Some("ffmpeg.exe".into()),
            available: true,
        };
        let status = EnginePackStatus {
            source: EnginePackSource::Resource,
            pack_version: Some("0.1.0-internal.1".into()),
            integrity_status: IntegrityStatus::Valid,
            expected_version: Some("8.1.2".into()),
            actual_version: None,
            diagnostic: None,
        };

        let result = engine_check_json(info, Some(&status), None);

        assert_eq!(result["available"], false);
        assert_eq!(result["expected_version"], "8.1.2");
        assert_eq!(result["actual_version"], "8.1.1");
        assert!(result["diagnostic"]
            .as_str()
            .is_some_and(|diagnostic| diagnostic.contains("8.1.2")));
    }
}
