use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use splat_domain::project::ProjectStatus;
use splat_domain::{PipelineStageId, StageStatus};
use splat_engine_brush::{CheckpointScanner, ExportManager};
use splat_project::ProjectManager;

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
    iteration: u32,
    relative_path: String,
    size_bytes: u64,
    created_at: String,
    vertex_count: u64,
    valid: bool,
    current: bool,
    brush_version: String,
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
    splat_count: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FramePreview {
    items: Vec<String>,
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

pub fn append_pipeline_event(project_dir: &Path, record: &PipelineEventRecord) {
    let logs = project_dir.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    let path = logs.join("events.jsonl");
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
) -> Result<Vec<CheckpointSummary>, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let checkpoints = checkpoint_summaries(&project_dir)?;
    let selected = checkpoints
        .iter()
        .find(|checkpoint| checkpoint.iteration == iteration && checkpoint.valid)
        .ok_or_else(|| "指定 Checkpoint 不存在或未通过验证。".to_string())?;
    let invalidated_dir = project_dir
        .join("training/checkpoints/invalidated")
        .join(Utc::now().format("%Y%m%d-%H%M%S").to_string());
    for checkpoint in checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.iteration > selected.iteration)
    {
        std::fs::create_dir_all(&invalidated_dir)
            .map_err(|_| "创建失效 Checkpoint 目录失败。".to_string())?;
        let source = secure_relative(&project_dir, &checkpoint.relative_path)?;
        let destination = invalidated_dir.join(source.file_name().unwrap_or_default());
        std::fs::rename(source, destination)
            .map_err(|_| "移动下游 Checkpoint 失败，请检查文件占用。".to_string())?;
    }
    invalidate_training_from(&project_dir, PipelineStageId::BrushTraining)?;
    checkpoint_summaries(&project_dir)
}

#[tauri::command]
pub fn get_project_artifacts(project_path: String) -> Result<ArtifactSummary, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let colmap_json = read_json(&project_dir.join("colmap/result.json"));
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
        splat_count: output_json
            .as_ref()
            .and_then(|value| value["ply"]["vertex_count"].as_u64()),
    })
}

#[tauri::command]
pub fn get_frame_preview(project_path: String) -> Result<FramePreview, String> {
    let project_dir = valid_project_dir(&project_path)?;
    let mut frames = std::fs::read_dir(project_dir.join("frames"))
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
    frames.sort();
    let total = frames.len();
    let indexes = if total <= 12 {
        (0..total).collect::<Vec<_>>()
    } else {
        (0..12)
            .map(|index| index * (total - 1) / 11)
            .collect::<Vec<_>>()
    };
    Ok(FramePreview {
        items: indexes
            .into_iter()
            .map(|index| frames[index].to_string_lossy().to_string())
            .collect(),
        total_frames: total,
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

fn checkpoint_summaries(project_dir: &Path) -> Result<Vec<CheckpointSummary>, String> {
    let directory = project_dir.join("training/checkpoints");
    let checkpoints =
        CheckpointScanner::scan(&directory).map_err(|error| error.user_message_zh())?;
    let latest = checkpoints.last().map(|checkpoint| checkpoint.iteration);
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
                brush_version: "0.3.0".into(),
            }
        })
        .collect())
}

fn valid_project_dir(project_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_path);
    if !path.join("project.json").is_file() {
        return Err("项目路径无效。".into());
    }
    Ok(path)
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

fn invalidate_training_from(project_dir: &Path, selected: PipelineStageId) -> Result<(), String> {
    let manager = ProjectManager::new(project_dir.parent().unwrap_or(project_dir).to_path_buf());
    let mut project = manager
        .open_project(project_dir)
        .map_err(|error| error.user_message_zh())?;
    let index = PipelineStageId::all()
        .iter()
        .position(|stage| *stage == selected)
        .unwrap_or(0);
    for stage in &PipelineStageId::all()[index..] {
        if let Some(state) = project.pipeline_state.stages.get_mut(stage) {
            state.status = if *stage == selected {
                StageStatus::Paused
            } else {
                StageStatus::Pending
            };
            state.progress = 0.0;
            state.started_at = None;
            state.ended_at = None;
            state.error = None;
        }
    }
    project.pipeline_state.current_stage = None;
    project.current_stage = None;
    project.status = ProjectStatus::Paused;
    project.touch();
    manager
        .save_project(&project, project_dir)
        .map_err(|error| error.user_message_zh())
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
