use std::path::PathBuf;

use splat_domain::project::{ImageFolderSource, ProjectSource, VideoSource};
use splat_hardware::EngineLocator;
use splat_project::ProjectManager;
use tauri::Manager;

use crate::state::{AppState, ProjectInfo};

/// Analyze a media file and return its metadata (for the new-project wizard).
#[tauri::command]
pub fn analyze_media(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
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
        let resource_engines = app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|path| path.join("engines"));
        let engine_paths = EngineLocator::resolve(resource_engines.as_deref());
        let Some(ffprobe) = engine_paths.ffprobe else {
            return Ok(serde_json::json!({
                "type": "video",
                "valid": true,
                "video_metadata": null,
                "estimated_frames": 0,
                "estimated_disk_mb": 0,
                "warning": "未找到 FFprobe。请先在引擎设置中定位 FFmpeg 引擎。",
            }));
        };

        match splat_engine_ffmpeg::probe::probe_video_with(&ffprobe, &path) {
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
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let default_dir = dirs_next::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MetaOrigin Projects");

    let manager = ProjectManager::new(default_dir);
    let (project, project_dir) = manager
        .create_project(&name)
        .map_err(|e| e.user_message_zh())?;

    // Copy source media into the project and persist what was imported.
    let source = PathBuf::from(&source_path);
    let project_source_dir = project_dir.join("source");
    let imported_source = (|| -> Result<ProjectSource, String> {
        std::fs::create_dir_all(&project_source_dir)
            .map_err(|_| "创建项目源媒体目录失败，请检查目录权限。".to_string())?;

        if source.is_file() {
            let filename = source
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "所选视频文件名无效，请重新选择。".to_string())?
                .to_string();
            let dest = project_source_dir.join(&filename);
            std::fs::copy(&source, &dest)
                .map_err(|_| "复制视频失败，请检查源文件和项目目录的访问权限。".to_string())?;
            Ok(ProjectSource::Video(VideoSource {
                filename,
                copied_to_project: true,
            }))
        } else if source.is_dir() {
            let mut image_count = 0usize;
            for entry in std::fs::read_dir(&source)
                .map_err(|_| "读取源媒体目录失败，请检查路径和访问权限。".to_string())?
                .flatten()
            {
                let file_path = entry.path();
                if file_path.is_file() {
                    if let Some(ext) = file_path.extension() {
                        let ext_lower = ext.to_string_lossy().to_lowercase();
                        if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png") {
                            let dest =
                                project_source_dir.join(file_path.file_name().unwrap_or_default());
                            std::fs::copy(&file_path, &dest).map_err(|_| {
                                "复制图片失败，请检查源文件和项目目录的访问权限。".to_string()
                            })?;
                            image_count += 1;
                        }
                    }
                }
            }
            if image_count == 0 {
                return Err("所选文件夹中没有可用的 JPG、JPEG 或 PNG 图片。".to_string());
            }
            Ok(ProjectSource::ImageFolder(ImageFolderSource {
                folder_name: source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("图片素材")
                    .to_string(),
                image_count,
                copied_to_project: true,
            }))
        } else {
            Err("所选素材不存在，请重新选择。".to_string())
        }
    })();

    let imported_source = match imported_source {
        Ok(imported_source) => imported_source,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&project_dir);
            return Err(error);
        }
    };

    // Save preset
    let mut project = project;
    project.source = Some(imported_source);
    project.settings.preset = preset;
    project.touch();
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

    record_recent_project(&app_handle, &state, info, Some(project_dir.clone()))?;

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
    record_recent_project(&app_handle, &state, info, Some(project_dir))?;

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
    state: &tauri::State<'_, AppState>,
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
}
