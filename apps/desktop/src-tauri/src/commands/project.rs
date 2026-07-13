use std::path::PathBuf;

use splat_project::ProjectManager;

use crate::state::{AppState, ProjectInfo};

/// Analyze a media file and return its metadata (for the new-project wizard).
#[tauri::command]
pub fn analyze_media(path: String) -> Result<serde_json::Value, String> {
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

    let is_image = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "jpg" | "jpeg" | "png"))
        .unwrap_or(false);

    if is_video {
        // Try to probe video metadata
        match splat_engine_ffmpeg::probe::probe_video(&path) {
            Ok(meta) => Ok(serde_json::json!({
                "type": "video",
                "valid": true,
                "video_metadata": {
                    "width": meta.width,
                    "height": meta.height,
                    "fps": meta.fps,
                    "frame_count": meta.frame_count,
                    "duration_seconds": meta.duration_seconds,
                    "codec": meta.codec,
                    "rotation": meta.rotation,
                },
                "estimated_frames": meta.frame_count.max(
                    (meta.fps * meta.duration_seconds).ceil() as u64
                ),
                "estimated_disk_mb": (meta.frame_count as f64 * 0.3).ceil(),
            })),
            Err(e) => {
                // If ffprobe fails, return basic info
                Ok(serde_json::json!({
                    "type": "video",
                    "valid": true,
                    "video_metadata": null,
                    "estimated_frames": 0,
                    "estimated_disk_mb": 0,
                    "warning": format!("无法读取媒体元数据：{}", e.user_message_zh()),
                }))
            }
        }
    } else if is_image || path.is_dir() {
        // Count images in folder
        let search_dir = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(&path).to_path_buf()
        };
        let image_count = count_images_in_dir(&search_dir);
        Ok(serde_json::json!({
            "type": "images",
            "valid": image_count > 0,
            "image_count": image_count,
            "estimated_frames": image_count,
            "estimated_disk_mb": (image_count as f64 * 1.5).ceil(),
        }))
    } else {
        Err(format!("不支持的文件格式：{}", path.display()))
    }
}

/// Create a new project.
#[tauri::command]
pub fn create_project(
    name: String,
    source_path: String,
    preset: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let default_dir = dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetaOrigin Projects");

    let manager = ProjectManager::new(default_dir);
    let (project, project_dir) = manager
        .create_project(&name)
        .map_err(|e| e.user_message_zh())?;

    // Copy source media into the project
    let source = PathBuf::from(&source_path);
    let project_source_dir = project_dir.join("source");
    std::fs::create_dir_all(&project_source_dir)
        .map_err(|_| "创建项目源媒体目录失败，请检查目录权限。".to_string())?;

    if source.is_file() {
        let dest = project_source_dir.join(source.file_name().unwrap_or_default());
        let _ = std::fs::copy(&source, &dest);
    } else if source.is_dir() {
        for entry in std::fs::read_dir(&source)
            .map_err(|_| "读取源媒体目录失败，请检查路径和访问权限。".to_string())?
            .flatten()
        {
            let file_path = entry.path();
            if file_path.is_file() {
                if let Some(ext) = file_path.extension() {
                    let ext_lower = ext.to_string_lossy().to_lowercase();
                    if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "mp4" | "mov") {
                        let dest =
                            project_source_dir.join(file_path.file_name().unwrap_or_default());
                        let _ = std::fs::copy(&file_path, &dest);
                    }
                }
            }
        }
    }

    // Save preset
    let mut project = project;
    project.settings.preset = preset;
    manager
        .save_project(&project, &project_dir)
        .map_err(|e| e.user_message_zh())?;

    // Add to recent projects
    let info = ProjectInfo {
        id: project.id.to_string(),
        name: project.name.clone(),
        path: project_dir.to_string_lossy().to_string(),
        status: "ready".to_string(),
        updated_at: project.updated_at.to_rfc3339(),
        stage_label: None,
    };

    if let Ok(mut inner) = state.0.lock() {
        inner.project_dir = Some(project_dir.clone());
        inner.recent_projects.push(info);
    }

    Ok(serde_json::json!({
        "id": project.id.to_string(),
        "name": project.name,
        "path": project_dir.to_string_lossy().to_string(),
        "status": "ready",
    }))
}

/// Open an existing project and return its data.
#[tauri::command]
pub fn open_project(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let project_dir = PathBuf::from(&path);
    let default_dir = dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetaOrigin Projects");
    let manager = ProjectManager::new(default_dir);
    let project = manager
        .open_project(&project_dir)
        .map_err(|e| e.user_message_zh())?;

    let json = serde_json::to_value(&project)
        .map_err(|_| "读取项目数据失败，请重试并查看日志。".to_string())?;

    // Update state
    if let Ok(mut inner) = state.0.lock() {
        inner.project_dir = Some(project_dir);
    }

    Ok(json)
}

/// List recent projects from state.
#[tauri::command]
pub fn list_recent_projects(state: tauri::State<'_, AppState>) -> Result<Vec<ProjectInfo>, String> {
    let inner = state
        .0
        .lock()
        .map_err(|_| "读取最近项目列表失败，请重启应用后重试。".to_string())?;
    let mut projects = inner.recent_projects.clone();
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

fn count_images_in_dir(dir: &std::path::Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg" | "png"))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}
