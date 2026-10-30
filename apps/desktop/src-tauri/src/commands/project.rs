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

mod destination;

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
    effective_training: Option<splat_domain::runtime::EffectiveTraining>,
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
    pub(crate) files_deleted: bool,
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
    let _pending_work =
        crate::lifecycle::PendingWork::begin(app_handle.state::<AppState>().inner())?;
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

        let probe_pending =
            crate::lifecycle::PendingWork::begin(app_handle.state::<AppState>().inner())?;
        let probe_path = path.clone();
        let probe = tokio::spawn(async move {
            let _pending = probe_pending;
            splat_engine_ffmpeg::probe::probe_video_with_async(
                &ffprobe,
                &probe_path,
                tokio_util::sync::CancellationToken::new(),
            )
            .await
        })
        .await
        .map_err(|_| "素材检查后台任务异常终止，请重试。".to_string())?;
        match probe {
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
    let _pending_work = crate::lifecycle::PendingWork::begin(state.inner())?;
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
    let destination_check = destination::check_project_destination(&root);
    let available_disk_bytes = destination_check
        .as_ref()
        .ok()
        .and_then(|path| fs2::available_space(path).ok())
        .unwrap_or(0);
    let include_ffmpeg = analysis.source_kind == "video" || cfg!(target_os = "macos");
    let check_handle = app_handle.clone();
    let mut engine_checks = tokio::task::spawn_blocking(move || {
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
        Ok::<_, String>(checks)
    })
    .await
    .map_err(|error| format!("引擎检查任务异常结束，请重试：{error}"))??;
    let selected = analysis
        .preset_estimates
        .iter()
        .find(|preset| preset.id == request.preset);
    let engine_paths = crate::commands::system::resolve_engine_paths(app_handle);
    let runtime = crate::commands::runtime::check_training_runtime(app_handle, &engine_paths).await;
    engine_checks.push(training_runtime_check(&runtime));
    let frozen = if let (Ok(runtime), Some(selected)) = (&runtime, selected) {
        crate::commands::runtime::execution_profile(
            state,
            engine_paths,
            request.preset.clone(),
            selected.target_long_edge,
            runtime,
        )
        .await
    } else {
        Ok(None)
    };
    let estimated_frames = selected.map(|preset| preset.estimated_frames).unwrap_or(0);
    let estimated_disk_bytes = selected
        .map(|preset| preset.estimated_disk_bytes)
        .unwrap_or(0)
        .saturating_add(analysis.size_bytes)
        .saturating_add(5 * 1024 * 1024 * 1024);
    let mut blockers = analysis.blockers;
    let mut warnings = analysis.warnings;
    let effective_training = match frozen {
        Ok(Some(profile)) => {
            let preview =
                if profile.live_protocol == splat_domain::runtime::LiveProtocol::PlyRequestAckV1 {
                    "支持实时预览"
                } else {
                    "使用检查点预览"
                };
            let training = profile.effective_training;
            warnings.push(format!(
                "本次 Mac 执行参数：{} 步，SH{}，训练长边 {} px，最多 {} 个高斯，图像缓存 {} MiB，{} 个加载线程；{preview}。",
                training.iterations, training.sh_degree, training.resolution.unwrap_or(0),
                training.max_splats.unwrap_or(0), training.image_cache_budget_bytes.unwrap_or(0) / (1024 * 1024), training.threads,
            ));
            Some(training)
        }
        Ok(None) => None,
        Err(error) => {
            blockers.push(error.user_message_zh());
            None
        }
    };
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
    if let Err(error) = destination_check {
        tracing::warn!(code = error.code(), path = %error.path.display(), source = %error.source,
            "Project destination preflight failed");
        blockers.push(error.user_message());
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
        effective_training,
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

/// The blocking importer may outlive its awaiting IPC future. Keep its owner
/// and pending-work slot until the worker itself exits, including panic unwind.
struct CreationCleanup {
    state: AppState,
    id: String,
}

impl Drop for CreationCleanup {
    fn drop(&mut self) {
        let mut inner = self
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner
            .active_creation
            .as_ref()
            .is_some_and(|active| active.id == self.id)
        {
            inner.active_creation = None;
        }
    }
}

/// Create a new project.
#[tauri::command]
pub async fn create_project(
    request: CreateProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CreateProjectResult, String> {
    let _pending_work = crate::lifecycle::PendingWork::begin(state.inner())?;
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
    let worker_pending = crate::lifecycle::PendingWork::begin(&app_state)?;
    {
        let mut inner = app_state
            .0
            .lock()
            .map_err(|_| "项目创建状态不可用，请重启应用后重试。".to_string())?;
        if inner.shutting_down {
            return Err("应用正在安全退出，请等待当前操作完成。".into());
        }
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
    let worker_cleanup = CreationCleanup {
        state: app_state.clone(),
        id: creation_id,
    };
    let result = tokio::task::spawn_blocking(move || {
        let _pending_work = worker_pending;
        let _cleanup = worker_cleanup;
        create_project_transaction(project, worker_request, worker_handle, cancel)
    })
    .await
    .map_err(|_| "项目创建后台任务异常终止，请重试。".to_string())?;

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
    let _pending = crate::lifecycle::PendingWork::begin(state.inner())?;
    let project_dir = PathBuf::from(&path);
    let default_dir = dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetOrigin Projects");
    let manager = ProjectManager::new(default_dir);
    // The current application's own live project may be viewed, but never
    // recovered or supplemented while the worker owns its state. Every other
    // open acquires the same admission lock used by start_pipeline.
    let (mut project, project_lock) =
        super::recovery::open_project_for_view(&manager, state.inner(), &project_dir)?;

    if project_lock.is_some() && project.source.is_none() {
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

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum DeleteProjectMode {
    Directory,
    MissingDirectory,
    MissingManifest,
    InvalidManifest,
}

pub(super) struct DeleteProjectTarget {
    pub project_dir: PathBuf,
    pub record: ProjectInfo,
    pub project: Option<Project>,
    pub mode: DeleteProjectMode,
    pub fingerprint: String,
    projects: Vec<ProjectInfo>,
}

impl DeleteProjectTarget {
    pub(super) fn record_only(&self) -> bool {
        !matches!(self.mode, DeleteProjectMode::Directory)
    }
}

fn deletion_error(code: &str, message: &str) -> String {
    serde_json::json!({ "code": code, "message": message, "retryable": false }).to_string()
}

pub(super) fn deletion_is_stale(error: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(error)
        .ok()
        .is_some_and(|value| value["code"] == "UI-ACTION-PREVIEW-STALE")
}

pub(super) fn delete_project_blocked_reason(
    request: &DeleteProjectRequest,
    state: &AppState,
) -> Result<Option<String>, String> {
    let inner = state
        .0
        .lock()
        .map_err(|_| "项目删除状态不可用，请重试。".to_string())?;
    Ok(delete_project_blocker(request, &inner).map(str::to_owned))
}

fn delete_project_blocker(
    request: &DeleteProjectRequest,
    inner: &crate::state::AppStateInner,
) -> Option<&'static str> {
    let requested = Path::new(&request.project_path);
    if inner.active_pipeline.as_ref().is_some_and(|active| {
        active.project_id == request.project_id
            || paths_refer_to_same_project(requested, &active.project_dir)
    }) {
        return Some("项目仍在处理，请先安全取消后再删除。");
    }
    if inner
        .active_creation
        .as_ref()
        .is_some_and(|creation| creation.id == request.project_id)
    {
        return Some("项目仍在创建中，请先取消创建后再删除。");
    }
    None
}

/// Classify deletion without opening/migrating a project or writing its directory.
/// Both preview and execution require the exact persisted index identity.
pub(super) fn inspect_delete_target(
    request: &DeleteProjectRequest,
    index_path: &Path,
) -> Result<DeleteProjectTarget, String> {
    let projects = read_recent_project_index_path(index_path)?;
    let record = projects
        .iter()
        .find(|item| item.id == request.project_id && item.path == request.project_path)
        .cloned()
        .ok_or_else(|| {
            deletion_error(
                "UI-PROJECT-DELETE-INDEX-CHANGED",
                "项目记录已变化，请刷新项目中心后重试。",
            )
        })?;
    let requested = PathBuf::from(&request.project_path);
    let (project_dir, project, mode, manifest_stamp) = inspect_delete_directory(request)?;
    let fingerprint = serde_json::to_string(&serde_json::json!({
        "record": record, "path": requested, "resolved_path": project_dir,
        "mode": mode, "project": project, "manifest": manifest_stamp,
    }))
    .map_err(|_| "无法生成项目删除影响指纹。".to_string())?;
    Ok(DeleteProjectTarget {
        project_dir,
        record,
        project,
        mode,
        fingerprint,
        projects,
    })
}

fn inspect_delete_directory(
    request: &DeleteProjectRequest,
) -> Result<
    (
        PathBuf,
        Option<Project>,
        DeleteProjectMode,
        serde_json::Value,
    ),
    String,
> {
    let requested = PathBuf::from(&request.project_path);
    if !requested.is_absolute() {
        return Err(deletion_error(
            "UI-PROJECT-DELETE-UNSAFE",
            "项目路径无效，已拒绝删除。",
        ));
    }
    match std::fs::symlink_metadata(&requested) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                requested,
                None,
                DeleteProjectMode::MissingDirectory,
                serde_json::Value::Null,
            ));
        }
        Err(_) => {
            return Err(deletion_error(
                "UI-PROJECT-DELETE-ACCESS",
                "项目目录无法访问，请检查磁盘或目录权限。",
            ))
        }
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(deletion_error(
                "UI-PROJECT-DELETE-UNSAFE",
                "只允许操作真实的 MetOrigin 项目目录。",
            ));
        }
        Ok(_) => {}
    }
    let canonical = requested.canonicalize().map_err(|_| {
        deletion_error("UI-PROJECT-DELETE-ACCESS", "无法解析项目目录，已拒绝删除。")
    })?;
    validate_safe_delete_root(&canonical)?;
    let manifest_path = canonical.join("project.json");
    let metadata = match std::fs::symlink_metadata(&manifest_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                canonical,
                None,
                DeleteProjectMode::MissingManifest,
                serde_json::Value::Null,
            ));
        }
        Err(_) => {
            return Err(deletion_error(
                "UI-PROJECT-DELETE-ACCESS",
                "项目文件无法访问，请检查目录权限。",
            ))
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(deletion_error(
                "UI-PROJECT-DELETE-UNSAFE",
                "项目文件类型无法安全验证，已拒绝删除。",
            ));
        }
        Ok(metadata) => metadata,
    };
    let bytes = std::fs::read(&manifest_path).map_err(|_| {
        deletion_error(
            "UI-PROJECT-DELETE-ACCESS",
            "项目文件无法读取，请检查目录权限。",
        )
    })?;
    let stamp = serde_json::json!({
        "size": metadata.len(),
        "modified": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos().to_string()),
    });
    let parsed = serde_json::from_slice::<serde_json::Value>(&bytes);
    // Even a partially damaged manifest must never authorize deleting another ID.
    if parsed
        .as_ref()
        .ok()
        .and_then(|value| value.get("id"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id != request.project_id)
    {
        return Err(deletion_error(
            "UI-PROJECT-DELETE-ID-MISMATCH",
            "项目身份校验失败，已拒绝删除。",
        ));
    }
    let project = parsed.ok().and_then(|value| {
        let version = splat_project::migration::detect_schema_version(&value);
        splat_project::migration::migrate(
            value,
            version,
            splat_project::migration::CURRENT_SCHEMA_VERSION,
        )
        .ok()
        .and_then(|value| serde_json::from_value::<Project>(value).ok())
    });
    match project {
        Some(project) if project.id.to_string() == request.project_id => Ok((
            canonical,
            Some(project),
            DeleteProjectMode::Directory,
            stamp,
        )),
        Some(_) => Err(deletion_error(
            "UI-PROJECT-DELETE-ID-MISMATCH",
            "项目身份校验失败，已拒绝删除。",
        )),
        None => Ok((canonical, None, DeleteProjectMode::InvalidManifest, stamp)),
    }
}

pub(crate) fn delete_project_inner(
    request: DeleteProjectRequest,
    app_handle: &tauri::AppHandle,
    state: &AppState,
) -> Result<DeleteProjectResult, String> {
    delete_project_at_index(
        request,
        &recent_project_index_path(app_handle)?,
        state,
        None,
    )
}

pub(super) fn delete_project_confirmed_inner(
    request: DeleteProjectRequest,
    app_handle: &tauri::AppHandle,
    state: &AppState,
    expected_target: &str,
) -> Result<DeleteProjectResult, String> {
    delete_project_at_index(
        request,
        &recent_project_index_path(app_handle)?,
        state,
        Some(expected_target),
    )
}

fn delete_project_at_index(
    request: DeleteProjectRequest,
    index_path: &Path,
    state: &AppState,
    expected_target: Option<&str>,
) -> Result<DeleteProjectResult, String> {
    let _writer = state.recent_index_write_guard();
    let stale = || {
        deletion_error(
            "UI-ACTION-PREVIEW-STALE",
            "项目状态已变化，尚未执行任何操作，请重新确认。",
        )
    };
    // Retain admission state through the writes so a new in-app owner cannot
    // appear between the active check and record/directory removal.
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "项目删除状态不可用，请重试。".to_string())?;
    if let Some(reason) = delete_project_blocker(&request, &inner) {
        return Err(if expected_target.is_some() {
            stale()
        } else {
            deletion_error("UI-PROJECT-DELETE-ACTIVE", reason)
        });
    }
    let target = inspect_delete_target(&request, index_path).map_err(|error| {
        if expected_target.is_some() {
            stale()
        } else {
            error
        }
    })?;
    if expected_target.is_some_and(|expected| target.fingerprint != expected) {
        return Err(stale());
    }
    let before_lock = target.fingerprint.clone();
    let mut project_lock = if !target.record_only() {
        Some(
            splat_pipeline::ProjectLock::try_lock(&target.project_dir, "project_delete").map_err(
                |_| {
                    deletion_error(
                        "UI-PROJECT-DELETE-ACTIVE",
                        "项目仍被其他操作或应用占用，请稍后重试。",
                    )
                },
            )?,
        )
    } else {
        None
    };
    // Recheck after acquiring the physical deletion guard. Never expand a
    // record-only confirmation into recursive deletion when files reappear.
    let target = inspect_delete_target(&request, index_path).map_err(|error| {
        if expected_target.is_some() {
            stale()
        } else {
            error
        }
    })?;
    if target.fingerprint != before_lock
        || expected_target.is_some_and(|expected| target.fingerprint != expected)
    {
        return Err(stale());
    }
    let record_only = target.record_only();
    let original_projects = target.projects;
    let mut projects = original_projects.clone();
    projects.retain(|item| !(item.id == request.project_id && item.path == request.project_path));

    if record_only {
        install_recent_project_index(index_path, &projects)?;
    } else {
        let project_dir = &target.project_dir;
        let parent = project_dir
            .parent()
            .ok_or_else(|| "项目目录没有有效的父目录，已拒绝删除。".to_string())?;
        let file_name = project_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "项目目录名称无效，已拒绝删除。".to_string())?;
        let tombstone = parent.join(format!(".{file_name}.deleting-{}", request.project_id));
        if tombstone.exists() {
            return Err("项目删除临时目录已存在，请先检查磁盘状态。".into());
        }
        let project_lock = project_lock.as_mut().unwrap();
        project_lock
            .rename_project_directory(&tombstone)
            .map_err(|_| "无法锁定项目目录进行删除，请关闭占用该目录的程序后重试。".to_string())?;
        if let Err(error) = install_recent_project_index(index_path, &projects) {
            let _ = project_lock.rename_project_directory(project_dir);
            return Err(error);
        }
        if let Err(error) = std::fs::remove_dir_all(&tombstone) {
            let _ = install_recent_project_index(index_path, &original_projects);
            let _ = project_lock.restore_project_directory(project_dir);
            return Err(format!("删除项目文件失败，已尝试恢复原目录：{error}"));
        }
    }
    inner.recent_projects = projects;
    if inner
        .project_dir
        .as_ref()
        .is_some_and(|current| paths_refer_to_same_project(current, &target.project_dir))
    {
        inner.project_dir = None;
    }
    Ok(DeleteProjectResult {
        project_id: request.project_id,
        deleted_path: target.project_dir.to_string_lossy().to_string(),
        removed_from_recent: true,
        files_deleted: !record_only,
    })
}

#[cfg(test)]
fn validate_delete_request(request: &DeleteProjectRequest) -> Result<(PathBuf, Project), String> {
    let (path, project, _, _) = inspect_delete_directory(request)?;
    project
        .map(|project| (path, project))
        .ok_or_else(|| "目标目录不是有效的 MetOrigin 项目。".into())
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

fn training_runtime_check(
    runtime: &splat_domain::AppResult<splat_engine_brush::TrainingRuntimeEvidence>,
) -> EngineCheck {
    let name = if cfg!(target_os = "macos") {
        "Metal GPU / 计算验证"
    } else {
        "NVIDIA GPU / 驱动"
    };
    match runtime {
        Ok(info) => EngineCheck {
            name: name.into(),
            available: true,
            path: None,
            expected_version: None,
            actual_version: match info {
                splat_engine_brush::TrainingRuntimeEvidence::LegacyNvidia(gpu) => {
                    Some(gpu.driver_version.clone())
                }
                splat_engine_brush::TrainingRuntimeEvidence::Metal(brush) => {
                    Some(brush.capabilities.identity.engine_version.clone())
                }
            },
            diagnostic: Some(info.summary()),
            source: Some("runtime_probe".into()),
            integrity_status: None,
        },
        Err(error) => EngineCheck {
            name: name.into(),
            available: false,
            path: None,
            expected_version: None,
            actual_version: None,
            diagnostic: Some(error.user_message_zh()),
            source: Some("runtime_probe".into()),
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
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err("项目名称包含 Windows 不支持的字符或长度超过 80。".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if name.ends_with('.') || reserved {
        return Err("项目名称不能以句点结尾，也不能使用 Windows 保留名称。".into());
    }
    Ok(())
}

/// This owner exists only after an exclusive directory creation succeeds.
/// Never adopt/clean a pre-existing directory based on its name or suffix.
struct CreatingDirectory {
    path: PathBuf,
    remove_on_drop: bool,
}

impl Drop for CreatingDirectory {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn with_project_creation_directory<T>(
    project_root: &Path,
    name: &str,
    project_id: &str,
    build: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<(T, PathBuf), String> {
    validate_project_name(name)?;
    std::fs::create_dir_all(project_root)
        .map_err(|_| "创建项目根目录失败，请检查访问权限。".to_string())?;
    let final_dir = paths::project_dir(project_root, name.trim());
    match std::fs::symlink_metadata(&final_dir) {
        Ok(_) => return Err("同名文件或文件夹已经存在，请更换项目名称。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("创建项目目录失败，请检查目标目录权限。".into()),
    }
    let creating_dir = project_root.join(format!(".metorigin-create-{project_id}.creating"));
    std::fs::create_dir(&creating_dir).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "项目创建临时目录已经存在，请重试。".to_string()
        } else {
            "创建项目目录失败，请检查目标目录权限。".to_string()
        }
    })?;
    let mut staging = CreatingDirectory {
        path: creating_dir,
        remove_on_drop: true,
    };
    let value = build(&staging.path)?;
    publish_project_directory(&staging.path, &final_dir)
        .map_err(|_| "完成项目创建失败，请确认目标目录未被占用。".to_string())?;
    // Do not clean even the old path after publication: another owner could
    // subsequently create a different directory at that now-unused name.
    staging.remove_on_drop = false;
    Ok((value, final_dir))
}

/// Publish atomically without replacing even an empty directory created while
/// importing. A preflight exists() check cannot provide that guarantee.
#[cfg(target_os = "macos")]
fn publish_project_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both pointers are valid NUL-terminated paths for this call.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn publish_project_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "MoveFileW"]
        fn move_file_w(source: *const u16, destination: *const u16) -> i32;
    }
    // canonicalize supplies extended-length Windows paths. Resolve only the
    // destination parent so an existing final link is still rejected, not followed.
    let source = source.canonicalize()?;
    let parent = destination
        .parent()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "missing destination parent",
            )
        })?
        .canonicalize()?;
    let name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing destination name")
    })?;
    let destination = parent.join(name);
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // MoveFileW fails when destination already exists; it has no replace flag.
    // SAFETY: both buffers are valid NUL-terminated Windows paths for this call.
    if unsafe { move_file_w(source.as_ptr(), destination.as_ptr()) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn publish_project_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn renameat2(
            old_dir: std::ffi::c_int,
            source: *const std::ffi::c_char,
            new_dir: std::ffi::c_int,
            destination: *const std::ffi::c_char,
            flags: std::ffi::c_uint,
        ) -> std::ffi::c_int;
    }
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    // AT_FDCWD=-100 and RENAME_NOREPLACE=1. Unsupported kernels fail closed.
    // SAFETY: both pointers are valid NUL-terminated paths for this call.
    if unsafe { renameat2(-100, source.as_ptr(), -100, destination.as_ptr(), 1) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn publish_project_directory(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace directory publication is unavailable",
    ))
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
    let creation_id = project.id.to_string();
    let (project, final_dir) = with_project_creation_directory(
        &project_root,
        &request.name,
        &creation_id,
        |creating_dir| {
            paths::create_project_directories(creating_dir)
                .map_err(|_| "创建项目目录失败，请检查目标目录权限。".to_string())?;
            let manager = ProjectManager::new(project_root.clone());
            project.status = ProjectStatus::Creating;
            manager
                .save_project(&project, creating_dir)
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
            project.settings.colmap_max_long_edge = if preset.frame_extraction.colmap_long_edge > 0
            {
                preset.frame_extraction.colmap_long_edge
            } else {
                preset.frame_extraction.target_long_edge
            };
            project.status = ProjectStatus::Ready;
            project.touch();
            manager
                .save_project(&project, creating_dir)
                .map_err(|error| error.user_message_zh())?;
            Ok(project)
        },
    )?;
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

pub(super) fn recent_project_index_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
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

pub(super) fn install_recent_project_index(
    path: &Path,
    projects: &[ProjectInfo],
) -> Result<(), String> {
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

    #[tokio::test]
    async fn creation_worker_panic_releases_its_owner_and_pending_work() {
        let state = AppState::new();
        state.0.lock().unwrap().active_creation = Some(ActiveProjectCreation {
            id: "panic-worker".into(),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        let pending = crate::lifecycle::PendingWork::begin(&state).unwrap();
        let cleanup = CreationCleanup {
            state: state.clone(),
            id: "panic-worker".into(),
        };
        let result = tokio::task::spawn_blocking(move || {
            let _pending = pending;
            let _cleanup = cleanup;
            panic!("simulated importer panic");
        })
        .await;
        assert!(result.is_err());
        let inner = state.0.lock().unwrap();
        assert!(inner.active_creation.is_none());
        assert_eq!(inner.pending_work, 0);
    }

    #[tokio::test]
    async fn abandoning_import_ipc_does_not_release_a_running_worker() {
        let state = AppState::new();
        state.0.lock().unwrap().active_creation = Some(ActiveProjectCreation {
            id: "detached-worker".into(),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        let pending = crate::lifecycle::PendingWork::begin(&state).unwrap();
        let cleanup = CreationCleanup {
            state: state.clone(),
            id: "detached-worker".into(),
        };
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _pending = pending;
                let _cleanup = cleanup;
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
            .await
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.is_err());
        assert!(state.0.lock().unwrap().active_creation.is_some());
        assert_eq!(state.0.lock().unwrap().pending_work, 1);
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while state.0.lock().unwrap().pending_work != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(state.0.lock().unwrap().active_creation.is_none());
    }

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
    fn deleting_unavailable_projects_only_removes_the_exact_persisted_record() {
        for missing in ["directory", "manifest", "corrupt"] {
            let root = temporary_test_root(&format!("delete-record-{missing}"));
            let directory = root.join("project.splat-project");
            let index = root.join("recent-projects.json");
            let project = Project::new("失效项目");
            let id = project.id.to_string();
            if missing != "directory" {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(directory.join("keep.bin"), b"residual project files").unwrap();
                if missing == "corrupt" {
                    std::fs::write(directory.join("project.json"), b"{damaged").unwrap();
                }
            }
            let target = recent_info(&id, &directory);
            let others = vec![
                recent_info("other", &root.join("other.splat-project")),
                recent_info(&id, &root.join("copied.splat-project")),
                recent_info("different-id", &directory),
            ];
            let mut entries = vec![target.clone()];
            entries.extend(others.clone());
            install_recent_project_index(&index, &entries).unwrap();
            let state = AppState::new();
            state.0.lock().unwrap().recent_projects = entries;
            state.0.lock().unwrap().project_dir = Some(directory.clone());
            let result = delete_project_at_index(
                DeleteProjectRequest {
                    project_id: id,
                    project_path: directory.to_string_lossy().into(),
                },
                &index,
                &state,
                None,
            )
            .unwrap();
            assert!(!result.files_deleted && result.removed_from_recent);
            assert_eq!(read_recent_project_index_path(&index).unwrap(), others);
            assert_eq!(state.0.lock().unwrap().recent_projects, others);
            assert!(state.0.lock().unwrap().project_dir.is_none());
            if missing == "directory" {
                assert!(!directory.exists());
            } else {
                assert_eq!(
                    std::fs::read(directory.join("keep.bin")).unwrap(),
                    b"residual project files"
                );
            }
            if missing == "corrupt" {
                assert_eq!(
                    std::fs::read(directory.join("project.json")).unwrap(),
                    b"{damaged"
                );
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn delete_requires_persisted_identity_and_rejects_a_valid_different_project() {
        let root = temporary_test_root("delete-persisted-identity");
        let directory = root.join("valid.splat-project");
        paths::create_project_directories(&directory).unwrap();
        let project = Project::new("真实项目");
        ProjectManager::new(root.clone())
            .save_project(&project, &directory)
            .unwrap();
        let before = std::fs::read(directory.join("project.json")).unwrap();
        let requested_id = splat_domain::project::ProjectId::new().to_string();
        let target = recent_info(&requested_id, &directory);
        let index = root.join("recent-projects.json");
        let state = AppState::new();
        state.0.lock().unwrap().recent_projects = vec![target.clone()];
        install_recent_project_index(&index, &[]).unwrap();
        let request = DeleteProjectRequest {
            project_id: requested_id,
            project_path: directory.to_string_lossy().into(),
        };
        assert!(
            delete_project_at_index(request.clone(), &index, &state, None)
                .unwrap_err()
                .contains("INDEX-CHANGED")
        );
        install_recent_project_index(&index, std::slice::from_ref(&target)).unwrap();
        assert!(delete_project_at_index(request, &index, &state, None)
            .unwrap_err()
            .contains("ID-MISMATCH"));
        assert_eq!(
            std::fs::read(directory.join("project.json")).unwrap(),
            before
        );
        assert_eq!(
            read_recent_project_index_path(&index).unwrap(),
            vec![target]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delete_retains_active_missing_projects_and_does_not_touch_the_index() {
        for owner in ["creation", "pipeline-id", "pipeline-path"] {
            let root = temporary_test_root(&format!("delete-active-{owner}"));
            let directory = root.join("missing.splat-project");
            let project = Project::new("活动项目");
            let id = project.id.to_string();
            let target = recent_info(&id, &directory);
            let index = root.join("recent-projects.json");
            install_recent_project_index(&index, &[target]).unwrap();
            let state = AppState::new();
            if owner == "creation" {
                state.0.lock().unwrap().active_creation = Some(ActiveProjectCreation {
                    id: id.clone(),
                    cancel: Arc::new(AtomicBool::new(false)),
                });
            } else {
                let (_sender, completion) = tokio::sync::watch::channel(false);
                state.0.lock().unwrap().active_pipeline = Some(crate::state::ActivePipeline {
                    project_id: if owner == "pipeline-id" {
                        id.clone()
                    } else {
                        "another-id".into()
                    },
                    project_dir: if owner == "pipeline-path" {
                        directory.clone()
                    } else {
                        root.join("other-path")
                    },
                    orchestrator: Arc::new(splat_pipeline::PipelineOrchestrator::new_default(
                        directory.clone(),
                    )),
                    completion,
                    control_intent: Arc::new(std::sync::Mutex::new(
                        crate::state::PipelineControlIntent::None,
                    )),
                    accepted_at: "2026-08-14T00:00:00Z".into(),
                    started_at: Arc::new(std::sync::Mutex::new(None)),
                    sequence: Arc::new(std::sync::atomic::AtomicU64::new(1)),
                    abort_handle: Arc::new(std::sync::Mutex::new(None)),
                    finalization: Arc::new(tokio::sync::Mutex::new(
                        crate::state::PipelineFinalization::Running,
                    )),
                    process_scope: splat_process::ProcessScope::default(),
                    event_forwarder: Arc::new(tokio::sync::Mutex::new(None)),
                });
            }
            let before = std::fs::read(&index).unwrap();
            assert!(delete_project_at_index(
                DeleteProjectRequest {
                    project_id: id,
                    project_path: directory.to_string_lossy().into()
                },
                &index,
                &state,
                None
            )
            .unwrap_err()
            .contains("DELETE-ACTIVE"));
            assert_eq!(std::fs::read(&index).unwrap(), before);
            assert!(!directory.exists());
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn record_only_execution_refuses_reappearing_files_and_retains_state_if_index_install_fails() {
        let root = temporary_test_root("delete-confirmed-scope");
        let directory = root.join("project.splat-project");
        let project = Project::new("测试项目");
        let index = root.join("recent-projects.json");
        let target = recent_info(&project.id.to_string(), &directory);
        install_recent_project_index(&index, std::slice::from_ref(&target)).unwrap();
        let state = AppState::new();
        state.0.lock().unwrap().recent_projects = vec![target.clone()];
        let request = DeleteProjectRequest {
            project_id: project.id.to_string(),
            project_path: directory.to_string_lossy().into(),
        };
        let previous = inspect_delete_target(&request, &index).unwrap().fingerprint;
        paths::create_project_directories(&directory).unwrap();
        ProjectManager::new(root.clone())
            .save_project(&project, &directory)
            .unwrap();
        assert!(deletion_is_stale(
            &delete_project_at_index(request.clone(), &index, &state, Some(&previous)).unwrap_err()
        ));
        assert!(directory.join("project.json").is_file());

        std::fs::remove_file(directory.join("project.json")).unwrap();
        std::fs::write(directory.join("keep.bin"), b"keep").unwrap();
        std::fs::create_dir_all(index_temporary_path(&index)).unwrap();
        assert!(delete_project_at_index(request, &index, &state, None).is_err());
        assert_eq!(
            read_recent_project_index_path(&index).unwrap(),
            vec![target.clone()]
        );
        assert_eq!(state.0.lock().unwrap().recent_projects, vec![target]);
        assert_eq!(std::fs::read(directory.join("keep.bin")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn valid_project_delete_requires_the_project_guard_then_removes_files() {
        let root = temporary_test_root("delete-physical");
        let manager = ProjectManager::new(root.clone());
        let (project, directory) = manager.create_project("有效项目").unwrap();
        let index = root.join("recent-projects.json");
        install_recent_project_index(&index, &[recent_info(&project.id.to_string(), &directory)])
            .unwrap();
        let request = DeleteProjectRequest {
            project_id: project.id.to_string(),
            project_path: directory.to_string_lossy().into(),
        };
        let state = AppState::new();
        let guard =
            splat_pipeline::ProjectLock::try_lock(&directory, "pipeline_admission").unwrap();
        assert!(
            delete_project_at_index(request.clone(), &index, &state, None)
                .unwrap_err()
                .contains("DELETE-ACTIVE")
        );
        assert!(directory.join("project.json").is_file());
        drop(guard);
        assert!(
            delete_project_at_index(request, &index, &state, None)
                .unwrap()
                .files_deleted
        );
        assert!(!directory.exists());
        assert!(read_recent_project_index_path(&index).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_index_install_restores_the_locked_project_and_allows_deletion_retry() {
        let root = temporary_test_root("delete-physical-rollback");
        let manager = ProjectManager::new(root.clone());
        let (project, directory) = manager.create_project("有效项目").unwrap();
        let index = root.join("recent-projects.json");
        let info = recent_info(&project.id.to_string(), &directory);
        install_recent_project_index(&index, std::slice::from_ref(&info)).unwrap();
        let request = DeleteProjectRequest {
            project_id: project.id.to_string(),
            project_path: directory.to_string_lossy().into(),
        };
        let state = AppState::new();
        state.0.lock().unwrap().recent_projects = vec![info.clone()];
        let temporary = index_temporary_path(&index);
        std::fs::create_dir(&temporary).unwrap();
        assert!(delete_project_at_index(request.clone(), &index, &state, None).is_err());
        assert!(directory.join("project.json").is_file());
        assert!(!directory.join(".lock").exists());
        assert_eq!(
            read_recent_project_index_path(&index).unwrap(),
            vec![info.clone()]
        );
        assert_eq!(state.0.lock().unwrap().recent_projects, vec![info]);
        splat_pipeline::ProjectLock::try_lock(&directory, "retry")
            .unwrap()
            .release();
        std::fs::remove_dir(&temporary).unwrap();
        assert!(
            delete_project_at_index(request, &index, &state, None)
                .unwrap()
                .files_deleted
        );
        assert!(!directory.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn delete_rejects_directory_and_manifest_symlinks_without_changing_their_targets() {
        let root = temporary_test_root("delete-symlinks");
        let manager = ProjectManager::new(root.clone());
        let (project, directory) = manager.create_project("真实项目").unwrap();
        let alias = root.join("alias.splat-project");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        let index = root.join("recent-projects.json");
        install_recent_project_index(&index, &[recent_info(&project.id.to_string(), &alias)])
            .unwrap();
        let state = AppState::new();
        assert!(delete_project_at_index(
            DeleteProjectRequest {
                project_id: project.id.to_string(),
                project_path: alias.to_string_lossy().into()
            },
            &index,
            &state,
            None
        )
        .is_err());
        let residual = root.join("residual.splat-project");
        std::fs::create_dir(&residual).unwrap();
        std::os::unix::fs::symlink(
            directory.join("project.json"),
            residual.join("project.json"),
        )
        .unwrap();
        install_recent_project_index(&index, &[recent_info(&project.id.to_string(), &residual)])
            .unwrap();
        assert!(delete_project_at_index(
            DeleteProjectRequest {
                project_id: project.id.to_string(),
                project_path: residual.to_string_lossy().into()
            },
            &index,
            &state,
            None
        )
        .is_err());
        assert!(directory.join("project.json").is_file());
        assert!(alias.is_dir() && residual.is_dir());
        let _ = std::fs::remove_dir_all(root);
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
    fn ordinary_project_names_reject_windows_device_names_trailing_dots_and_controls() {
        for name in [
            "CON",
            "con.txt",
            "PrN.data",
            "AUX",
            "NUL",
            "COM1",
            "lpt9.png",
            "COM¹.bin",
            "CONIN$",
            "CONOUT$",
            ".",
            "..",
            "街景.",
            "bad\nname",
            "bad\0name",
        ] {
            assert!(validate_project_name(name).is_err(), "must reject {name:?}");
        }
        for name in [
            "街景 v2",
            "capture.v2",
            "sample.creating",
            "COM10",
            "complete.splat-project",
        ] {
            assert!(validate_project_name(name).is_ok(), "must accept {name:?}");
        }
    }

    #[test]
    fn desktop_creation_transaction_publishes_the_trimmed_plain_name_and_retains_old_projects() {
        let root = temporary_test_root("plain-project-transaction");
        let legacy = root.join("街景.v2.creating.splat-project");
        paths::create_project_directories(&legacy).unwrap();
        let old_project = Project::new("旧项目");
        let manager = ProjectManager::new(root.clone());
        manager.save_project(&old_project, &legacy).unwrap();
        let legacy_before = std::fs::read(legacy.join("project.json")).unwrap();
        let mut staging_path = None;
        let new_project = Project::new("街景.v2.creating");
        let id = new_project.id.to_string();
        let (created, directory) =
            with_project_creation_directory(&root, "  街景.v2.creating  ", &id, |staging| {
                staging_path = Some(staging.to_path_buf());
                paths::create_project_directories(staging).map_err(|error| error.to_string())?;
                manager
                    .save_project(&new_project, staging)
                    .map_err(|error| error.to_string())?;
                Ok(new_project)
            })
            .unwrap();
        assert_eq!(directory, root.join("街景.v2.creating"));
        assert_eq!(manager.open_project(&directory).unwrap().id, created.id);
        assert!(directory.join("source").is_dir() && directory.join("frames").is_dir());
        assert!(!staging_path.unwrap().exists());
        assert_eq!(
            std::fs::read(legacy.join("project.json")).unwrap(),
            legacy_before
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_creation_never_adopts_existing_final_or_staging_files_and_directories() {
        for occupied in [
            "folder",
            "source",
            "file",
            "old-project",
            "staging-folder",
            "staging-file",
        ] {
            let root = temporary_test_root(&format!("creation-collision-{occupied}"));
            std::fs::create_dir_all(&root).unwrap();
            let name = if occupied == "old-project" {
                "capture.splat-project"
            } else {
                "capture"
            };
            let final_path = root.join(name);
            let staging_path = root.join(".metorigin-create-owned-id.creating");
            let occupied_path = if occupied.starts_with("staging-") {
                &staging_path
            } else {
                &final_path
            };
            let sentinel = if occupied.ends_with("file") || occupied == "file" {
                std::fs::write(occupied_path, b"existing file").unwrap();
                occupied_path.clone()
            } else {
                std::fs::create_dir(occupied_path).unwrap();
                let sentinel = occupied_path.join("keep.bin");
                std::fs::write(&sentinel, b"existing file").unwrap();
                sentinel
            };
            let result = with_project_creation_directory::<()>(&root, name, "owned-id", |_| {
                panic!("must not enter a pre-existing directory")
            });
            assert!(result.is_err());
            assert_eq!(std::fs::read(sentinel).unwrap(), b"existing file");
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn desktop_creation_failed_or_cancelled_import_only_cleans_its_owned_temporary_directory() {
        for failure in ["copy failed", "项目创建已取消，未完成目录已清理。"] {
            let root = temporary_test_root("creation-owned-cleanup");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("source.bin");
            std::fs::write(&source, b"original media").unwrap();
            let unrelated = root.join("existing.creating");
            std::fs::create_dir(&unrelated).unwrap();
            std::fs::write(unrelated.join("keep.bin"), b"unrelated data").unwrap();
            let result = with_project_creation_directory::<()>(
                &root,
                "new-project",
                "owned-id",
                |staging| {
                    paths::create_project_directories(staging)
                        .map_err(|error| error.to_string())?;
                    std::fs::write(staging.join("source/partial.bin"), b"partial import")
                        .map_err(|error| error.to_string())?;
                    Err(failure.into())
                },
            );
            assert_eq!(result.unwrap_err(), failure);
            assert!(!root.join("new-project").exists());
            assert!(!root.join(".metorigin-create-owned-id.creating").exists());
            assert_eq!(std::fs::read(&source).unwrap(), b"original media");
            assert_eq!(
                std::fs::read(unrelated.join("keep.bin")).unwrap(),
                b"unrelated data"
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn desktop_creation_publication_does_not_replace_a_destination_that_appears_during_import() {
        for existing in ["empty-folder", "folder-with-files", "file"] {
            let root = temporary_test_root(&format!("creation-publish-race-{existing}"));
            let final_path = root.join("capture");
            let result = with_project_creation_directory(&root, "capture", "owned-id", |staging| {
                paths::create_project_directories(staging).map_err(|error| error.to_string())?;
                std::fs::write(staging.join("project.json"), b"new project")
                    .map_err(|error| error.to_string())?;
                if existing == "file" {
                    std::fs::write(&final_path, b"existing file").unwrap();
                } else {
                    std::fs::create_dir(&final_path).unwrap();
                    if existing == "folder-with-files" {
                        std::fs::write(final_path.join("keep.bin"), b"existing file").unwrap();
                    }
                }
                Ok(())
            });
            assert!(result.is_err());
            assert!(!root.join(".metorigin-create-owned-id.creating").exists());
            if existing == "file" {
                assert_eq!(std::fs::read(&final_path).unwrap(), b"existing file");
            } else if existing == "empty-folder" {
                assert_eq!(std::fs::read_dir(&final_path).unwrap().count(), 0);
            } else {
                assert_eq!(
                    std::fs::read(final_path.join("keep.bin")).unwrap(),
                    b"existing file"
                );
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[cfg(unix)]
    #[test]
    fn desktop_creation_preserves_dangling_destination_links() {
        let root = temporary_test_root("creation-linked-destination");
        std::fs::create_dir_all(&root).unwrap();
        let final_path = root.join("capture");
        let missing_target = root.join("missing-target");
        std::os::unix::fs::symlink(&missing_target, &final_path).unwrap();
        assert!(
            with_project_creation_directory::<()>(&root, "capture", "owned-id", |_| panic!(
                "must not enter a linked destination"
            ))
            .is_err()
        );
        assert_eq!(std::fs::read_link(&final_path).unwrap(), missing_target);
        assert!(!root.join(".metorigin-create-owned-id.creating").exists());
        let _ = std::fs::remove_dir_all(root);
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
