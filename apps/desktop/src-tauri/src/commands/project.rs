use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::Engine;
use chrono::Utc;
use splat_domain::project::{
    ImageFolderSource, Project, ProjectSource, ProjectStatus, VideoSource,
};
use splat_pipeline::image_input::{encode_preview, scan_image_directory, uniform_sample_indices};
use splat_project::{paths, ProjectManager};
use tauri::{Emitter, Manager};

use crate::state::{ActiveProjectCreation, AppState, ProjectInfo};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct PresetEstimate {
    id: String,
    name: String,
    description: String,
    fps: f64,
    max_frames: u32,
    target_long_edge: u32,
    colmap_long_edge: u32,
    iterations: u32,
    sh_degree: u32,
    checkpoint_interval: u32,
    estimated_frames: u64,
    estimated_disk_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ImageSetMetadata {
    image_count: usize,
    ignored_count: usize,
    invalid_count: usize,
    total_size_bytes: u64,
    formats: std::collections::BTreeMap<String, usize>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImagePreview {
    relative_path: String,
    display_name: String,
    width: u32,
    height: u32,
    data_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaAnalysis {
    source_kind: String,
    source_path: String,
    display_name: String,
    size_bytes: u64,
    valid: bool,
    video_metadata: Option<splat_engine_ffmpeg::probe::VideoMetadata>,
    image_set_metadata: Option<ImageSetMetadata>,
    preset_estimates: Vec<PresetEstimate>,
    preview_items: Vec<String>,
    warnings: Vec<String>,
    blockers: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightProjectRequest {
    source_path: String,
    project_root: Option<String>,
    preset: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct EngineCheck {
    name: String,
    available: bool,
    path: Option<String>,
    expected_version: Option<String>,
    actual_version: Option<String>,
    diagnostic: Option<String>,
    source: Option<String>,
    integrity_status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectPreflight {
    can_continue: bool,
    engine_checks: Vec<EngineCheck>,
    estimated_frames: u64,
    estimated_disk_bytes: u64,
    available_disk_bytes: u64,
    recommended_preset: String,
    warnings: Vec<String>,
    blockers: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectRequest {
    pub(crate) project_id: String,
    pub(crate) project_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeleteProjectResult {
    project_id: String,
    deleted_path: String,
    removed_from_recent: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    name: String,
    source_path: String,
    preset: String,
    project_root: Option<String>,
    start_after_create: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CreateProjectResult {
    id: String,
    name: String,
    path: String,
    status: String,
    start_after_create: bool,
}

#[derive(serde::Deserialize)]
struct PresetFile {
    id: String,
    name: String,
    description: String,
    #[serde(rename = "frameExtraction")]
    frame_extraction: FrameExtractionPreset,
    training: TrainingPreset,
}

#[derive(serde::Deserialize)]
struct FrameExtractionPreset {
    fps: f64,
    #[serde(rename = "maxFrames")]
    max_frames: u32,
    #[serde(rename = "targetLongEdge")]
    target_long_edge: u32,
    #[serde(rename = "colmapLongEdge", default)]
    colmap_long_edge: u32,
}

#[derive(serde::Deserialize)]
struct TrainingPreset {
    iterations: u32,
    #[serde(rename = "shDegree")]
    sh_degree: u32,
}

/// Analyze a media file and return its metadata (for the new-project wizard).
#[tauri::command]
pub async fn analyze_media(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<MediaAnalysis, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("未找到文件或目录：{}", path.display()));
    }

    // Check if it's a video file
    let is_video = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "mp4" | "mov" | "avi" | "mkv"))
        .unwrap_or(false);

    if is_video {
        let engine_paths = crate::commands::system::resolve_engine_paths(&app_handle);
        let size_bytes = std::fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let display_name = display_name(&path);
        let Some(ffprobe) = engine_paths.ffprobe else {
            return Ok(MediaAnalysis {
                source_kind: "video".into(),
                source_path: path.to_string_lossy().to_string(),
                display_name,
                size_bytes,
                valid: false,
                video_metadata: None,
                image_set_metadata: None,
                preset_estimates: Vec::new(),
                preview_items: Vec::new(),
                warnings: Vec::new(),
                blockers: vec!["未找到 FFprobe。请先在引擎设置中定位 FFmpeg 引擎。".into()],
            });
        };

        match splat_engine_ffmpeg::probe::probe_video_with_async(
            &ffprobe,
            &path,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        {
            Ok(meta) => Ok(MediaAnalysis {
                source_kind: "video".into(),
                source_path: path.to_string_lossy().to_string(),
                display_name,
                size_bytes,
                valid: true,
                preset_estimates: preset_estimates(Some(&meta), None)?,
                video_metadata: Some(meta),
                image_set_metadata: None,
                preview_items: Vec::new(),
                warnings: Vec::new(),
                blockers: Vec::new(),
            }),
            Err(error) => Ok(MediaAnalysis {
                source_kind: "video".into(),
                source_path: path.to_string_lossy().to_string(),
                display_name,
                size_bytes,
                valid: false,
                video_metadata: None,
                image_set_metadata: None,
                preset_estimates: Vec::new(),
                preview_items: Vec::new(),
                warnings: Vec::new(),
                blockers: vec![format!("无法读取媒体元数据：{}", error.user_message_zh())],
            }),
        }
    } else if path.is_dir() {
        let scan = scan_image_directory(&path).map_err(|error| error.user_message_zh())?;
        let metadata = image_set_metadata(&scan);
        let valid = metadata.image_count >= 3;
        let total_size = metadata.total_size_bytes;
        let image_count = metadata.image_count;
        let mut warnings = Vec::new();
        if scan
            .images
            .iter()
            .any(|image| image.relative_path.contains('/'))
        {
            warnings.push("已递归扫描子目录；导入时会保留原始相对目录结构。".into());
        }
        if !scan.invalid_items.is_empty() {
            let examples = scan
                .invalid_items
                .iter()
                .take(5)
                .map(|item| item.relative_path.as_str())
                .collect::<Vec<_>>()
                .join("、");
            warnings.push(format!(
                "发现 {} 张损坏或无法读取的图片，将跳过：{}{}",
                scan.invalid_items.len(),
                examples,
                if scan.invalid_items.len() > 5 {
                    " 等"
                } else {
                    ""
                }
            ));
        }
        Ok(MediaAnalysis {
            source_kind: "images".into(),
            source_path: path.to_string_lossy().to_string(),
            display_name: display_name(&path),
            size_bytes: total_size,
            valid,
            video_metadata: None,
            image_set_metadata: Some(metadata),
            preset_estimates: preset_estimates(None, Some(image_count))?,
            preview_items: Vec::new(),
            warnings,
            blockers: if valid {
                Vec::new()
            } else if image_count > 0 {
                vec![format!(
                    "有效图片只有 {image_count} 张；重建至少需要 3 张可读取图片。"
                )]
            } else {
                vec!["所选文件夹中没有可用图片。".into()]
            },
        })
    } else {
        Err(format!("不支持的文件格式：{}", path.display()))
    }
}

/// Return controlled, downscaled previews for a previously selected image directory.
/// The source is rescanned and validated; callers never receive arbitrary local file contents.
#[tauri::command]
pub fn get_image_previews(path: String) -> Result<Vec<ImagePreview>, String> {
    let root = PathBuf::from(path);
    let scan = scan_image_directory(&root).map_err(|error| error.user_message_zh())?;
    let indices = uniform_sample_indices(scan.images.len(), 6);
    indices
        .into_iter()
        .filter_map(|index| scan.images.get(index))
        .map(|candidate| {
            let data_url = match encode_preview(&candidate.path, 360, 82) {
                Ok(encoded) => format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(encoded.bytes)
                ),
                Err(error) => {
                    tracing::warn!(
                        source = %candidate.relative_path,
                        error = %error,
                        "image preview encoding failed"
                    );
                    String::new()
                }
            };
            Ok::<_, String>(ImagePreview {
                relative_path: candidate.relative_path.clone(),
                display_name: candidate
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| candidate.relative_path.clone()),
                width: candidate.width,
                height: candidate.height,
                data_url,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn preflight_project(
    request: PreflightProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectPreflight, String> {
    build_project_preflight(request, &app_handle, state.inner()).await
}

async fn build_project_preflight(
    request: PreflightProjectRequest,
    app_handle: &tauri::AppHandle,
    state: &AppState,
) -> Result<ProjectPreflight, String> {
    let analysis = analyze_media(request.source_path, app_handle.clone()).await?;
    let root = request
        .project_root
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_dir);
    let existing_root = existing_ancestor(&root);
    let available_disk_bytes = existing_root
        .as_deref()
        .and_then(|path| fs2::available_space(path).ok())
        .unwrap_or(0);
    let include_ffmpeg = analysis.source_kind == "video";
    let check_handle = app_handle.clone();
    let engine_checks = tokio::task::spawn_blocking(move || {
        let mut checks = crate::commands::system::check_engines_blocking(check_handle)
            .into_iter()
            .map(|value| {
                serde_json::from_value::<EngineCheck>(value)
                    .map_err(|error| format!("引擎检查结果格式无效：{error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        checks.retain(|check| include_ffmpeg || check.name != "ffmpeg");
        for check in &mut checks {
            check.name = match check.name.as_str() {
                "ffmpeg" => "FFmpeg / FFprobe",
                "colmap" => "COLMAP",
                "brush" => "Brush",
                _ => check.name.as_str(),
            }
            .into();
        }
        checks.push(check_nvidia_runtime());
        Ok::<_, String>(checks)
    })
    .await
    .map_err(|error| format!("引擎检查任务异常结束，请重试：{error}"))??;
    let selected = analysis
        .preset_estimates
        .iter()
        .find(|preset| preset.id == request.preset);
    let estimated_frames = selected.map(|preset| preset.estimated_frames).unwrap_or(0);
    let estimated_disk_bytes = selected
        .map(|preset| preset.estimated_disk_bytes)
        .unwrap_or(0)
        .saturating_add(analysis.size_bytes)
        .saturating_add(5 * 1024 * 1024 * 1024);
    let mut blockers = analysis.blockers;
    let mut warnings = analysis.warnings;
    if analysis.source_kind == "images" {
        if let (Some(metadata), Some(preset)) = (&analysis.image_set_metadata, selected) {
            if metadata.image_count > preset.max_frames as usize {
                warnings.push(format!(
                    "发现 {} 张有效图片，{}预设将均匀选取其中 {} 张（包含首尾）。",
                    metadata.image_count, preset.name, preset.estimated_frames
                ));
            }
        }
    }
    if selected.is_none() {
        blockers.push("所选质量预设无效，请重新选择后再试。".into());
    }
    if !root.exists() && existing_root.is_none() {
        blockers.push("无法定位项目目标目录所在磁盘。".into());
    }
    for engine in &engine_checks {
        if !engine.available {
            blockers.push(format!(
                "{} 不可用：{}",
                engine.name,
                engine.diagnostic.as_deref().unwrap_or("启动检查未通过。")
            ));
        }
    }
    if let Some(blocker) = disk_space_blocker(available_disk_bytes, estimated_disk_bytes) {
        blockers.push(blocker);
    }
    if state
        .0
        .lock()
        .map_err(|_| "读取应用状态失败，请重启应用后重试。".to_string())?
        .active_creation
        .is_some()
    {
        blockers.push("另一个项目正在创建，请等待完成或先取消。".into());
    }
    Ok(ProjectPreflight {
        can_continue: blockers.is_empty(),
        engine_checks,
        estimated_frames,
        estimated_disk_bytes,
        available_disk_bytes,
        recommended_preset: "fast".into(),
        warnings,
        blockers,
    })
}

fn disk_space_blocker(available_disk_bytes: u64, estimated_disk_bytes: u64) -> Option<String> {
    if available_disk_bytes == 0 || available_disk_bytes >= estimated_disk_bytes {
        return None;
    }
    Some(format!(
        "项目磁盘空间不足，还需要约 {:.1} GiB。",
        (estimated_disk_bytes - available_disk_bytes) as f64 / 1024_f64.powi(3)
    ))
}

/// Create a new project.
#[tauri::command]
pub async fn create_project(
    request: CreateProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CreateProjectResult, String> {
    validate_project_name(&request.name)?;
    let app_state = state.inner().clone();
    let preflight = build_project_preflight(
        PreflightProjectRequest {
            source_path: request.source_path.clone(),
            project_root: request.project_root.clone(),
            preset: request.preset.clone(),
        },
        &app_handle,
        &app_state,
    )
    .await?;
    if !preflight.can_continue {
        return Err(format!(
            "创建前检查未通过：{}",
            preflight.blockers.join("；")
        ));
    }
    let project = Project::new(request.name.trim());
    let creation_id = project.id.to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut inner = app_state
            .0
            .lock()
            .map_err(|_| "项目创建状态不可用，请重启应用后重试。".to_string())?;
        if inner.active_creation.is_some() {
            return Err("另一个项目正在创建，请等待完成或先取消。".into());
        }
        inner.active_creation = Some(ActiveProjectCreation {
            id: creation_id.clone(),
            cancel: cancel.clone(),
        });
    }

    let worker_request = request.clone();
    let worker_handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        create_project_transaction(project, worker_request, worker_handle, cancel)
    })
    .await
    .map_err(|_| "项目创建后台任务异常终止，请重试。".to_string())?;

    if let Ok(mut inner) = app_state.0.lock() {
        if inner
            .active_creation
            .as_ref()
            .map(|active| active.id == creation_id)
            .unwrap_or(false)
        {
            inner.active_creation = None;
        }
    }

    let (project, project_dir) = result?;
    let info = project_info(&project, &project_dir);
    record_recent_project(&app_handle, &app_state, info, Some(project_dir.clone()))?;
    Ok(CreateProjectResult {
        id: project.id.to_string(),
        name: project.name,
        path: project_dir.to_string_lossy().to_string(),
        status: project.status.to_string(),
        start_after_create: request.start_after_create,
    })
}

#[tauri::command]
pub fn cancel_project_creation(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let inner = state
        .0
        .lock()
        .map_err(|_| "项目创建状态不可用，请重启应用后重试。".to_string())?;
    let Some(active) = &inner.active_creation else {
        return Err("当前没有正在创建的项目。".into());
    };
    active.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Open an existing project and return its data.
#[tauri::command]
pub fn open_project(
    path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&path);
    let default_dir = dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetOrigin Projects");
    let manager = ProjectManager::new(default_dir);
    let mut project = manager
        .open_project(&project_dir)
        .map_err(|e| e.user_message_zh())?;

    if project.source.is_none() {
        if let Some(recovered_source) = detect_copied_source(&project_dir.join("source")) {
            project.source = Some(recovered_source);
            project.touch();
            manager
                .save_project(&project, &project_dir)
                .map_err(|e| e.user_message_zh())?;
        }
    }

    let json = serde_json::to_value(&project)
        .map_err(|_| "读取项目数据失败，请重试并查看日志。".to_string())?;

    let info = project_info(&project, &project_dir);
    record_recent_project(&app_handle, state.inner(), info, Some(project_dir))?;

    Ok(json)
}

/// List recent projects from the persisted local index.
#[tauri::command]
pub fn list_recent_projects(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProjectInfo>, String> {
    let _writer = state.inner().recent_index_write_guard();
    let mut projects = read_recent_project_index(&app_handle)?;
    refresh_recent_projects(&mut projects);
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Ok(mut inner) = state.0.lock() {
        inner.recent_projects = projects.clone();
    }
    Ok(projects)
}

/// Return the persisted recent-project index without touching any project path.
#[tauri::command]
pub fn list_recent_project_index(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProjectInfo>, String> {
    let _writer = state.inner().recent_index_write_guard();
    let projects = read_recent_project_index(&app_handle)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "最近项目状态不可用，请重启应用后重试。".to_string())?;
    inner.recent_projects = projects.clone();
    Ok(projects)
}

#[tauri::command]
pub async fn check_recent_project_availability(
    project_id: String,
    project_path: String,
) -> Result<ProjectAvailabilityResult, String> {
    tokio::task::spawn_blocking(move || probe_recent_project(project_id, project_path))
        .await
        .map_err(|_| "项目路径检查后台任务意外终止，请重试。".to_string())
}

#[tauri::command]
pub fn relink_recent_project(
    request: RelinkRecentProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectInfo, String> {
    let _writer = state.inner().recent_index_write_guard();
    let index_path = recent_project_index_path(&app_handle)?;
    let refreshed = relink_recent_project_path(&request, &index_path)?;
    let projects = read_recent_project_index_path(&index_path)?;
    let candidate = PathBuf::from(&request.candidate_path);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "重定位已保存，但应用状态刷新失败，请重启应用。".to_string())?;
    inner.recent_projects = projects;
    if inner
        .project_dir
        .as_ref()
        .is_some_and(|path| paths_refer_to_same_project(path, Path::new(&request.previous_path)))
    {
        inner.project_dir = Some(candidate);
    }
    Ok(refreshed)
}

fn relink_recent_project_path(
    request: &RelinkRecentProjectRequest,
    index_path: &Path,
) -> Result<ProjectInfo, String> {
    let mut projects = read_recent_project_index_path(index_path)?;
    let Some(index) = projects.iter().position(|project| {
        project.id == request.project_id && project.path == request.previous_path
    }) else {
        return Err(relink_error(
            "UI-PROJECT-RELINK-CONFLICT",
            "原最近项目记录已经变化，未修改任何记录，请刷新后重试。",
            false,
        ));
    };

    let candidate = PathBuf::from(&request.candidate_path);
    let metadata = std::fs::symlink_metadata(&candidate).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            relink_error(
                "UI-PROJECT-RELINK-MISSING",
                "所选项目目录不存在，原记录未更改。",
                false,
            )
        } else {
            relink_error(
                "UI-PROJECT-RELINK-UNREADABLE",
                "暂时无法读取所选目录，原记录未更改。",
                false,
            )
        }
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(relink_error(
            "UI-PROJECT-RELINK-UNREADABLE",
            "所选位置不是可用的真实项目目录，原记录未更改。",
            false,
        ));
    }
    let manager = manager_for_project_dir(&candidate)?;
    let project = manager.open_project(&candidate).map_err(|_| {
        relink_error(
            "UI-PROJECT-RELINK-UNREADABLE",
            "所选目录中的项目数据无法读取，原记录未更改。",
            false,
        )
    })?;
    if project.id.to_string() != request.project_id {
        return Err(relink_error(
            "UI-PROJECT-RELINK-MISMATCH",
            "所选目录属于另一个项目，原记录未更改。",
            true,
        ));
    }

    let refreshed = project_info(&project, &candidate);
    projects[index] = refreshed.clone();
    install_recent_project_index(index_path, &projects)?;
    Ok(refreshed)
}

/// Remove a project from the recent-project index without touching project files.
#[tauri::command]
pub fn remove_recent_project(
    project_id: String,
    project_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _writer = state.inner().recent_index_write_guard();
    let requested = PathBuf::from(&project_path);
    {
        let inner = state
            .0
            .lock()
            .map_err(|_| "最近项目状态不可用，请重启应用后重试。".to_string())?;
        if inner.active_pipeline.as_ref().is_some_and(|active| {
            active.project_id == project_id
                || paths_refer_to_same_project(&requested, &active.project_dir)
        }) {
            return Err("运行中的项目不能从列表移除，请先安全取消重建。".into());
        }
    }

    let mut projects = read_recent_project_index(&app_handle)?;
    projects.retain(|project| project.id != project_id && project.path != project_path);
    write_recent_project_index(&app_handle, &projects)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "最近项目状态不可用，请重启应用后重试。".to_string())?;
    inner.recent_projects = projects;
    if inner
        .project_dir
        .as_ref()
        .is_some_and(|current| paths_refer_to_same_project(current, &requested))
    {
        inner.project_dir = None;
    }
    Ok(())
}

/// Permanently delete a validated MetOrigin project directory.
#[tauri::command]
pub fn delete_project(
    request: DeleteProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteProjectResult, String> {
    delete_project_inner(request, &app_handle, state.inner())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectAvailabilityResult {
    project_id: String,
    checked_path: String,
    availability: String,
    checked_at: String,
    reason_code: Option<String>,
    refreshed_project: Option<ProjectInfo>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkRecentProjectRequest {
    project_id: String,
    previous_path: String,
    candidate_path: String,
}

pub(crate) fn delete_project_inner(
    request: DeleteProjectRequest,
    app_handle: &tauri::AppHandle,
    state: &AppState,
) -> Result<DeleteProjectResult, String> {
    let _writer = state.recent_index_write_guard();
    let requested = PathBuf::from(&request.project_path);
    {
        let inner = state
            .0
            .lock()
            .map_err(|_| "项目删除状态不可用，请重启应用后重试。".to_string())?;
        if inner.active_pipeline.as_ref().is_some_and(|active| {
            active.project_id == request.project_id
                || paths_refer_to_same_project(&requested, &active.project_dir)
        }) {
            return Err("运行中的项目不能永久删除，请先安全取消重建。".into());
        }
        if inner
            .active_creation
            .as_ref()
            .is_some_and(|creation| creation.id == request.project_id)
        {
            return Err("项目仍在创建中，请先取消创建后再删除。".into());
        }
    }

    match std::fs::symlink_metadata(&requested) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return remove_missing_project_record(&request, app_handle, state);
        }
        Err(_) => return Err("项目目录无法访问，请检查磁盘或目录权限。".into()),
        Ok(_) => {}
    }

    let (project_dir, project) = validate_delete_request(&request)?;

    let parent = project_dir
        .parent()
        .ok_or_else(|| "项目目录没有有效的父目录，已拒绝删除。".to_string())?;
    let file_name = project_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "项目目录名称无效，已拒绝删除。".to_string())?;
    let tombstone = parent.join(format!(".{file_name}.deleting-{}", project.id));
    if tombstone.exists() {
        return Err("项目删除临时目录已存在，请先检查磁盘状态。".into());
    }
    let original_projects = read_recent_project_index(app_handle)?;
    let mut projects = original_projects.clone();
    projects.retain(|item| item.id != request.project_id && item.path != request.project_path);
    let removed_from_recent = projects.len() != original_projects.len();

    std::fs::rename(&project_dir, &tombstone)
        .map_err(|_| "无法锁定项目目录进行删除，请关闭占用该目录的程序后重试。".to_string())?;
    if let Err(error) = write_recent_project_index(app_handle, &projects) {
        let _ = std::fs::rename(&tombstone, &project_dir);
        return Err(error);
    }
    if let Err(error) = std::fs::remove_dir_all(&tombstone) {
        let _ = write_recent_project_index(app_handle, &original_projects);
        let _ = std::fs::rename(&tombstone, &project_dir);
        return Err(format!("删除项目文件失败，已尝试恢复原目录：{error}"));
    }

    let mut inner = state
        .0
        .lock()
        .map_err(|_| "项目已删除，但应用状态刷新失败，请重启应用。".to_string())?;
    inner.recent_projects = projects;
    if inner
        .project_dir
        .as_ref()
        .is_some_and(|current| paths_refer_to_same_project(current, &project_dir))
    {
        inner.project_dir = None;
    }

    Ok(DeleteProjectResult {
        project_id: request.project_id,
        deleted_path: project_dir.to_string_lossy().to_string(),
        removed_from_recent,
    })
}

/// A missing directory has no files left to delete. Only remove the stale
/// recent-project entry when both its persisted ID and path still match the
/// request, so a forged request cannot clean unrelated history.
fn remove_missing_project_record(
    request: &DeleteProjectRequest,
    app_handle: &tauri::AppHandle,
    state: &AppState,
) -> Result<DeleteProjectResult, String> {
    let original_projects = read_recent_project_index(app_handle)?;
    if !original_projects
        .iter()
        .any(|project| project.id == request.project_id && project.path == request.project_path)
    {
        return Err("项目目录已不存在，且最近项目记录已发生变化，请刷新后重试。".into());
    }
    let mut projects = original_projects;
    remove_recent_entries(&mut projects, &request.project_id, &request.project_path);
    write_recent_project_index(app_handle, &projects)?;

    let requested = PathBuf::from(&request.project_path);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "最近项目已清理，但应用状态刷新失败，请重启应用。".to_string())?;
    inner.recent_projects = projects;
    if inner
        .project_dir
        .as_ref()
        .is_some_and(|current| paths_refer_to_same_project(current, &requested))
    {
        inner.project_dir = None;
    }

    Ok(DeleteProjectResult {
        project_id: request.project_id.clone(),
        deleted_path: request.project_path.clone(),
        removed_from_recent: true,
    })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

fn validate_delete_request(request: &DeleteProjectRequest) -> Result<(PathBuf, Project), String> {
    let requested = PathBuf::from(&request.project_path);
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "项目目录不存在或无法访问。".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("只允许删除真实的 MetOrigin 项目目录。".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|_| "无法解析项目目录，已拒绝删除。".to_string())?;
    validate_safe_delete_root(&canonical)?;
    if !canonical.join("project.json").is_file() {
        return Err("目标目录不是有效的 MetOrigin 项目。".into());
    }
    let manager = ProjectManager::new(
        canonical
            .parent()
            .ok_or_else(|| "项目目录无效。".to_string())?
            .to_path_buf(),
    );
    let project = manager
        .open_project(&canonical)
        .map_err(|error| error.user_message_zh())?;
    if project.id.to_string() != request.project_id {
        return Err("项目身份校验失败，已拒绝删除。".into());
    }
    Ok((canonical, project))
}

fn validate_safe_delete_root(path: &Path) -> Result<(), String> {
    if path.parent().is_none() {
        return Err("禁止删除磁盘根目录。".into());
    }
    for protected in [dirs_next::home_dir(), dirs_next::document_dir()]
        .into_iter()
        .flatten()
    {
        if protected.canonicalize().ok().as_deref() == Some(path) {
            return Err("禁止删除系统用户目录。".into());
        }
    }
    if let Ok(workspace) = std::env::current_dir().and_then(|path| path.canonicalize()) {
        if workspace == path || workspace.starts_with(path) {
            return Err("禁止删除应用工作区或其上级目录。".into());
        }
    }
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    if let Ok(repository_root) = repository_root.canonicalize() {
        if repository_root == path || repository_root.starts_with(path) {
            return Err("禁止删除应用仓库或其上级目录。".into());
        }
    }
    Ok(())
}

fn paths_refer_to_same_project(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn remove_recent_entries(projects: &mut Vec<ProjectInfo>, project_id: &str, project_path: &str) {
    projects.retain(|project| project.id != project_id && project.path != project_path);
}

fn default_projects_dir() -> PathBuf {
    dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetOrigin Projects")
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("所选素材")
        .to_string()
}

fn preset_files() -> Result<Vec<PresetFile>, String> {
    [
        include_str!("../../../../../presets/fast.json"),
        include_str!("../../../../../presets/balanced.json"),
        include_str!("../../../../../presets/quality.json"),
    ]
    .into_iter()
    .map(|json| {
        serde_json::from_str(json).map_err(|_| "内置质量预设损坏，请重新安装应用。".to_string())
    })
    .collect()
}

fn preset_estimates(
    video: Option<&splat_engine_ffmpeg::probe::VideoMetadata>,
    image_count: Option<usize>,
) -> Result<Vec<PresetEstimate>, String> {
    preset_files()?
        .into_iter()
        .map(|preset| {
            let estimated_frames = if let Some(video) = video {
                ((video.duration_seconds * preset.frame_extraction.fps).floor() as u64)
                    .min(preset.frame_extraction.max_frames as u64)
            } else {
                image_count
                    .unwrap_or(0)
                    .min(preset.frame_extraction.max_frames as usize) as u64
            };
            let bytes_per_frame = match preset.frame_extraction.target_long_edge {
                0..=1280 => 320_000,
                1281..=1920 => 700_000,
                _ => 1_200_000,
            };
            let colmap_long_edge = if preset.frame_extraction.colmap_long_edge > 0 {
                preset.frame_extraction.colmap_long_edge
            } else {
                preset.frame_extraction.target_long_edge
            };
            let colmap_bytes_per_frame = match colmap_long_edge {
                0..=1280 => 320_000,
                1281..=1920 => 700_000,
                1921..=2560 => 1_200_000,
                _ => 2_400_000,
            };
            let checkpoint_interval = splat_engine_brush::TrainingConfig::from_builtin(&preset.id)
                .map(|config| config.checkpoint_interval)
                .map_err(|error| error.user_message_zh())?;
            Ok(PresetEstimate {
                id: preset.id,
                name: preset.name,
                description: preset.description,
                fps: preset.frame_extraction.fps,
                max_frames: preset.frame_extraction.max_frames,
                target_long_edge: preset.frame_extraction.target_long_edge,
                colmap_long_edge,
                iterations: preset.training.iterations,
                sh_degree: preset.training.sh_degree,
                checkpoint_interval,
                estimated_frames,
                // Reconstruction frames, undistorted Brush images and one
                // additional temporary candidate model are budgeted here.
                estimated_disk_bytes: estimated_frames
                    .saturating_mul(colmap_bytes_per_frame)
                    .saturating_add(estimated_frames.saturating_mul(bytes_per_frame))
                    .saturating_mul(2),
            })
        })
        .collect()
}

fn image_set_metadata(scan: &splat_pipeline::image_input::ImageScan) -> ImageSetMetadata {
    let mut formats = std::collections::BTreeMap::new();
    for image in &scan.images {
        *formats.entry(image.format.clone()).or_insert(0) += 1;
    }
    ImageSetMetadata {
        image_count: scan.images.len(),
        ignored_count: scan.ignored_count,
        invalid_count: scan.invalid_items.len(),
        total_size_bytes: scan.images.iter().map(|image| image.size_bytes).sum(),
        formats,
    }
}

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn check_nvidia_runtime() -> EngineCheck {
    match splat_engine_brush::require_nvidia_smi() {
        Ok(info) => EngineCheck {
            name: "NVIDIA GPU / 驱动".into(),
            available: true,
            path: Some("nvidia-smi".into()),
            expected_version: None,
            actual_version: Some(info.driver_version.clone()),
            diagnostic: Some(info.summary()),
            source: Some("system".into()),
            integrity_status: None,
        },
        Err(error) => EngineCheck {
            name: "NVIDIA GPU / 驱动".into(),
            available: false,
            path: Some("nvidia-smi".into()),
            expected_version: None,
            actual_version: None,
            diagnostic: Some(error.user_message_zh()),
            source: Some("system".into()),
            integrity_status: None,
        },
    }
}

fn validate_project_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请输入项目名称。".into());
    }
    if name.len() > 80
        || name.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
    {
        return Err("项目名称包含 Windows 不支持的字符或长度超过 80。".into());
    }
    Ok(())
}

fn create_project_transaction(
    mut project: Project,
    request: CreateProjectRequest,
    app_handle: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<(Project, PathBuf), String> {
    let project_root = request
        .project_root
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_dir);
    std::fs::create_dir_all(&project_root)
        .map_err(|_| "创建项目根目录失败，请检查访问权限。".to_string())?;
    let safe_name = request.name.trim();
    let final_dir = project_root.join(format!("{safe_name}.splat-project"));
    let creating_dir = project_root.join(format!("{safe_name}.splat-project.creating"));
    if final_dir.exists() || creating_dir.exists() {
        return Err("同名项目或未完成创建目录已经存在，请更换名称或清理旧目录。".into());
    }

    let result = (|| -> Result<(Project, PathBuf), String> {
        paths::create_project_directories(&creating_dir)
            .map_err(|_| "创建项目目录失败，请检查目标目录权限。".to_string())?;
        let manager = ProjectManager::new(project_root.clone());
        project.status = ProjectStatus::Creating;
        manager
            .save_project(&project, &creating_dir)
            .map_err(|error| error.user_message_zh())?;

        let source = PathBuf::from(&request.source_path);
        let imported_source = copy_source_media(
            &source,
            &creating_dir.join("source"),
            &app_handle,
            &project.id.to_string(),
            &cancel,
        )?;
        if cancel.load(Ordering::SeqCst) {
            return Err("项目创建已取消，未完成目录已清理。".into());
        }

        let preset = preset_files()?
            .into_iter()
            .find(|preset| preset.id == request.preset)
            .ok_or_else(|| "所选质量预设无效。".to_string())?;
        project.source = Some(imported_source);
        project.settings.preset = preset.id;
        project.settings.max_frames = preset.frame_extraction.max_frames;
        project.settings.max_long_edge = preset.frame_extraction.target_long_edge;
        project.settings.colmap_max_long_edge = if preset.frame_extraction.colmap_long_edge > 0 {
            preset.frame_extraction.colmap_long_edge
        } else {
            preset.frame_extraction.target_long_edge
        };
        project.status = ProjectStatus::Ready;
        project.touch();
        manager
            .save_project(&project, &creating_dir)
            .map_err(|error| error.user_message_zh())?;
        std::fs::rename(&creating_dir, &final_dir)
            .map_err(|_| "完成项目创建失败，请确认目标目录未被占用。".to_string())?;
        let _ = app_handle.emit(
            "project://copy-progress",
            serde_json::json!({
                "project_id": project.id.to_string(),
                "copied_bytes": project_source_size(&final_dir.join("source")),
                "total_bytes": project_source_size(&final_dir.join("source")),
                "percent": 1.0,
                "completed": true,
            }),
        );
        Ok((project, final_dir))
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&creating_dir);
    }
    result
}

fn copy_source_media(
    source: &Path,
    destination: &Path,
    app_handle: &tauri::AppHandle,
    project_id: &str,
    cancel: &AtomicBool,
) -> Result<ProjectSource, String> {
    if source.is_file() {
        let filename = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "所选视频文件名无效，请重新选择。".to_string())?
            .to_string();
        copy_file_with_progress(
            source,
            &destination.join(&filename),
            app_handle,
            project_id,
            0,
            std::fs::metadata(source)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            cancel,
        )?;
        return Ok(ProjectSource::Video(VideoSource {
            filename,
            copied_to_project: true,
        }));
    }
    if !source.is_dir() {
        return Err("所选素材不存在，请重新选择。".into());
    }
    let scan = scan_image_directory(source).map_err(|error| error.user_message_zh())?;
    if scan.images.len() < 3 {
        return Err("所选文件夹中不足 3 张可读取的 JPG、JPEG 或 PNG 图片。".into());
    }
    let total = scan.images.iter().map(|image| image.size_bytes).sum();
    let mut copied = 0;
    for image in &scan.images {
        let length = image.size_bytes;
        copy_file_with_progress(
            &image.path,
            &destination.join(Path::new(&image.relative_path)),
            app_handle,
            project_id,
            copied,
            total,
            cancel,
        )?;
        copied += length;
    }
    Ok(ProjectSource::ImageFolder(ImageFolderSource {
        folder_name: display_name(source),
        image_count: scan.images.len(),
        copied_to_project: true,
    }))
}

#[allow(clippy::too_many_arguments)]
fn copy_file_with_progress(
    source: &Path,
    destination: &Path,
    app_handle: &tauri::AppHandle,
    project_id: &str,
    copied_before: u64,
    total_bytes: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "创建项目素材子目录失败，请检查目标目录权限。".to_string())?;
    }
    let mut input =
        File::open(source).map_err(|_| "读取源媒体失败，请检查文件访问权限。".to_string())?;
    let mut output = File::create(destination)
        .map_err(|_| "写入项目素材失败，请检查目标目录权限。".to_string())?;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    let mut copied = 0_u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("项目创建已取消，未完成目录已清理。".into());
        }
        let read = input
            .read(&mut buffer)
            .map_err(|_| "读取源媒体时发生错误。".to_string())?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "复制素材时写入失败，请检查磁盘空间。".to_string())?;
        copied += read as u64;
        let aggregate = copied_before.saturating_add(copied);
        let percent = if total_bytes == 0 {
            0.0
        } else {
            aggregate as f64 / total_bytes as f64
        };
        let _ = app_handle.emit(
            "project://copy-progress",
            serde_json::json!({
                "project_id": project_id,
                "copied_bytes": aggregate,
                "total_bytes": total_bytes,
                "percent": percent.min(1.0),
                "completed": false,
            }),
        );
    }
    output
        .flush()
        .map_err(|_| "保存复制的素材失败。".to_string())?;
    let source_size = std::fs::metadata(source)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let destination_size = std::fs::metadata(destination)
        .map(|metadata| metadata.len())
        .unwrap_or(u64::MAX);
    if source_size != destination_size {
        return Err("复制素材校验失败，目标文件大小不一致。".into());
    }
    Ok(())
}

fn project_source_size(path: &Path) -> u64 {
    if let Ok(scan) = scan_image_directory(path) {
        if !scan.images.is_empty() {
            return scan.images.iter().map(|image| image.size_bytes).sum();
        }
    }
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn detect_copied_source(source_dir: &std::path::Path) -> Option<ProjectSource> {
    let entries = std::fs::read_dir(source_dir).ok()?;
    let mut video_filename = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if matches!(extension.as_str(), "mp4" | "mov" | "avi" | "mkv") {
            video_filename = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
        }
    }

    if let Some(filename) = video_filename {
        return Some(ProjectSource::Video(VideoSource {
            filename,
            copied_to_project: true,
        }));
    }
    let image_count = scan_image_directory(source_dir).ok()?.images.len();
    (image_count > 0).then(|| {
        ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: source_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("图片素材")
                .to_string(),
            image_count,
            copied_to_project: true,
        })
    })
}

fn project_info(
    project: &splat_domain::project::Project,
    project_dir: &std::path::Path,
) -> ProjectInfo {
    ProjectInfo {
        id: project.id.to_string(),
        name: project.name.clone(),
        path: project_dir.to_string_lossy().to_string(),
        status: project.status.to_string(),
        updated_at: project.updated_at.to_rfc3339(),
        stage_label: project.current_stage.clone(),
    }
}

fn manager_for_project_dir(project_dir: &Path) -> Result<ProjectManager, String> {
    let parent = project_dir
        .parent()
        .ok_or_else(|| "项目目录没有有效父目录。".to_string())?;
    Ok(ProjectManager::new(parent.to_path_buf()))
}

fn availability_result(
    project_id: String,
    checked_path: String,
    availability: &str,
    reason_code: Option<&str>,
    refreshed_project: Option<ProjectInfo>,
) -> ProjectAvailabilityResult {
    ProjectAvailabilityResult {
        project_id,
        checked_path,
        availability: availability.into(),
        checked_at: Utc::now().to_rfc3339(),
        reason_code: reason_code.map(str::to_string),
        refreshed_project,
    }
}

fn not_found_is_confirmed(path: &Path) -> bool {
    let mut ancestor = path.parent();
    while let Some(candidate) = ancestor {
        match std::fs::metadata(candidate) {
            Ok(metadata) => return metadata.is_dir(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = candidate.parent();
            }
            Err(_) => return false,
        }
    }
    false
}

fn probe_recent_project(project_id: String, project_path: String) -> ProjectAvailabilityResult {
    let project_dir = PathBuf::from(&project_path);
    let metadata = match std::fs::symlink_metadata(&project_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let (availability, reason) = if not_found_is_confirmed(&project_dir) {
                ("missing", "UI-PROJECT-PATH-MISSING")
            } else {
                ("check_failed", "UI-PROJECT-PATH-UNAVAILABLE")
            };
            return availability_result(project_id, project_path, availability, Some(reason), None);
        }
        Err(error) => {
            let reason = if error.kind() == std::io::ErrorKind::PermissionDenied {
                "UI-PROJECT-PATH-PERMISSION"
            } else {
                "UI-PROJECT-PATH-IO"
            };
            return availability_result(
                project_id,
                project_path,
                "check_failed",
                Some(reason),
                None,
            );
        }
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return availability_result(
            project_id,
            project_path,
            "unreadable",
            Some("UI-PROJECT-PATH-NOT-DIRECTORY"),
            None,
        );
    }

    let project_json = project_dir.join("project.json");
    let content = match std::fs::read_to_string(&project_json) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return availability_result(
                project_id,
                project_path,
                "unreadable",
                Some("UI-PROJECT-DATA-MISSING"),
                None,
            );
        }
        Err(error) => {
            let reason = if error.kind() == std::io::ErrorKind::PermissionDenied {
                "UI-PROJECT-DATA-PERMISSION"
            } else {
                "UI-PROJECT-DATA-IO"
            };
            return availability_result(
                project_id,
                project_path,
                "check_failed",
                Some(reason),
                None,
            );
        }
    };
    let project: Project = match serde_json::from_str(&content) {
        Ok(project) => project,
        Err(_) => {
            return availability_result(
                project_id,
                project_path,
                "unreadable",
                Some("UI-PROJECT-DATA-INVALID"),
                None,
            );
        }
    };
    if project.id.to_string() != project_id {
        return availability_result(
            project_id,
            project_path,
            "unreadable",
            Some("UI-PROJECT-ID-MISMATCH"),
            None,
        );
    }
    let refreshed = project_info(&project, &project_dir);
    availability_result(project_id, project_path, "available", None, Some(refreshed))
}

fn relink_error(code: &str, message: &str, can_open_independently: bool) -> String {
    serde_json::json!({
        "code": code,
        "message": message,
        "retryable": code != "UI-PROJECT-RELINK-MISMATCH",
        "can_open_independently": can_open_independently,
    })
    .to_string()
}

fn record_recent_project(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    project: ProjectInfo,
    selected_dir: Option<PathBuf>,
) -> Result<(), String> {
    let _writer = state.recent_index_write_guard();
    let mut projects = read_recent_project_index(app_handle)?;
    projects.retain(|existing| existing.id != project.id && existing.path != project.path);
    projects.insert(0, project);
    projects.truncate(50);
    write_recent_project_index(app_handle, &projects)?;

    let mut inner = state
        .0
        .lock()
        .map_err(|_| "保存最近项目失败，请重启应用后重试。".to_string())?;
    inner.recent_projects = projects;
    if let Some(project_dir) = selected_dir {
        inner.project_dir = Some(project_dir);
    }
    Ok(())
}

fn recent_project_index_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_config_dir()
        .map(|directory| directory.join("recent-projects.json"))
        .map_err(|_| "无法定位应用配置目录，请检查系统目录权限。".to_string())
}

fn read_recent_project_index(app_handle: &tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let path = recent_project_index_path(app_handle)?;
    read_recent_project_index_path(&path)
}

fn write_recent_project_index(
    app_handle: &tauri::AppHandle,
    projects: &[ProjectInfo],
) -> Result<(), String> {
    let path = recent_project_index_path(app_handle)?;
    install_recent_project_index(&path, projects)
}

fn index_temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.installing")
}

fn index_recovery_path(path: &Path) -> PathBuf {
    path.with_extension("json.recovery")
}

fn parse_recent_project_index(path: &Path) -> Result<Vec<ProjectInfo>, std::io::Error> {
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

fn replace_index_file(source: &Path, destination: &Path) -> Result<(), String> {
    match std::fs::remove_file(destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("恢复最近项目索引失败，请检查应用配置目录权限。".into()),
    }
    std::fs::rename(source, destination)
        .map_err(|_| "恢复最近项目索引失败，请检查应用配置目录权限。".to_string())
}

fn read_recent_project_index_path(path: &Path) -> Result<Vec<ProjectInfo>, String> {
    match parse_recent_project_index(path) {
        Ok(projects) => {
            let _ = std::fs::remove_file(index_temporary_path(path));
            let _ = std::fs::remove_file(index_recovery_path(path));
            return Ok(projects);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {}
    }

    let recovery = index_recovery_path(path);
    if let Ok(projects) = parse_recent_project_index(&recovery) {
        replace_index_file(&recovery, path)?;
        let _ = std::fs::remove_file(index_temporary_path(path));
        return Ok(projects);
    }
    let temporary = index_temporary_path(path);
    if let Ok(projects) = parse_recent_project_index(&temporary) {
        replace_index_file(&temporary, path)?;
        return Ok(projects);
    }

    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        _ => Err("最近项目索引已损坏，且没有可用的恢复副本。".into()),
    }
}

fn install_recent_project_index(path: &Path, projects: &[ProjectInfo]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "应用配置目录无效。".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "创建应用配置目录失败，请检查目录权限。".to_string())?;
    let content =
        serde_json::to_vec_pretty(projects).map_err(|_| "序列化最近项目索引失败。".to_string())?;
    let temporary = index_temporary_path(path);
    let recovery = index_recovery_path(path);
    let mut file = File::create(&temporary)
        .map_err(|_| "写入最近项目索引失败，请检查目录权限。".to_string())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| "写入最近项目索引失败，请检查目录权限。".to_string())?;
    drop(file);
    let staged = parse_recent_project_index(&temporary)
        .map_err(|_| "校验新的最近项目索引失败，原索引未更改。".to_string())?;
    if staged != projects {
        let _ = std::fs::remove_file(&temporary);
        return Err("校验新的最近项目索引失败，原索引未更改。".into());
    }

    let had_original = match std::fs::metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("读取最近项目索引状态失败，请检查目录权限。".into()),
    };
    let _ = std::fs::remove_file(&recovery);
    if had_original {
        std::fs::rename(path, &recovery)
            .map_err(|_| "备份最近项目索引失败，原索引未更改。".to_string())?;
    }
    if std::fs::rename(&temporary, path).is_err() {
        if had_original {
            let _ = std::fs::rename(&recovery, path);
        }
        return Err("安装最近项目索引失败，已保留原索引。".into());
    }
    match parse_recent_project_index(path) {
        Ok(installed) if installed == projects => {
            let _ = std::fs::remove_file(&recovery);
            Ok(())
        }
        _ => {
            let _ = std::fs::remove_file(path);
            if had_original {
                let _ = std::fs::rename(&recovery, path);
            }
            Err("安装后的最近项目索引校验失败，已回滚。".into())
        }
    }
}

fn refresh_recent_projects(projects: &mut [ProjectInfo]) {
    for info in projects {
        let project_dir = PathBuf::from(&info.path);
        if !project_dir.join("project.json").exists() {
            continue;
        }
        let manager =
            ProjectManager::new(project_dir.parent().unwrap_or(&project_dir).to_path_buf());
        if let Ok(project) = manager.open_project(&project_dir) {
            *info = project_info(&project, &project_dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "metorigin-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn delete_validation_requires_matching_project_identity() {
        let root = temporary_test_root("delete-validation");
        let project_dir = root.join("bike.splat-project");
        paths::create_project_directories(&project_dir).unwrap();
        let project = Project::new("自行车");
        ProjectManager::new(root.clone())
            .save_project(&project, &project_dir)
            .unwrap();

        let request = DeleteProjectRequest {
            project_id: project.id.to_string(),
            project_path: project_dir.to_string_lossy().to_string(),
        };
        assert!(validate_delete_request(&request).is_ok());

        let mut wrong_id = request;
        wrong_id.project_id = splat_domain::project::ProjectId::new().to_string();
        assert!(validate_delete_request(&wrong_id).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_validation_rejects_non_project_directory() {
        let root = temporary_test_root("delete-non-project");
        std::fs::create_dir_all(&root).unwrap();
        let request = DeleteProjectRequest {
            project_id: "not-a-project".into(),
            project_path: root.to_string_lossy().to_string(),
        };
        assert!(validate_delete_request(&request).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_validation_rejects_repository_root() {
        let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        assert!(validate_safe_delete_root(&repository_root).is_err());
    }

    #[test]
    fn stale_recent_project_cleanup_removes_matching_identity_or_path() {
        let mut projects = vec![
            ProjectInfo {
                id: "stale-id".into(),
                name: "失效项目".into(),
                path: r"D:\missing\stale.splat-project".into(),
                status: "ready".into(),
                updated_at: "2026-07-14T00:00:00Z".into(),
                stage_label: None,
            },
            ProjectInfo {
                id: "valid-id".into(),
                name: "保留项目".into(),
                path: r"D:\projects\valid.splat-project".into(),
                status: "completed".into(),
                updated_at: "2026-07-14T00:00:00Z".into(),
                stage_label: None,
            },
        ];
        remove_recent_entries(&mut projects, "stale-id", r"D:\missing\stale.splat-project");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "valid-id");
    }

    #[test]
    fn recovers_video_source_from_copied_media() {
        let project_dir =
            std::env::temp_dir().join(format!("metorigin-source-recovery-{}", std::process::id()));
        let source_dir = project_dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(source_dir.join("bike.MP4"), b"test").unwrap();

        let recovered = detect_copied_source(&source_dir).unwrap();
        match recovered {
            ProjectSource::Video(video) => {
                assert_eq!(video.filename, "bike.MP4");
                assert!(video.copied_to_project);
            }
            ProjectSource::ImageFolder(_) => panic!("expected video source"),
        }

        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[test]
    fn controlled_previews_support_nested_images_and_return_data_urls() {
        let root = temporary_test_root("image-previews");
        let nested = root.join("中文").join("same-name");
        std::fs::create_dir_all(&nested).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
        std::fs::copy(&fixture, root.join("FIRST.PNG")).unwrap();
        std::fs::copy(&fixture, nested.join("FIRST.PNG")).unwrap();
        std::fs::copy(&fixture, nested.join("third.png")).unwrap();

        let previews = get_image_previews(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(previews.len(), 3);
        assert!(previews
            .iter()
            .all(|preview| preview.data_url.starts_with("data:image/jpeg;base64,")));
        assert!(previews
            .iter()
            .any(|preview| preview.relative_path == "中文/same-name/FIRST.PNG"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovers_nested_image_source_from_copied_media() {
        let root = temporary_test_root("nested-source-recovery");
        let nested = root.join("source/子目录");
        std::fs::create_dir_all(&nested).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
        for index in 0..3 {
            std::fs::copy(&fixture, nested.join(format!("IMAGE_{index}.PNG"))).unwrap();
        }
        let recovered = detect_copied_source(&root.join("source")).unwrap();
        assert!(matches!(
            recovered,
            ProjectSource::ImageFolder(ImageFolderSource { image_count: 3, .. })
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fast_preset_estimates_266_frames_for_test_video_metadata() {
        let metadata = splat_engine_ffmpeg::probe::VideoMetadata {
            width: 3840,
            height: 2160,
            fps: 30_000.0 / 1001.0,
            frame_count: 3990,
            duration_seconds: 133.133,
            codec: "h264".into(),
            rotation: None,
        };
        let estimates = preset_estimates(Some(&metadata), None).unwrap();
        let fast = estimates.iter().find(|preset| preset.id == "fast").unwrap();
        assert_eq!(fast.estimated_frames, 266);
        assert_eq!(fast.target_long_edge, 1280);
        assert_eq!(fast.iterations, 3000);
    }

    #[test]
    fn project_name_validation_blocks_windows_reserved_characters() {
        assert!(validate_project_name("自行车街景测试").is_ok());
        assert!(validate_project_name("bad:name").is_err());
        assert!(validate_project_name("").is_err());
    }

    #[test]
    fn disk_space_preflight_reports_only_real_shortfalls() {
        assert!(disk_space_blocker(20, 10).is_none());
        assert!(disk_space_blocker(10, 10).is_none());
        assert!(disk_space_blocker(0, 10).is_none());
        let blocker = disk_space_blocker(5, 10).unwrap();
        assert!(blocker.contains("磁盘空间不足"));
    }

    fn recent_info(id: &str, path: &Path) -> ProjectInfo {
        ProjectInfo {
            id: id.into(),
            name: format!("项目 {id}"),
            path: path.to_string_lossy().to_string(),
            status: "ready".into(),
            updated_at: "2026-08-14T00:00:00Z".into(),
            stage_label: None,
        }
    }

    #[test]
    fn fast_index_read_does_not_require_project_paths() {
        let root = temporary_test_root("fast-index");
        let index = root.join("recent-projects.json");
        let unreachable = root.join("detached-volume/project.splat-project");
        let expected = vec![recent_info("detached", &unreachable)];
        install_recent_project_index(&index, &expected).unwrap();

        let loaded = read_recent_project_index_path(&index).unwrap();
        assert_eq!(loaded, expected);
        assert!(!unreachable.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn availability_probe_classifies_matching_missing_unreadable_and_failed_without_writes() {
        let root = temporary_test_root("availability");
        let project_dir = root.join("valid.splat-project");
        paths::create_project_directories(&project_dir).unwrap();
        let project = Project::new("可用项目");
        ProjectManager::new(root.clone())
            .save_project(&project, &project_dir)
            .unwrap();
        let index = root.join("recent-projects.json");
        let indexed = vec![recent_info(&project.id.to_string(), &project_dir)];
        install_recent_project_index(&index, &indexed).unwrap();
        let before = std::fs::read(&index).unwrap();

        let available = probe_recent_project(
            project.id.to_string(),
            project_dir.to_string_lossy().to_string(),
        );
        assert_eq!(available.availability, "available");
        let refreshed = available
            .refreshed_project
            .expect("available must refresh metadata");
        assert_eq!(refreshed.id, project.id.to_string());
        assert_eq!(refreshed.path, project_dir.to_string_lossy());

        let missing_dir = root.join("missing.splat-project");
        let missing = probe_recent_project("missing".into(), missing_dir.to_string_lossy().into());
        assert_eq!(missing.availability, "missing");
        assert!(missing.refreshed_project.is_none());

        let unreadable_dir = root.join("invalid.splat-project");
        std::fs::create_dir_all(&unreadable_dir).unwrap();
        let unreadable =
            probe_recent_project("invalid".into(), unreadable_dir.to_string_lossy().into());
        assert_eq!(unreadable.availability, "unreadable");

        let failed = probe_recent_project("invalid-input".into(), "bad\0path".into());
        assert_eq!(failed.availability, "check_failed");
        assert_eq!(std::fs::read(&index).unwrap(), before);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn index_install_is_validated_and_startup_recovers_backup_or_staged_copy() {
        let root = temporary_test_root("index-recovery");
        let index = root.join("recent-projects.json");
        let first = vec![recent_info("first", &root.join("first.splat-project"))];
        let second = vec![recent_info("second", &root.join("second.splat-project"))];
        install_recent_project_index(&index, &first).unwrap();
        install_recent_project_index(&index, &second).unwrap();
        assert_eq!(read_recent_project_index_path(&index).unwrap(), second);

        std::fs::write(&index, b"not-json").unwrap();
        install_recent_project_index(&index_recovery_path(&index), &first).unwrap();
        let recovered = read_recent_project_index_path(&index).unwrap();
        assert_eq!(recovered, first);
        assert_eq!(parse_recent_project_index(&index).unwrap(), first);

        std::fs::write(&index, b"still-not-json").unwrap();
        install_recent_project_index(&index_temporary_path(&index), &second).unwrap();
        let recovered_staged = read_recent_project_index_path(&index).unwrap();
        assert_eq!(recovered_staged, second);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn relink_requires_same_identity_and_preserves_index_on_mismatch_or_conflict() {
        let root = temporary_test_root("relink");
        let original_dir = root.join("original.splat-project");
        let matched_dir = root.join("matched.splat-project");
        let other_dir = root.join("other.splat-project");
        let project = Project::new("原项目");
        let other = Project::new("另一个项目");
        let manager = ProjectManager::new(root.clone());
        paths::create_project_directories(&original_dir).unwrap();
        paths::create_project_directories(&matched_dir).unwrap();
        paths::create_project_directories(&other_dir).unwrap();
        manager.save_project(&project, &original_dir).unwrap();
        manager.save_project(&project, &matched_dir).unwrap();
        manager.save_project(&other, &other_dir).unwrap();
        let index = root.join("recent-projects.json");
        install_recent_project_index(
            &index,
            &[recent_info(&project.id.to_string(), &original_dir)],
        )
        .unwrap();

        let mismatch_request = RelinkRecentProjectRequest {
            project_id: project.id.to_string(),
            previous_path: original_dir.to_string_lossy().into(),
            candidate_path: other_dir.to_string_lossy().into(),
        };
        let before = std::fs::read(&index).unwrap();
        let mismatch = relink_recent_project_path(&mismatch_request, &index).unwrap_err();
        assert!(mismatch.contains("UI-PROJECT-RELINK-MISMATCH"));
        assert_eq!(std::fs::read(&index).unwrap(), before);

        let conflict = RelinkRecentProjectRequest {
            previous_path: root.join("stale.splat-project").to_string_lossy().into(),
            ..mismatch_request.clone()
        };
        assert!(relink_recent_project_path(&conflict, &index)
            .unwrap_err()
            .contains("UI-PROJECT-RELINK-CONFLICT"));
        assert_eq!(std::fs::read(&index).unwrap(), before);

        let matched = RelinkRecentProjectRequest {
            candidate_path: matched_dir.to_string_lossy().into(),
            ..mismatch_request
        };
        let refreshed = relink_recent_project_path(&matched, &index).unwrap();
        assert_eq!(refreshed.id, project.id.to_string());
        assert_eq!(refreshed.path, matched_dir.to_string_lossy());
        assert_eq!(
            read_recent_project_index_path(&index).unwrap(),
            vec![refreshed]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_lock_serializes_mutations_recovers_after_panic_and_does_not_cover_probes() {
        let state = AppState::new();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut workers = Vec::new();
        for value in 0..12 {
            let state = state.clone();
            let shared = shared.clone();
            workers.push(std::thread::spawn(move || {
                let _writer = state.recent_index_write_guard();
                shared.lock().unwrap().push(value);
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(shared.lock().unwrap().len(), 12);

        let poison_state = state.clone();
        let _ = std::thread::spawn(move || {
            let _writer = poison_state.recent_index_write_guard();
            panic!("simulate failed mutation");
        })
        .join();
        drop(state.recent_index_write_guard());

        let held = state.recent_index_write_guard();
        let probe = probe_recent_project("probe".into(), "bad\0path".into());
        assert_eq!(probe.availability, "check_failed");
        drop(held);
    }
}
