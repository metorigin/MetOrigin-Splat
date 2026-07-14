use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use splat_domain::project::{
    ImageFolderSource, Project, ProjectSource, ProjectStatus, VideoSource,
};
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
    total_size_bytes: u64,
    formats: std::collections::BTreeMap<String, usize>,
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

#[derive(Debug, Clone, serde::Serialize)]
struct EngineCheck {
    name: String,
    available: bool,
    path: Option<String>,
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
}

#[derive(serde::Deserialize)]
struct TrainingPreset {
    iterations: u32,
    #[serde(rename = "shDegree")]
    sh_degree: u32,
}

/// Analyze a media file and return its metadata (for the new-project wizard).
#[tauri::command]
pub fn analyze_media(path: String, app_handle: tauri::AppHandle) -> Result<MediaAnalysis, String> {
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

        match splat_engine_ffmpeg::probe::probe_video_with(&ffprobe, &path) {
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
        let metadata = analyze_image_directory(&path)?;
        let valid = metadata.image_count > 0;
        let total_size = metadata.total_size_bytes;
        let image_count = metadata.image_count;
        Ok(MediaAnalysis {
            source_kind: "images".into(),
            source_path: path.to_string_lossy().to_string(),
            display_name: display_name(&path),
            size_bytes: total_size,
            valid,
            video_metadata: None,
            image_set_metadata: Some(metadata),
            preset_estimates: preset_estimates(None, Some(image_count))?,
            preview_items: preview_image_paths(&path, 6),
            warnings: Vec::new(),
            blockers: if valid {
                Vec::new()
            } else {
                vec!["所选文件夹中没有可用图片。".into()]
            },
        })
    } else {
        Err(format!("不支持的文件格式：{}", path.display()))
    }
}

#[tauri::command]
pub fn preflight_project(
    request: PreflightProjectRequest,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectPreflight, String> {
    let analysis = analyze_media(request.source_path, app_handle.clone())?;
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
    let engines = crate::commands::system::resolve_engine_paths(&app_handle);
    let engine_checks = vec![
        engine_check(
            "FFmpeg / FFprobe",
            engines.ffmpeg.zip(engines.ffprobe).map(|pair| pair.0),
        ),
        engine_check("COLMAP", engines.colmap),
        engine_check("Brush", engines.brush),
    ];
    let selected = analysis
        .preset_estimates
        .iter()
        .find(|preset| preset.id == request.preset)
        .or_else(|| analysis.preset_estimates.first());
    let estimated_frames = selected.map(|preset| preset.estimated_frames).unwrap_or(0);
    let estimated_disk_bytes = selected
        .map(|preset| preset.estimated_disk_bytes)
        .unwrap_or(0)
        .saturating_add(analysis.size_bytes)
        .saturating_add(5 * 1024 * 1024 * 1024);
    let mut blockers = analysis.blockers;
    if !root.exists() && existing_root.is_none() {
        blockers.push("无法定位项目目标目录所在磁盘。".into());
    }
    for engine in &engine_checks {
        if !engine.available {
            blockers.push(format!("未找到 {} 引擎。", engine.name));
        }
    }
    if available_disk_bytes > 0 && available_disk_bytes < estimated_disk_bytes {
        blockers.push(format!(
            "项目磁盘空间不足，还需要约 {:.1} GiB。",
            (estimated_disk_bytes - available_disk_bytes) as f64 / 1024_f64.powi(3)
        ));
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
        warnings: analysis.warnings,
        blockers,
    })
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
        .join("MetaOrigin Projects");
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
    let mut projects = read_recent_project_index(&app_handle)?;
    refresh_recent_projects(&mut projects);
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Ok(mut inner) = state.0.lock() {
        inner.recent_projects = projects.clone();
    }
    Ok(projects)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

fn default_projects_dir() -> PathBuf {
    dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetaOrigin Projects")
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
                iterations: preset.training.iterations,
                sh_degree: preset.training.sh_degree,
                checkpoint_interval,
                estimated_frames,
                estimated_disk_bytes: estimated_frames.saturating_mul(bytes_per_frame),
            })
        })
        .collect()
}

fn analyze_image_directory(path: &Path) -> Result<ImageSetMetadata, String> {
    let mut image_count = 0;
    let mut ignored_count = 0;
    let mut total_size_bytes = 0_u64;
    let mut formats = std::collections::BTreeMap::new();
    for entry in std::fs::read_dir(path)
        .map_err(|_| "读取图片目录失败，请检查访问权限。".to_string())?
        .flatten()
    {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let extension = entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
            image_count += 1;
            total_size_bytes = total_size_bytes
                .saturating_add(entry.metadata().map(|metadata| metadata.len()).unwrap_or(0));
            *formats.entry(extension).or_insert(0) += 1;
        } else {
            ignored_count += 1;
        }
    }
    Ok(ImageSetMetadata {
        image_count,
        ignored_count,
        total_size_bytes,
        formats,
    })
}

fn preview_image_paths(path: &Path, limit: usize) -> Vec<String> {
    let mut paths = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| {
                    matches!(extension.to_lowercase().as_str(), "jpg" | "jpeg" | "png")
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .take(limit)
        .map(|path| path.to_string_lossy().to_string())
        .collect()
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

fn engine_check(name: &str, path: Option<PathBuf>) -> EngineCheck {
    EngineCheck {
        name: name.into(),
        available: path.is_some(),
        path: path.map(|path| path.to_string_lossy().to_string()),
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
    let mut images = std::fs::read_dir(source)
        .map_err(|_| "读取源媒体目录失败，请检查路径和访问权限。".to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        matches!(extension.to_lowercase().as_str(), "jpg" | "jpeg" | "png")
                    })
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    images.sort();
    if images.is_empty() {
        return Err("所选文件夹中没有可用的 JPG、JPEG 或 PNG 图片。".into());
    }
    let total = images
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
    let mut copied = 0;
    for image in &images {
        let length = std::fs::metadata(image)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        copy_file_with_progress(
            image,
            &destination.join(image.file_name().unwrap_or_default()),
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
        image_count: images.len(),
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
    let mut image_count = 0usize;
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
        } else if matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
            image_count += 1;
        }
    }

    if let Some(filename) = video_filename {
        return Some(ProjectSource::Video(VideoSource {
            filename,
            copied_to_project: true,
        }));
    }
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

fn record_recent_project(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    project: ProjectInfo,
    selected_dir: Option<PathBuf>,
) -> Result<(), String> {
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
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|_| "读取最近项目索引失败，请检查应用配置目录权限。".to_string())?;
    serde_json::from_str(&content)
        .map_err(|_| "最近项目索引已损坏，请重新打开项目以重建索引。".to_string())
}

fn write_recent_project_index(
    app_handle: &tauri::AppHandle,
    projects: &[ProjectInfo],
) -> Result<(), String> {
    let path = recent_project_index_path(app_handle)?;
    let parent = path
        .parent()
        .ok_or_else(|| "应用配置目录无效。".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "创建应用配置目录失败，请检查目录权限。".to_string())?;
    let content =
        serde_json::to_vec_pretty(projects).map_err(|_| "序列化最近项目索引失败。".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, content)
        .map_err(|_| "写入最近项目索引失败，请检查目录权限。".to_string())?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|_| "更新最近项目索引失败，请关闭占用该文件的程序。".to_string())?;
    }
    std::fs::rename(temporary, path)
        .map_err(|_| "保存最近项目索引失败，请检查目录权限。".to_string())
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
}
