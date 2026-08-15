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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AppSettings {
    engine_directory: Option<String>,
    engine_executables: BTreeMap<String, String>,
    default_project_root: Option<String>,
    default_preset: String,
    create_and_start: bool,
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
            log_retention_mb: 512,
            thumbnail_cache_mb: 256,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GpuMetrics {
    name: String,
    driver_version: Option<String>,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    utilization_percent: Option<f64>,
    temperature_celsius: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ResourceMetrics {
    timestamp: String,
    operating_system: String,
    cpu_name: Option<String>,
    cpu_usage_percent: f32,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    project_disk_available_bytes: u64,
    gpu: Option<GpuMetrics>,
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
    EngineLocator::resolve_detailed(EngineLocatorOptions {
        configured_dir: settings.engine_directory.map(PathBuf::from),
        configured_executables,
        resource_dir: resource_engines,
        integrity_cache,
        ..EngineLocatorOptions::default()
    })
}

/// Finds a portable/developer `.engines` pack without embedding a machine
/// path into the application. This covers launching from the repository root
/// and launching `target/debug/splat-desktop.exe` directly.
#[cfg(debug_assertions)]
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
    let resolution = resolve_engine_resolution(&app_handle);
    let paths = &resolution.paths;

    let (mut ffmpeg, mut ffmpeg_diagnostic) = match (&paths.ffmpeg, &paths.ffprobe) {
        (Some(ffmpeg), Some(ffprobe)) => {
            match splat_engine_ffmpeg::FfmpegAdapter::from_paths(ffmpeg.clone(), ffprobe.clone()) {
                Ok(adapter) => (adapter.engine_info(), None),
                Err(error) => (
                    unavailable_engine("ffmpeg", Some(ffmpeg)),
                    Some(format!("FFmpeg 启动检查失败：{error}")),
                ),
            }
        }
        _ => (
            unavailable_engine("ffmpeg", paths.ffmpeg.as_ref()),
            Some("FFmpeg 或 FFprobe 未定位。".into()),
        ),
    };
    if let Some(ffprobe) = paths.ffprobe.as_deref() {
        match probe_version(ffprobe, "-version") {
            Ok(actual) => {
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
    zip.write_all(
        serde_json::to_string_pretty(&metrics)
            .unwrap_or_default()
            .as_bytes(),
    )
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
    let path = settings_path(app_handle)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(path).map_err(|_| "读取应用设置失败。".to_string())?;
    serde_json::from_str(&content).map_err(|_| "应用设置已损坏，请恢复默认设置。".to_string())
}

fn write_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app_handle)?;
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "创建应用设置目录失败。".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(settings).map_err(|_| "序列化应用设置失败。".to_string())?,
    )
    .map_err(|_| "写入应用设置失败。".to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|_| "更新应用设置失败。".to_string())?;
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

fn probe_version(path: &Path, argument: &str) -> Result<String, String> {
    let output = background_command(path)
        .arg(argument)
        .output()
        .map_err(|error| format!("无法运行 '{}': {error}", path.display()))?;
    if !output.status.success() {
        return Err(format!(
            "'{} {argument}' 退出码为 {}",
            path.display(),
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated".into())
        ));
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.split(|character: char| !(character.is_ascii_alphanumeric() || character == '.'))
        .map(|token| token.trim_start_matches(['v', 'V']))
        .find(|token| {
            token
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_digit())
                && token.contains('.')
        })
        .map(str::to_string)
        .ok_or_else(|| format!("'{} {argument}' 未报告可识别的版本", path.display()))
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

fn collect_resource_metrics(project_path: Option<&Path>) -> ResourceMetrics {
    let mut system = System::new_all();
    system.refresh_all();
    let project_disk_available_bytes = project_path
        .and_then(|path| fs2::available_space(path).ok())
        .unwrap_or(0);
    let gpu = query_nvidia_gpu();
    let mut warnings = Vec::new();
    if let Some(gpu) = &gpu {
        let ratio = if gpu.memory_total_bytes == 0 {
            0.0
        } else {
            gpu.memory_used_bytes as f64 / gpu.memory_total_bytes as f64
        };
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
        cpu_usage_percent: system.global_cpu_usage(),
        memory_total_bytes: system.total_memory(),
        memory_used_bytes: system.used_memory(),
        project_disk_available_bytes,
        gpu,
        warnings,
    }
}

fn query_nvidia_gpu() -> Option<GpuMetrics> {
    let output = background_command("nvidia-smi")
        .args(["--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"])
        .output().ok()?;
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
        memory_total_bytes: values[2].parse::<u64>().ok()?.saturating_mul(1024 * 1024),
        memory_used_bytes: values[3].parse::<u64>().ok()?.saturating_mul(1024 * 1024),
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
