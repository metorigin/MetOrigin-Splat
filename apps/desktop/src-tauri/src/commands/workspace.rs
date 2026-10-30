use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, Utc};
use splat_engine_brush::{CheckpointScanner, ExportManager};
use splat_pipeline::image_input::{encode_preview, uniform_sample_indices};
use splat_project::ProjectManager;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectLocationRequest {
    project_id: String,
    project_path: String,
    target_type: String,
    relative_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenProjectLocationResult {
    opened: bool,
    missing: bool,
    target_type: String,
    message: Option<String>,
}

trait LocationOpener {
    fn open_directory(&self, path: &Path) -> Result<(), String>;
    fn reveal_file(&self, path: &Path) -> Result<(), String>;
}

struct TauriLocationOpener<'a> {
    app_handle: &'a tauri::AppHandle,
}

impl LocationOpener for TauriLocationOpener<'_> {
    fn open_directory(&self, path: &Path) -> Result<(), String> {
        self.app_handle
            .opener()
            .open_path(path.to_string_lossy(), None::<String>)
            .map_err(|error| format!("无法打开目录：{error}"))
    }

    fn reveal_file(&self, path: &Path) -> Result<(), String> {
        self.app_handle
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|error| format!("无法在资源管理器中定位文件：{error}"))
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineEventRecord {
    pub event_id: String,
    pub project_id: String,
    pub sequence: u64,
    pub timestamp: String,
    pub kind: String,
    pub severity: String,
    pub phase_id: Option<String>,
    pub stage_id: Option<String>,
    pub user_message: String,
    pub technical_message: Option<String>,
    #[serde(default)]
    pub metrics: serde_json::Value,
    pub source_log: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EventPage {
    items: Vec<PipelineEventRecord>,
    next_cursor: Option<usize>,
    total: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StageLogPage {
    content: String,
    next_offset: Option<u64>,
    total_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CheckpointSummary {
    pub(crate) iteration: u32,
    pub(crate) relative_path: String,
    pub(crate) size_bytes: u64,
    pub(crate) created_at: String,
    pub(crate) vertex_count: u64,
    pub(crate) valid: bool,
    pub(crate) current: bool,
    pub(crate) brush_version: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ArtifactItem {
    relative_path: String,
    exists: bool,
    validated: bool,
    size_bytes: u64,
    updated_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ArtifactSummary {
    frames_manifest: ArtifactItem,
    colmap_result: ArtifactItem,
    latest_checkpoint: Option<CheckpointSummary>,
    scene_ply: ArtifactItem,
    output_manifest: ArtifactItem,
    registered_images: Option<u64>,
    total_images: Option<u64>,
    sparse_points: Option<u64>,
    mean_reprojection_error: Option<f64>,
    colmap_validation: Option<serde_json::Value>,
    colmap_attempts: Vec<serde_json::Value>,
    splat_count: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FramePreviewItem {
    relative_path: String,
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FramePreview {
    items: Vec<FramePreviewItem>,
    total_frames: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PreviewPoint {
    x: f32,
    y: f32,
    z: f32,
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PreviewCamera {
    x: f32,
    y: f32,
    z: f32,
    forward_x: f32,
    forward_y: f32,
    forward_z: f32,
    up_x: f32,
    up_y: f32,
    up_z: f32,
    name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SparsePreviewPack {
    model_path: String,
    registered_images: u64,
    total_images: u64,
    point_count: u64,
    mean_reprojection_error: Option<f64>,
    points: Vec<PreviewPoint>,
    cameras: Vec<PreviewCamera>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlyPreview {
    relative_path: String,
    format: String,
    vertex_count: u64,
    size_bytes: u64,
    gaussian_compatible: bool,
    points: Vec<PreviewPoint>,
}

pub fn append_pipeline_event(
    project_dir: &Path,
    record: &PipelineEventRecord,
    retention_bytes: u64,
) {
    let logs = project_dir.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    let path = logs.join("events.jsonl");
    let _ = trim_jsonl_log(&path, retention_bytes);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    if let Ok(json) = serde_json::to_string(record) {
        let _ = writeln!(file, "{json}");
    }
}

fn trim_jsonl_log(path: &Path, retention_bytes: u64) -> std::io::Result<()> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if retention_bytes == 0 || metadata.len() <= retention_bytes {
        return Ok(());
    }
    let keep_bytes = (retention_bytes / 2).max(1);
    let start = metadata.len().saturating_sub(keep_bytes);
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    if start > 0 {
        if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
            tail.drain(..=newline);
        }
    }
    std::fs::write(path, tail)
}

#[tauri::command]
pub fn get_pipeline_events(
    project_path: String,
    cursor: Option<usize>,
    limit: Option<usize>,
    stage_id: Option<String>,
    severity: Option<String>,
    search: Option<String>,
) -> Result<EventPage, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let path = project_dir.join("logs/events.jsonl");
    if !path.exists() {
        return Ok(EventPage {
            items: Vec::new(),
            next_cursor: None,
            total: 0,
        });
    }
    let reader =
        BufReader::new(File::open(path).map_err(|_| "无法读取结构化事件日志。".to_string())?);
    let mut records = reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<PipelineEventRecord>(&line).ok())
        .filter(|event| {
            stage_id
                .as_ref()
                .map(|stage| event.stage_id.as_ref() == Some(stage))
                .unwrap_or(true)
        })
        .filter(|event| {
            severity
                .as_ref()
                .map(|level| event.severity.eq_ignore_ascii_case(level))
                .unwrap_or(true)
        })
        .filter(|event| {
            search
                .as_ref()
                .map(|query| {
                    let query = query.to_lowercase();
                    event.user_message.to_lowercase().contains(&query)
                        || event
                            .technical_message
                            .as_deref()
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&query)
                })
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    records.sort_by_key(|record| record.sequence);
    let total = records.len();
    let start = cursor.unwrap_or(0).min(total);
    let page_size = limit.unwrap_or(200).clamp(1, 500);
    let end = (start + page_size).min(total);
    Ok(EventPage {
        items: records[start..end].to_vec(),
        next_cursor: (end < total).then_some(end),
        total,
    })
}

#[tauri::command]
pub fn read_stage_log(
    project_path: String,
    stage_id: String,
    stream: String,
    offset: Option<u64>,
    limit: Option<usize>,
) -> Result<StageLogPage, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let safe_stage = stage_id
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
        .collect::<String>();
    let suffix = if stream.eq_ignore_ascii_case("stdout") {
        "stdout.log"
    } else {
        "stderr.log"
    };
    let candidates = [
        project_dir
            .join("logs")
            .join(format!("{safe_stage}.{suffix}")),
        project_dir
            .join("logs")
            .join(format!("{}.log", safe_stage.to_lowercase())),
        project_dir
            .join("colmap/logs")
            .join(format!("{}.log", safe_stage.to_lowercase())),
        project_dir
            .join("training/logs")
            .join(format!("{}.log", safe_stage.to_lowercase())),
    ];
    let path = candidates.into_iter().find(|path| path.is_file());
    let Some(path) = path else {
        return Ok(StageLogPage {
            content: String::new(),
            next_offset: None,
            total_bytes: 0,
        });
    };
    let mut file = File::open(path).map_err(|_| "无法读取阶段日志。".to_string())?;
    let total_bytes = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let start = offset.unwrap_or(0).min(total_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "无法定位日志位置。".to_string())?;
    let max = limit.unwrap_or(64 * 1024).clamp(1024, 512 * 1024);
    let mut buffer = vec![0_u8; max];
    let read = file
        .read(&mut buffer)
        .map_err(|_| "读取阶段日志失败。".to_string())?;
    buffer.truncate(read);
    let next = start + read as u64;
    Ok(StageLogPage {
        content: String::from_utf8_lossy(&buffer).to_string(),
        next_offset: (next < total_bytes).then_some(next),
        total_bytes,
    })
}

#[tauri::command]
pub fn list_checkpoints(project_path: String) -> Result<Vec<CheckpointSummary>, String> {
    let project_dir = valid_project_dir(&project_path)?;
    checkpoint_summaries(&project_dir)
}

#[tauri::command]
pub fn delete_checkpoint(project_path: String, iteration: u32) -> Result<(), String> {
    delete_checkpoint_inner(project_path, iteration)
}

pub(crate) fn delete_checkpoint_inner(project_path: String, iteration: u32) -> Result<(), String> {
    let project_dir = valid_project_dir(&project_path)?;
    let checkpoints = checkpoint_summaries(&project_dir)?;
    let valid_count = checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.valid)
        .count();
    let selected = checkpoints
        .iter()
        .find(|checkpoint| checkpoint.iteration == iteration)
        .ok_or_else(|| "未找到指定 Checkpoint。".to_string())?;
    if selected.current || (selected.valid && valid_count <= 1) {
        return Err("不能删除当前使用或唯一合法的 Checkpoint。".into());
    }
    let path = secure_relative(&project_dir, &selected.relative_path)?;
    std::fs::remove_file(path)
        .map_err(|_| "删除 Checkpoint 失败，请检查文件是否被占用。".to_string())
}

#[tauri::command]
pub fn restore_checkpoint(
    project_path: String,
    iteration: u32,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<CheckpointSummary>, String> {
    let _pending = crate::lifecycle::PendingWork::begin(state.inner())?;
    restore_checkpoint_inner(project_path, iteration)
}

pub(crate) fn restore_checkpoint_inner(
    project_path: String,
    iteration: u32,
) -> Result<Vec<CheckpointSummary>, String> {
    let project_dir = valid_project_dir(&project_path)?;
    splat_pipeline::stages::brush_training::restore_checkpoint(&project_dir, iteration)
        .map_err(|error| error.user_message_zh())?;
    checkpoint_summaries(&project_dir)
}

#[tauri::command]
pub fn get_project_artifacts(project_path: String) -> Result<ArtifactSummary, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let colmap_json = read_json(&project_dir.join("colmap/result.json"));
    let colmap_validation = read_json(&project_dir.join("colmap/validation.json"));
    let output_json = read_json(&project_dir.join("output/manifest.json"));
    let checkpoints = checkpoint_summaries(&project_dir)?;
    Ok(ArtifactSummary {
        frames_manifest: artifact_item(&project_dir, "frames/frames.json", false),
        colmap_result: artifact_item(&project_dir, "colmap/result.json", false),
        latest_checkpoint: checkpoints.into_iter().last(),
        scene_ply: artifact_item(&project_dir, "output/scene.ply", true),
        output_manifest: artifact_item(&project_dir, "output/manifest.json", false),
        registered_images: colmap_json
            .as_ref()
            .and_then(|value| value["registered_images"].as_u64()),
        total_images: colmap_json
            .as_ref()
            .and_then(|value| value["total_images"].as_u64()),
        sparse_points: colmap_json
            .as_ref()
            .and_then(|value| value["point_count"].as_u64()),
        mean_reprojection_error: colmap_json
            .as_ref()
            .and_then(|value| value["mean_reprojection_error"].as_f64()),
        colmap_attempts: colmap_json
            .as_ref()
            .and_then(|value| value["attempts"].as_array())
            .cloned()
            .unwrap_or_default(),
        colmap_validation,
        // Editing replaces scene.ply; the training manifest may describe an older model.
        splat_count: ExportManager::vertex_count(&project_dir.join("output/scene.ply"))
            .ok()
            .or_else(|| {
                output_json
                    .as_ref()
                    .and_then(|value| value["ply"]["vertex_count"].as_u64())
            }),
    })
}

#[tauri::command]
pub fn ensure_output_directory(project_path: String) -> Result<String, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let output_dir = project_dir.join("output");
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "创建输出目录失败，请检查项目目录权限。".to_string())?;
    Ok(output_dir.to_string_lossy().to_string())
}

/// Opens a validated project directory or reveals an artifact in Explorer.
/// This command deliberately performs the path authorization in Rust instead
/// of granting the WebView a broad filesystem opener scope.
#[tauri::command]
pub fn open_project_location(
    request: OpenProjectLocationRequest,
    app_handle: tauri::AppHandle,
) -> Result<OpenProjectLocationResult, String> {
    let opener = TauriLocationOpener {
        app_handle: &app_handle,
    };
    open_project_location_with(&request, &opener)
}

fn open_project_location_with(
    request: &OpenProjectLocationRequest,
    opener: &dyn LocationOpener,
) -> Result<OpenProjectLocationResult, String> {
    let requested_root = PathBuf::from(&request.project_path);
    if !requested_root.exists() {
        return Ok(OpenProjectLocationResult {
            opened: false,
            missing: true,
            target_type: request.target_type.clone(),
            message: Some("项目目录已移动或删除。".into()),
        });
    }

    let project_dir = validated_project_identity(&requested_root, &request.project_id)?;
    let (target, reveal) = match request.target_type.as_str() {
        "project_root" => (project_dir.clone(), false),
        "output_directory" => {
            let output = project_dir.join("output");
            std::fs::create_dir_all(&output)
                .map_err(|_| "无法创建输出目录，请检查项目目录权限。".to_string())?;
            let canonical = output
                .canonicalize()
                .map_err(|_| "无法解析输出目录。".to_string())?;
            ensure_inside_project(&project_dir, &canonical)?;
            (canonical, false)
        }
        "artifact" => {
            let relative = request
                .relative_path
                .as_deref()
                .ok_or_else(|| "打开产物时必须提供相对路径。".to_string())?;
            let candidate = checked_relative_path(&project_dir, relative)?;
            if !candidate.exists() {
                return Err("要定位的项目文件不存在。".into());
            }
            let canonical = candidate
                .canonicalize()
                .map_err(|_| "无法解析项目文件位置。".to_string())?;
            ensure_inside_project(&project_dir, &canonical)?;
            let reveal = canonical.is_file();
            (canonical, reveal)
        }
        _ => return Err("未知的项目位置目标。".into()),
    };

    if reveal {
        opener.reveal_file(&target)?;
    } else {
        opener.open_directory(&target)?;
    }
    Ok(OpenProjectLocationResult {
        opened: true,
        missing: false,
        target_type: request.target_type.clone(),
        message: None,
    })
}

const FRAME_PREVIEW_LIMIT: usize = 12;
const FRAME_PREVIEW_LONG_EDGE: u32 = 360;
const FRAME_PREVIEW_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const FRAME_PREVIEW_MAX_PIXELS: u64 = 64 * 1024 * 1024;
const PROJECT_THUMBNAIL_MAX_ENTRIES: usize = 50_000;
const PROJECT_THUMBNAIL_MAX_DEPTH: usize = 16;

/// One representative input image for the project library. Unlike the workspace
/// frame strip this never decodes twelve samples, invokes an engine, or writes a cache.
#[tauri::command]
pub async fn get_project_thumbnail(
    project_id: String,
    project_path: String,
) -> Result<Option<FramePreviewItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_project_thumbnail(&project_path, &project_id)
    })
    .await
    .map_err(|_| "项目缩略图任务失败，请重试。".to_string())?
}

fn build_project_thumbnail(
    project_path: &str,
    project_id: &str,
) -> Result<Option<FramePreviewItem>, String> {
    let metadata = std::fs::symlink_metadata(project_path)
        .map_err(|_| "项目目录不存在或无法读取。".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("项目缩略图需要有效的项目目录。".into());
    }
    let manifest = Path::new(project_path).join("project.json");
    let metadata = std::fs::symlink_metadata(&manifest)
        .map_err(|_| "项目记录不存在或无法读取。".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("项目记录必须是项目内的普通文件。".into());
    }
    let root = super::preview::project_root(project_path, project_id)?;
    // Imported source images have already been copied into this directory.
    // Deliberately do not follow any original source path from project metadata.
    let relative = match first_project_thumbnail(&root, "frames", false)? {
        Some(frame) => Some(frame),
        None => first_project_thumbnail(&root, "source", true)?,
    };
    let thumbnail = relative
        .map(|relative| encode_project_preview(&root, &relative))
        .transpose()?;
    // Relinking or replacing a project while decoding must not publish an image
    // for a different project identity under the old library card.
    if super::preview::project_root(project_path, project_id)? != root {
        return Err("项目位置已更新，请刷新后重试。".into());
    }
    Ok(thumbnail)
}

fn first_project_thumbnail(
    root: &Path,
    directory: &str,
    recursive: bool,
) -> Result<Option<String>, String> {
    let path = root.join(directory);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取项目图片目录。".into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("项目图片目录必须是项目内的普通目录。".into());
    }
    let path = super::preview::safe_path(root, directory)?;
    let mut remaining = PROJECT_THUMBNAIL_MAX_ENTRIES;
    let mut first = None;
    find_project_thumbnail(
        root,
        &path,
        Path::new(directory),
        recursive,
        0,
        &mut remaining,
        &mut first,
    )?;
    Ok(first)
}

#[allow(clippy::too_many_arguments)]
fn find_project_thumbnail(
    root: &Path,
    directory: &Path,
    relative: &Path,
    recursive: bool,
    depth: usize,
    remaining: &mut usize,
    first: &mut Option<String>,
) -> Result<(), String> {
    if depth > PROJECT_THUMBNAIL_MAX_DEPTH {
        return Err("项目图片目录层级超出缩略图限制。".into());
    }
    for entry in std::fs::read_dir(directory).map_err(|_| "无法读取项目图片目录。".to_string())?
    {
        if *remaining == 0 {
            return Err("项目图片条目超出缩略图扫描限制。".into());
        }
        *remaining -= 1;
        let entry = entry.map_err(|_| "无法读取项目图片条目。".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "无法读取项目图片类型。".to_string())?;
        if file_type.is_symlink() {
            return Err("项目缩略图不读取符号链接。".into());
        }
        let relative = relative.join(entry.file_name());
        if recursive && file_type.is_dir() {
            let resolved = super::preview::safe_path(
                root,
                relative
                    .to_str()
                    .ok_or_else(|| "项目图片路径无效。".to_string())?,
            )?;
            find_project_thumbnail(
                root,
                &resolved,
                &relative,
                recursive,
                depth + 1,
                remaining,
                first,
            )?;
        } else if file_type.is_file() && is_preview_image(&relative) {
            let candidate = relative
                .to_str()
                .ok_or_else(|| "项目图片路径无效。".to_string())?
                .replace('\\', "/");
            if first.as_ref().is_none_or(|current| &candidate < current) {
                *first = Some(candidate);
            }
        }
    }
    Ok(())
}

fn is_preview_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png"
            )
        })
}

fn encode_project_preview(root: &Path, relative_path: &str) -> Result<FramePreviewItem, String> {
    let requested = root.join(relative_path);
    let requested_metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "图片已被移除，请刷新后重试。".to_string())?;
    if !requested_metadata.is_file() || requested_metadata.file_type().is_symlink() {
        return Err("缩略图必须来自项目内的普通图片文件。".into());
    }
    let path = super::preview::safe_path(root, relative_path)?;
    let before =
        std::fs::symlink_metadata(&path).map_err(|_| "图片已被移除，请刷新后重试。".to_string())?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() > FRAME_PREVIEW_MAX_FILE_BYTES
    {
        return Err("图片无效或超过缩略图的 64 MiB 文件上限。".into());
    }
    let (width, height) = image::image_dimensions(&path)
        .map_err(|_| "无法读取缩略图图片尺寸，请重试。".to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > FRAME_PREVIEW_MAX_PIXELS
    {
        return Err("图片尺寸超出缩略图限制。".into());
    }
    let encoded = encode_preview(&path, FRAME_PREVIEW_LONG_EDGE, 82)
        .map_err(|error| error.user_message_zh())?;
    let after = std::fs::symlink_metadata(&requested)
        .map_err(|_| "图片已被移除，请刷新后重试。".to_string())?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || requested.canonicalize().ok().as_ref() != Some(&path)
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("图片已更新，请刷新后重试。".into());
    }
    Ok(FramePreviewItem {
        relative_path: relative_path.into(),
        width: encoded.width,
        height: encoded.height,
        data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded.bytes)
        ),
    })
}

#[tauri::command]
pub async fn get_frame_preview(
    project_id: String,
    project_path: String,
) -> Result<FramePreview, String> {
    tauri::async_runtime::spawn_blocking(move || build_frame_preview(&project_path, &project_id))
        .await
        .map_err(|_| "抽取帧缩略图任务失败，请重试。".to_string())?
}

fn build_frame_preview(project_path: &str, project_id: &str) -> Result<FramePreview, String> {
    let project_dir = super::preview::project_root(project_path, project_id)?;
    let frames_path = project_dir.join("frames");
    let frames_metadata = match std::fs::symlink_metadata(&frames_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FramePreview {
                items: Vec::new(),
                total_frames: 0,
            });
        }
        Err(_) => return Err("无法读取抽取帧目录，请重试。".into()),
    };
    if !frames_metadata.is_dir() || frames_metadata.file_type().is_symlink() {
        return Err("抽取帧目录不是有效的项目目录。".into());
    }
    let frames_dir = super::preview::safe_path(&project_dir, "frames")?;
    let mut frames = Vec::new();
    for entry in
        std::fs::read_dir(&frames_dir).map_err(|_| "无法读取抽取帧目录，请重试。".to_string())?
    {
        let entry = entry.map_err(|_| "无法读取抽取帧条目，请重试。".to_string())?;
        let path = entry.path();
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png"
                )
            })
        {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| "无法读取抽取帧类型，请重试。".to_string())?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err("抽取帧必须是项目内的普通图片文件。".into());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "抽取帧文件名无效。".to_string())?;
        frames.push(name);
    }
    frames.sort();
    let total_frames = frames.len();
    let items = uniform_sample_indices(total_frames, FRAME_PREVIEW_LIMIT)
        .into_iter()
        .map(|index| {
            let relative_path = format!("frames/{}", frames[index]);
            let path = super::preview::safe_path(&project_dir, &relative_path)?;
            if path.parent() != Some(frames_dir.as_path()) {
                return Err("抽取帧路径超出帧目录。".to_string());
            }
            encode_project_preview(&project_dir, &relative_path)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(FramePreview {
        items,
        total_frames,
    })
}

#[tauri::command]
pub fn get_sparse_preview_pack(project_path: String) -> Result<SparsePreviewPack, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let result = read_json(&project_dir.join("colmap/result.json"))
        .ok_or_else(|| "COLMAP 结果清单尚未生成。".to_string())?;
    let model_relative = result["model_path"]
        .as_str()
        .unwrap_or("colmap/sparse/0")
        .replace('\\', "/");
    let model_dir = secure_relative(&project_dir, &model_relative)?;
    let points = read_colmap_points(&model_dir.join("points3D.bin"), 200_000)?;
    let cameras = read_colmap_images(&model_dir.join("images.bin"))?;
    Ok(SparsePreviewPack {
        model_path: model_relative,
        registered_images: result["registered_images"]
            .as_u64()
            .unwrap_or(cameras.len() as u64),
        total_images: result["total_images"].as_u64().unwrap_or(0),
        point_count: result["point_count"]
            .as_u64()
            .unwrap_or(points.len() as u64),
        mean_reprojection_error: result["mean_reprojection_error"].as_f64(),
        points,
        cameras,
    })
}

#[tauri::command]
pub fn inspect_ply(
    project_path: String,
    relative_path: Option<String>,
) -> Result<PlyPreview, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let relative = relative_path
        .unwrap_or_else(|| "output/scene.ply".into())
        .replace('\\', "/");
    let path = secure_relative(&project_dir, &relative)?;
    parse_ply_preview(&path, &relative, 200_000)
}

pub(crate) fn checkpoint_summaries(project_dir: &Path) -> Result<Vec<CheckpointSummary>, String> {
    let directory = project_dir.join("training/checkpoints");
    let checkpoints =
        CheckpointScanner::scan(&directory).map_err(|error| error.user_message_zh())?;
    let latest = checkpoints.last().map(|checkpoint| checkpoint.iteration);
    let brush_version = recorded_brush_version(project_dir);
    Ok(checkpoints
        .into_iter()
        .map(|checkpoint| {
            let vertex_count = ExportManager::vertex_count(&checkpoint.path).unwrap_or(0);
            CheckpointSummary {
                iteration: checkpoint.iteration,
                relative_path: checkpoint
                    .path
                    .strip_prefix(project_dir)
                    .unwrap_or(&checkpoint.path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                size_bytes: checkpoint.size_bytes,
                created_at: checkpoint.created_at.to_rfc3339(),
                vertex_count,
                valid: vertex_count > 0 && checkpoint.size_bytes > 0,
                current: latest == Some(checkpoint.iteration),
                brush_version: brush_version.clone(),
            }
        })
        .collect())
}

fn recorded_brush_version(project_dir: &Path) -> String {
    #[derive(serde::Deserialize)]
    struct RecordedVersion {
        brush_version: String,
    }
    let result = File::open(project_dir.join("training/result.json"))
        .ok()
        .and_then(|file| serde_json::from_reader::<_, RecordedVersion>(file.take(64 * 1024)).ok())
        .map(|result| result.brush_version)
        .filter(|version| !version.trim().is_empty() && version.len() < 256);
    result
        .or_else(|| {
            splat_project::load_execution_profile(project_dir)
                .ok()
                .flatten()
                .map(|profile| profile.engines.brush.version)
        })
        .map(|version| {
            version
                .strip_prefix("brush-cli ")
                .or_else(|| version.strip_prefix("brush_app "))
                .unwrap_or(&version)
                .to_owned()
        })
        .unwrap_or_else(|| "unknown".into())
}

fn valid_project_dir(project_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_path);
    if !path.join("project.json").is_file() {
        return Err("项目路径无效。".into());
    }
    Ok(path)
}

fn validated_project_identity(project_path: &Path, project_id: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(project_path)
        .map_err(|_| "项目目录已移动或删除。".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("项目路径不是有效的项目目录。".into());
    }
    let canonical = project_path
        .canonicalize()
        .map_err(|_| "无法解析项目目录。".to_string())?;
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
    if project.id.to_string() != project_id {
        return Err("项目身份校验失败，已拒绝打开位置。".into());
    }
    Ok(canonical)
}

fn checked_relative_path(project_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    use std::path::Component;

    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("项目文件路径超出项目目录。".into());
    }
    Ok(project_dir.join(relative_path))
}

fn ensure_inside_project(project_dir: &Path, target: &Path) -> Result<(), String> {
    if target == project_dir || target.starts_with(project_dir) {
        Ok(())
    } else {
        Err("项目文件路径超出项目目录。".into())
    }
}

fn secure_relative(project_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).is_absolute() || relative.contains("..") {
        return Err("产物路径超出项目目录。".into());
    }
    Ok(project_dir.join(relative))
}

fn artifact_item(project_dir: &Path, relative: &str, validate_ply: bool) -> ArtifactItem {
    let path = project_dir.join(relative);
    let metadata = std::fs::metadata(&path).ok();
    let exists = metadata.is_some();
    let validated =
        exists && (!validate_ply || ExportManager::vertex_count(&path).unwrap_or(0) > 0);
    ArtifactItem {
        relative_path: relative.into(),
        exists,
        validated,
        size_bytes: metadata
            .as_ref()
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        updated_at: metadata
            .and_then(|metadata| metadata.modified().ok())
            .map(DateTime::<Utc>::from)
            .map(|time| time.to_rfc3339()),
        error: (exists && !validated).then(|| "产物存在但未通过验证。".into()),
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn read_u64(reader: &mut impl Read) -> Result<u64, String> {
    let mut buffer = [0_u8; 8];
    reader
        .read_exact(&mut buffer)
        .map_err(|_| "COLMAP 二进制模型已截断。".to_string())?;
    Ok(u64::from_le_bytes(buffer))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, String> {
    let mut buffer = [0_u8; 4];
    reader
        .read_exact(&mut buffer)
        .map_err(|_| "COLMAP 二进制模型已截断。".to_string())?;
    Ok(u32::from_le_bytes(buffer))
}

fn read_f64(reader: &mut impl Read) -> Result<f64, String> {
    let mut buffer = [0_u8; 8];
    reader
        .read_exact(&mut buffer)
        .map_err(|_| "COLMAP 二进制模型已截断。".to_string())?;
    Ok(f64::from_le_bytes(buffer))
}

fn read_colmap_points(path: &Path, limit: usize) -> Result<Vec<PreviewPoint>, String> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|_| "无法读取 COLMAP points3D.bin。".to_string())?);
    let count = read_u64(&mut reader)? as usize;
    let stride = (count / limit.max(1)).max(1);
    let mut points = Vec::with_capacity(count.min(limit));
    for index in 0..count {
        let _id = read_u64(&mut reader)?;
        let x = read_f64(&mut reader)? as f32;
        let y = read_f64(&mut reader)? as f32;
        let z = read_f64(&mut reader)? as f32;
        let mut color = [0_u8; 3];
        reader
            .read_exact(&mut color)
            .map_err(|_| "COLMAP 点颜色数据已截断。".to_string())?;
        let _error = read_f64(&mut reader)?;
        let track_length = read_u64(&mut reader)?;
        reader
            .seek(SeekFrom::Current((track_length * 8) as i64))
            .map_err(|_| "COLMAP 点轨迹数据无效。".to_string())?;
        if index % stride == 0 && points.len() < limit {
            points.push(PreviewPoint {
                x,
                y,
                z,
                r: color[0],
                g: color[1],
                b: color[2],
            });
        }
    }
    Ok(points)
}

fn read_colmap_images(path: &Path) -> Result<Vec<PreviewCamera>, String> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|_| "无法读取 COLMAP images.bin。".to_string())?);
    let count = read_u64(&mut reader)? as usize;
    let mut cameras = Vec::with_capacity(count);
    for _ in 0..count {
        let _id = read_u32(&mut reader)?;
        let qw = read_f64(&mut reader)?;
        let qx = read_f64(&mut reader)?;
        let qy = read_f64(&mut reader)?;
        let qz = read_f64(&mut reader)?;
        let tx = read_f64(&mut reader)?;
        let ty = read_f64(&mut reader)?;
        let tz = read_f64(&mut reader)?;
        let _camera_id = read_u32(&mut reader)?;
        let mut name_bytes = Vec::new();
        loop {
            let mut byte = [0_u8; 1];
            reader
                .read_exact(&mut byte)
                .map_err(|_| "COLMAP 图像名称已截断。".to_string())?;
            if byte[0] == 0 {
                break;
            }
            name_bytes.push(byte[0]);
        }
        let point_count = read_u64(&mut reader)?;
        reader
            .seek(SeekFrom::Current((point_count * 24) as i64))
            .map_err(|_| "COLMAP 图像观测数据无效。".to_string())?;
        let r00 = 1.0 - 2.0 * (qy * qy + qz * qz);
        let r01 = 2.0 * (qx * qy - qz * qw);
        let r02 = 2.0 * (qx * qz + qy * qw);
        let r10 = 2.0 * (qx * qy + qz * qw);
        let r11 = 1.0 - 2.0 * (qx * qx + qz * qz);
        let r12 = 2.0 * (qy * qz - qx * qw);
        let r20 = 2.0 * (qx * qz - qy * qw);
        let r21 = 2.0 * (qy * qz + qx * qw);
        let r22 = 1.0 - 2.0 * (qx * qx + qy * qy);
        cameras.push(PreviewCamera {
            x: (-(r00 * tx + r10 * ty + r20 * tz)) as f32,
            y: (-(r01 * tx + r11 * ty + r21 * tz)) as f32,
            z: (-(r02 * tx + r12 * ty + r22 * tz)) as f32,
            forward_x: r20 as f32,
            forward_y: r21 as f32,
            forward_z: r22 as f32,
            up_x: -r10 as f32,
            up_y: -r11 as f32,
            up_z: -r12 as f32,
            name: String::from_utf8_lossy(&name_bytes).to_string(),
        });
    }
    Ok(cameras)
}

fn parse_ply_preview(path: &Path, relative: &str, limit: usize) -> Result<PlyPreview, String> {
    let mut file = File::open(path).map_err(|_| "PLY 文件不存在或无法读取。".to_string())?;
    let size_bytes = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut header = Vec::new();
    let mut byte = [0_u8; 1];
    while header.len() < 64 * 1024 {
        file.read_exact(&mut byte)
            .map_err(|_| "PLY 文件头不完整。".to_string())?;
        header.push(byte[0]);
        if header.ends_with(b"end_header\n") {
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&header);
    let format = header_text
        .lines()
        .find_map(|line| line.strip_prefix("format "))
        .unwrap_or("unknown")
        .to_string();
    let vertex_count = header_text
        .lines()
        .find_map(|line| line.strip_prefix("element vertex "))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let properties = header_text
        .lines()
        .filter_map(|line| line.strip_prefix("property float "))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let x_index = properties
        .iter()
        .position(|property| property == "x")
        .ok_or_else(|| "PLY 缺少 x 坐标。".to_string())?;
    let y_index = properties
        .iter()
        .position(|property| property == "y")
        .ok_or_else(|| "PLY 缺少 y 坐标。".to_string())?;
    let z_index = properties
        .iter()
        .position(|property| property == "z")
        .ok_or_else(|| "PLY 缺少 z 坐标。".to_string())?;
    let dc = ["f_dc_0", "f_dc_1", "f_dc_2"]
        .map(|name| properties.iter().position(|property| property == name));
    let gaussian_compatible = dc.iter().all(Option::is_some)
        && [
            "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
        ]
        .iter()
        .all(|name| properties.iter().any(|property| property == name));
    if !format.starts_with("binary_little_endian") {
        return Err("当前仅支持 Brush 生成的 binary_little_endian PLY。".into());
    }
    let stride = (vertex_count as usize / limit.max(1)).max(1);
    let mut points = Vec::with_capacity((vertex_count as usize).min(limit));
    let mut values = vec![0_f32; properties.len()];
    for index in 0..vertex_count as usize {
        for value in &mut values {
            let mut buffer = [0_u8; 4];
            file.read_exact(&mut buffer)
                .map_err(|_| "PLY 顶点数据已截断。".to_string())?;
            *value = f32::from_le_bytes(buffer);
        }
        if index % stride == 0 && points.len() < limit {
            let color = dc.map(|property| {
                property
                    .map(|property| {
                        ((0.5 + 0.282_094_8 * values[property]).clamp(0.0, 1.0) * 255.0) as u8
                    })
                    .unwrap_or(205)
            });
            points.push(PreviewPoint {
                x: values[x_index],
                y: values[y_index],
                z: values[z_index],
                r: color[0],
                g: color[1],
                b: color[2],
            });
        }
    }
    Ok(PlyPreview {
        relative_path: relative.into(),
        format,
        vertex_count,
        size_bytes,
        gaussian_compatible,
        points,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_preview_transport_returns_inline_thumbnail_data() {
        use base64::Engine as _;
        let (root, project) = location_test_project("frame-preview-red-transport");
        std::fs::create_dir(root.join("frames")).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQLTgCAAIXAVpmh0X/AAAAAElFTkSuQmCC").unwrap();
        std::fs::write(root.join("frames/frame.png"), bytes).unwrap();
        let preview = get_frame_preview(project.id.to_string(), root.to_string_lossy().to_string())
            .await
            .unwrap();
        let value = serde_json::to_value(preview).unwrap();
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
        assert!(
            value["items"][0]["data_url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:image/jpeg;base64,")),
            "Frame IPC must return a bounded JPEG data URL, not a local filesystem path: {value}"
        );
    }

    fn write_preview_image(path: &Path, width: u32, height: u32) {
        image::RgbImage::from_pixel(width, height, image::Rgb([37, 112, 196]))
            .save(path)
            .unwrap();
    }

    #[tokio::test]
    async fn project_thumbnail_prefers_first_frame_and_returns_one_bounded_image_without_writes() {
        let (root, project) = location_test_project("project-thumbnail-frames");
        std::fs::create_dir_all(root.join("frames")).unwrap();
        std::fs::create_dir_all(root.join("source")).unwrap();
        write_preview_image(&root.join("frames/002.jpg"), 30, 20);
        write_preview_image(&root.join("frames/001.jpg"), 120, 480);
        write_preview_image(&root.join("source/000.png"), 20, 30);
        let frame_before = std::fs::read(root.join("frames/001.jpg")).unwrap();
        let project_before = std::fs::read(root.join("project.json")).unwrap();

        let thumbnail =
            get_project_thumbnail(project.id.to_string(), root.to_string_lossy().to_string())
                .await
                .unwrap()
                .unwrap();

        assert_eq!(thumbnail.relative_path, "frames/001.jpg");
        assert_eq!((thumbnail.width, thumbnail.height), (90, 360));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                thumbnail
                    .data_url
                    .strip_prefix("data:image/jpeg;base64,")
                    .unwrap(),
            )
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (90, 360));
        assert_eq!(
            std::fs::read(root.join("frames/001.jpg")).unwrap(),
            frame_before
        );
        assert_eq!(
            std::fs::read(root.join("project.json")).unwrap(),
            project_before
        );
        assert!(!root.join("cache").exists());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn project_thumbnail_falls_back_to_copied_source_in_deterministic_nested_order() {
        let (root, project) = location_test_project("project-thumbnail-source");
        std::fs::create_dir_all(root.join("source/中文 素材")).unwrap();
        write_preview_image(&root.join("source/中文 素材/Z.PNG"), 24, 16);
        write_preview_image(&root.join("source/中文 素材/A.PNG"), 30, 20);
        std::fs::write(root.join("source/notes.txt"), "ignored").unwrap();

        let thumbnail = build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string())
            .unwrap()
            .unwrap();

        assert_eq!(thumbnail.relative_path, "source/中文 素材/A.PNG");
        assert_eq!((thumbnail.width, thumbnail.height), (30, 20));
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn project_thumbnail_without_project_owned_images_is_none_and_never_extracts_video() {
        let (root, project) = location_test_project("project-thumbnail-empty");
        assert!(
            build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string())
                .unwrap()
                .is_none()
        );
        std::fs::create_dir(root.join("source")).unwrap();
        std::fs::write(root.join("source/capture.mp4"), "not a decoded image").unwrap();
        write_preview_image(&root.parent().unwrap().join("outside.png"), 20, 20);

        assert!(
            build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string())
                .unwrap()
                .is_none()
        );
        assert!(!root.join("frames").exists());
        assert!(!root.join("cache").exists());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn project_thumbnail_rejects_wrong_identity_and_corrupt_input() {
        let (root, project) = location_test_project("project-thumbnail-invalid");
        std::fs::create_dir(root.join("source")).unwrap();
        write_preview_image(&root.join("source/photo.png"), 20, 20);
        assert!(build_project_thumbnail(root.to_str().unwrap(), "another-project").is_err());
        std::fs::write(root.join("source/photo.png"), "not an image").unwrap();
        assert!(build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn project_thumbnail_checks_file_and_pixel_budgets_before_decode() {
        let (root, project) = location_test_project("project-thumbnail-budgets");
        std::fs::create_dir(root.join("frames")).unwrap();
        let path = root.join("frames/photo.jpg");
        let file = File::create(&path).unwrap();
        file.set_len(FRAME_PREVIEW_MAX_FILE_BYTES + 1).unwrap();
        drop(file);
        let error =
            build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).unwrap_err();
        assert!(error.contains("64 MiB"));

        write_preview_image(&path, 1, 1);
        let mut bytes = std::fs::read(&path).unwrap();
        let start = bytes
            .windows(2)
            .position(|bytes| bytes == [0xff, 0xc0])
            .unwrap();
        // JPEG SOF dimensions have no checksum. This remains a small header,
        // but declares 4.2 billion pixels that must be rejected before decode.
        bytes[start + 5..start + 9].fill(0xff);
        std::fs::write(&path, bytes).unwrap();
        let error =
            build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).unwrap_err();
        assert!(error.contains("尺寸超出"), "unexpected error: {error}");
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn project_thumbnail_directory_walk_is_bounded() {
        let (root, _) = location_test_project("project-thumbnail-walk");
        std::fs::create_dir(root.join("source")).unwrap();
        write_preview_image(&root.join("source/photo.png"), 20, 20);
        let mut remaining = 0;
        assert!(find_project_thumbnail(
            &root,
            &root.join("source"),
            Path::new("source"),
            true,
            0,
            &mut remaining,
            &mut None,
        )
        .unwrap_err()
        .contains("扫描限制"));
        assert!(find_project_thumbnail(
            &root,
            &root.join("source"),
            Path::new("source"),
            true,
            PROJECT_THUMBNAIL_MAX_DEPTH + 1,
            &mut 1,
            &mut None,
        )
        .unwrap_err()
        .contains("层级"));
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_thumbnail_rejects_linked_directories_images_and_manifest() {
        use std::os::unix::fs::symlink;
        let (root, project) = location_test_project("project-thumbnail-links");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        write_preview_image(&outside.join("private.png"), 20, 20);
        symlink(&outside, root.join("frames")).unwrap();
        assert!(build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_file(root.join("frames")).unwrap();

        std::fs::create_dir(root.join("source")).unwrap();
        symlink(&outside, root.join("source/nested")).unwrap();
        assert!(build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_file(root.join("source/nested")).unwrap();
        symlink(outside.join("private.png"), root.join("source/photo.png")).unwrap();
        assert!(build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_file(root.join("source/photo.png")).unwrap();

        std::fs::rename(root.join("project.json"), outside.join("project.json")).unwrap();
        symlink(outside.join("project.json"), root.join("project.json")).unwrap();
        assert!(build_project_thumbnail(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn frame_preview_returns_bounded_jpeg_samples_with_real_dimensions() {
        let (root, project) = location_test_project("frame-preview-jpeg");
        let frames = root.join("frames");
        std::fs::create_dir(&frames).unwrap();
        for index in 0..15 {
            write_preview_image(&frames.join(format!("frame-{index:03}.jpg")), 120, 480);
        }
        std::fs::write(frames.join("frames.json"), "{}").unwrap();
        let first_before = std::fs::read(frames.join("frame-000.jpg")).unwrap();
        let preview = build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).unwrap();
        assert_eq!(preview.total_frames, 15);
        assert_eq!(preview.items.len(), 12);
        assert_eq!(preview.items[0].relative_path, "frames/frame-000.jpg");
        assert_eq!(preview.items[11].relative_path, "frames/frame-014.jpg");
        for item in preview.items {
            let data = item
                .data_url
                .strip_prefix("data:image/jpeg;base64,")
                .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap();
            assert!(bytes.starts_with(&[0xff, 0xd8]));
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!(
                (item.width, item.height),
                (decoded.width(), decoded.height())
            );
            assert_eq!((item.width, item.height), (90, 360));
        }
        assert_eq!(
            std::fs::read(frames.join("frame-000.jpg")).unwrap(),
            first_before
        );
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn frame_preview_missing_frames_are_empty_but_corrupt_frames_fail() {
        let (root, project) = location_test_project("frame-preview-errors");
        let preview = build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).unwrap();
        assert_eq!(preview.total_frames, 0);
        assert!(preview.items.is_empty());
        assert!(build_frame_preview(root.to_str().unwrap(), "another-project").is_err());
        std::fs::create_dir(root.join("frames")).unwrap();
        std::fs::write(root.join("frames/broken.jpg"), "not an image").unwrap();
        assert!(build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn frame_preview_rejects_large_input_before_decode() {
        let (root, project) = location_test_project("frame-preview-large");
        std::fs::create_dir(root.join("frames")).unwrap();
        let file = File::create(root.join("frames/oversized.png")).unwrap();
        file.set_len(FRAME_PREVIEW_MAX_FILE_BYTES + 1).unwrap();
        let error =
            build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).unwrap_err();
        assert!(error.contains("64 MiB"));
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn frame_preview_rejects_linked_frames_and_frame_directory() {
        use std::os::unix::fs::symlink;
        let (root, project) = location_test_project("frame-preview-links");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        write_preview_image(&outside.join("private.png"), 10, 10);
        std::fs::create_dir(root.join("frames")).unwrap();
        symlink(outside.join("private.png"), root.join("frames/frame.png")).unwrap();
        assert!(build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_file(root.join("frames/frame.png")).unwrap();
        std::fs::remove_dir(root.join("frames")).unwrap();
        symlink(&outside, root.join("frames")).unwrap();
        assert!(build_frame_preview(root.to_str().unwrap(), &project.id.to_string()).is_err());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn checkpoint_version_uses_recorded_engine_and_never_assumes_legacy_brush() {
        let (root, _) = location_test_project("checkpoint-version");
        assert_eq!(recorded_brush_version(&root), "unknown");
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::write(
            root.join("runtime/execution-profile.json"),
            include_str!(
                "../../../../../schemas/examples/execution-profile/macos-patched.valid.json"
            ),
        )
        .unwrap();
        let profile = splat_project::load_execution_profile(&root)
            .unwrap()
            .unwrap();
        assert_eq!(recorded_brush_version(&root), profile.engines.brush.version);
        std::fs::create_dir_all(root.join("training")).unwrap();
        std::fs::write(
            root.join("training/result.json"),
            r#"{"brush_version":"brush_app 0.3.0"}"#,
        )
        .unwrap();
        assert_eq!(recorded_brush_version(&root), "0.3.0");
        std::fs::write(
            root.join("training/result.json"),
            r#"{"brush_version":"brush-cli 1.0.0+metorigin-macos.5"}"#,
        )
        .unwrap();
        assert_eq!(recorded_brush_version(&root), "1.0.0+metorigin-macos.5");
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn jsonl_retention_keeps_only_complete_tail_records() {
        let root =
            std::env::temp_dir().join(format!("metorigin-jsonl-retention-{}", std::process::id()));
        let path = root.join("events.jsonl");
        std::fs::create_dir_all(&root).unwrap();
        let records = (0..20)
            .map(|index| format!(r#"{{"index":{index},"message":"event-{index}"}}"#))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(&path, records).unwrap();

        trim_jsonl_log(&path, 160).unwrap();

        let trimmed = std::fs::read_to_string(&path).unwrap();
        assert!(trimmed.len() <= 160);
        assert!(!trimmed.is_empty());
        assert!(trimmed
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
        let _ = std::fs::remove_dir_all(root);
    }
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeLocationOpener {
        opened: Mutex<Vec<PathBuf>>,
        revealed: Mutex<Vec<PathBuf>>,
    }

    impl LocationOpener for FakeLocationOpener {
        fn open_directory(&self, path: &Path) -> Result<(), String> {
            self.opened.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }

        fn reveal_file(&self, path: &Path) -> Result<(), String> {
            self.revealed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    fn location_test_project(label: &str) -> (PathBuf, splat_domain::project::Project) {
        let root = std::env::temp_dir().join(format!(
            "metorigin-location-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project_dir = root.join("project.splat-project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let project = splat_domain::project::Project::new("位置测试");
        ProjectManager::new(root)
            .save_project(&project, &project_dir)
            .unwrap();
        (project_dir, project)
    }

    #[test]
    fn project_location_opens_root_creates_output_and_reveals_artifact() {
        let (project_dir, project) = location_test_project("valid");
        let opener = FakeLocationOpener::default();
        let mut request = OpenProjectLocationRequest {
            project_id: project.id.to_string(),
            project_path: project_dir.to_string_lossy().to_string(),
            target_type: "project_root".into(),
            relative_path: None,
        };
        assert!(
            open_project_location_with(&request, &opener)
                .unwrap()
                .opened
        );

        request.target_type = "output_directory".into();
        assert!(
            open_project_location_with(&request, &opener)
                .unwrap()
                .opened
        );
        assert!(project_dir.join("output").is_dir());

        let artifact = project_dir.join("output/scene.ply");
        std::fs::write(&artifact, b"ply").unwrap();
        request.target_type = "artifact".into();
        request.relative_path = Some("output/scene.ply".into());
        assert!(
            open_project_location_with(&request, &opener)
                .unwrap()
                .opened
        );
        assert_eq!(opener.opened.lock().unwrap().len(), 2);
        assert_eq!(
            opener.revealed.lock().unwrap().as_slice(),
            &[artifact.canonicalize().unwrap()]
        );
        let _ = std::fs::remove_dir_all(project_dir.parent().unwrap());
    }

    #[test]
    fn project_location_rejects_wrong_identity_and_parent_traversal() {
        let (project_dir, project) = location_test_project("invalid");
        let opener = FakeLocationOpener::default();
        let mut request = OpenProjectLocationRequest {
            project_id: "wrong-id".into(),
            project_path: project_dir.to_string_lossy().to_string(),
            target_type: "project_root".into(),
            relative_path: None,
        };
        assert!(open_project_location_with(&request, &opener).is_err());

        request.project_id = project.id.to_string();
        request.target_type = "artifact".into();
        request.relative_path = Some("../outside.txt".into());
        assert!(open_project_location_with(&request, &opener).is_err());
        assert!(opener.opened.lock().unwrap().is_empty());
        assert!(opener.revealed.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(project_dir.parent().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn project_location_rejects_symlink_escape_when_supported() {
        use std::os::windows::fs::symlink_file;

        let (project_dir, project) = location_test_project("symlink");
        let outside = project_dir.parent().unwrap().join("outside.ply");
        std::fs::write(&outside, b"ply").unwrap();
        let link = project_dir.join("escaped.ply");
        if symlink_file(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(project_dir.parent().unwrap());
            return;
        }
        let request = OpenProjectLocationRequest {
            project_id: project.id.to_string(),
            project_path: project_dir.to_string_lossy().to_string(),
            target_type: "artifact".into(),
            relative_path: Some("escaped.ply".into()),
        };
        assert!(open_project_location_with(&request, &FakeLocationOpener::default()).is_err());
        let _ = std::fs::remove_dir_all(project_dir.parent().unwrap());
    }

    #[test]
    fn missing_project_location_returns_actionable_result() {
        let opener = FakeLocationOpener::default();
        let request = OpenProjectLocationRequest {
            project_id: "missing".into(),
            project_path: std::env::temp_dir()
                .join("metorigin-project-does-not-exist")
                .to_string_lossy()
                .to_string(),
            target_type: "project_root".into(),
            relative_path: None,
        };
        let result = open_project_location_with(&request, &opener).unwrap();
        assert!(result.missing);
        assert!(!result.opened);
    }

    #[test]
    fn parses_binary_brush_ply_positions_and_colors() {
        let directory =
            std::env::temp_dir().join(format!("metorigin-ply-preview-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("scene.ply");
        let header = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
        let mut file = File::create(&path).unwrap();
        file.write_all(header).unwrap();
        for value in [0.0_f32; 11].into_iter().chain([1.0, 2.0, 3.0]) {
            file.write_all(&value.to_le_bytes()).unwrap();
        }
        drop(file);
        let preview = parse_ply_preview(&path, "scene.ply", 10).unwrap();
        assert_eq!(preview.vertex_count, 1);
        assert!(preview.gaussian_compatible);
        assert_eq!(preview.points[0].x, 1.0);
        assert_eq!(preview.points[0].z, 3.0);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn current_technical_spike_artifacts_are_readable_when_present() {
        let project = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.artifacts/technical-spike/ffmpeg-fast.splat-project");
        let ply = project.join("output/scene.ply");
        if !ply.is_file() {
            return;
        }
        let preview = parse_ply_preview(&ply, "output/scene.ply", 200_000).unwrap();
        assert_eq!(preview.vertex_count, 70_035);
        assert_eq!(preview.points.len(), 70_035);
        let colmap = read_json(&project.join("colmap/result.json")).unwrap();
        assert_eq!(colmap["registered_images"].as_u64(), Some(196));
        assert_eq!(colmap["point_count"].as_u64(), Some(28_365));
    }
}
