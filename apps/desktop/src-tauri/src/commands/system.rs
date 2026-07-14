use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use splat_domain::hardware::{EngineInfo, EnginePaths};
use splat_hardware::EngineLocator;
use sysinfo::System;
use tauri::Manager;

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

/// Returns the application version from Cargo.toml.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn resolve_engine_paths(app_handle: &tauri::AppHandle) -> EnginePaths {
    let settings = read_settings(app_handle).unwrap_or_default();
    let resource_engines = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("engines"));
    let mut paths = EngineLocator::resolve_with_configured(
        settings.engine_directory.as_deref().map(Path::new),
        resource_engines.as_deref(),
    );
    if std::env::var_os("METORIGIN_ENGINE_DIR").is_none() {
        for (name, value) in settings.engine_executables {
            let path = PathBuf::from(value);
            if !path.is_file() {
                continue;
            }
            match name.as_str() {
                "ffmpeg" => paths.ffmpeg = Some(path),
                "ffprobe" => paths.ffprobe = Some(path),
                "colmap" => paths.colmap = Some(path),
                "brush" => paths.brush = Some(path),
                _ => {}
            }
        }
    }
    paths
}

/// Detects all engines and returns their availability status.
#[tauri::command]
pub fn check_engines(app_handle: tauri::AppHandle) -> Vec<serde_json::Value> {
    let paths = resolve_engine_paths(&app_handle);
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
    [ffmpeg, colmap, brush]
        .iter()
        .map(|info| {
            serde_json::json!({
                "name": info.name,
                "version": info.version,
                "path": info.path,
                "available": info.available,
                "source": engine_source(info.path.as_deref().map(Path::new), &app_handle),
                "checked_at": Utc::now().to_rfc3339(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_app_settings(app_handle: tauri::AppHandle) -> Result<AppSettings, String> {
    read_settings(&app_handle)
}

#[tauri::command]
pub fn save_app_settings(
    app_handle: tauri::AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    write_settings(&app_handle, &settings)?;
    Ok(settings)
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
    settings.engine_executables.insert(name, path);
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
        zip.start_file("project-summary.json", options)
            .map_err(|_| "写入诊断包失败。".to_string())?;
        zip.write_all(redact(project_json).as_bytes())
            .map_err(|_| "写入诊断包失败。".to_string())?;
    }
    if let Ok(events) = tail_file(&project_dir.join("logs/events.jsonl"), 512 * 1024) {
        zip.start_file("events-tail.jsonl", options)
            .map_err(|_| "写入诊断包失败。".to_string())?;
        zip.write_all(redact(events).as_bytes())
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
    let engines = check_engines(app_handle);
    zip.start_file("engines.json", options)
        .map_err(|_| "写入诊断包失败。".to_string())?;
    zip.write_all(redact(serde_json::to_string_pretty(&engines).unwrap_or_default()).as_bytes())
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

fn engine_source(path: Option<&Path>, app_handle: &tauri::AppHandle) -> &'static str {
    let Some(path) = path else {
        return "missing";
    };
    if let Some(root) = std::env::var_os("METORIGIN_ENGINE_DIR").map(PathBuf::from) {
        if path.starts_with(root) {
            return "environment";
        }
    }
    if let Ok(resource) = app_handle.path().resource_dir() {
        if path.starts_with(resource) {
            return "resource";
        }
    }
    "configured_or_path"
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
    let output = Command::new("nvidia-smi")
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
    content
}
