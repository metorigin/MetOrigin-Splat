use std::path::{Path, PathBuf};
use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_domain::project::{Project, ProjectSource};
use splat_engine_ffmpeg::progress::FfmpegFrameParser;
use splat_engine_ffmpeg::{
    load_builtin_preset, validate_frames, write_manifest_atomic, FfmpegAdapter, FrameManifest,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::image_input::{
    assign_camera_groups, normalize_image_to_jpeg_with_orientation, read_image_manifest,
    scan_image_directory, uniform_sample_indices, validate_image_manifest,
    write_image_manifest_atomic, ImageFrameManifest, ImageFrameSource,
};
use crate::stage::{PipelineStage, StageContext};

/// Extracts frames from video using FFmpeg.
///
/// This stage delegates to `FfmpegAdapter` for:
/// - Probing video metadata (via FFprobe)
/// - Computing the extraction plan (fps, scaling, rotation)
/// - Building and executing the FFmpeg command
/// - Parsing frame extraction progress
/// - Validating and generating the frame manifest
///
pub struct FrameExtractionStage {
    /// The FFmpeg preset to use for extraction parameters.
    preset_name: String,
}

impl FrameExtractionStage {
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
        }
    }
}

#[async_trait::async_trait]
impl PipelineStage for FrameExtractionStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::FrameExtraction
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        // Source directory must have media files
        if !ctx.paths.source_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Source Media Missing",
                "No source media found. Import a video or images before extracting frames.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.frames_manifest.exists() || !has_frames(&ctx.paths.frames_dir) {
            return Ok(false);
        }
        if is_image_project(ctx)? {
            let manifest = match read_image_manifest(&ctx.paths.frames_manifest) {
                Ok(Some(manifest)) => manifest,
                _ => return Ok(false),
            };
            return Ok(validate_image_manifest(&ctx.paths.frames_dir, &manifest).is_ok());
        }
        let manifest = match read_manifest(&ctx.paths.frames_manifest) {
            Ok(manifest) => manifest,
            Err(_) => return Ok(false),
        };
        let validated = match validate_frames(
            &ctx.paths.frames_dir,
            &manifest.extraction_plan,
            &manifest.source_metadata,
        ) {
            Ok(validated) => validated,
            Err(_) => return Ok(false),
        };
        Ok(validated.total_frames == manifest.total_frames)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let preset_name = ctx.preset.as_deref().unwrap_or(&self.preset_name);
        if is_image_project(ctx)? {
            return prepare_image_frames(ctx, preset_name, progress_tx).await;
        }
        tracing::info!("Video frame extraction started (preset: {})", preset_name);

        let video_path = find_unique_video(&ctx.paths.source_dir)?;
        let ffmpeg_path = require_engine(ctx.engine_paths.ffmpeg.as_ref(), "FFmpeg")?;
        let ffprobe_path = require_engine(ctx.engine_paths.ffprobe.as_ref(), "FFprobe")?;
        let adapter = FfmpegAdapter::from_paths(ffmpeg_path.clone(), ffprobe_path.clone())?;
        let metadata = adapter
            .probe_metadata_async(&video_path, ctx.cancellation.clone())
            .await?;
        let project = load_project(ctx)?;
        let mut preset = load_builtin_preset(preset_name)?;
        preset.frame_extraction.target_long_edge = project.settings.resolved_colmap_max_long_edge();
        if project.settings.max_frames > 0 {
            preset.frame_extraction.max_frames = project.settings.max_frames;
        }
        if let Some(fps) = project.settings.frame_fps.filter(|fps| *fps > 0.0) {
            preset.frame_extraction.fps = fps;
        }
        let plan = adapter.plan_extraction(&metadata, &preset.frame_extraction);

        prepare_output_directory(&ctx.paths.frames_dir, &ctx.paths.frames_manifest)?;
        let command = adapter
            .build_command(&plan, &video_path, &ctx.paths.frames_dir, &ctx.log_path)
            .with_timeout(Duration::from_secs(2 * 60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(FfmpegFrameParser::new(
            format!("{:?}", self.id()),
            plan.target_frame_count as u64,
        )));
        let runner = ProcessRunner::with_parser(parsers);
        let result = runner
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;

        if result.cancelled {
            return Err(AppError::new(
                "E-2104",
                ErrorCategory::Engine,
                "FFmpeg Cancelled",
                "Frame extraction was cancelled by the user.",
            ));
        }
        if result.timed_out {
            return Err(AppError::new(
                "E-2105",
                ErrorCategory::Engine,
                "FFmpeg Timed Out",
                "Frame extraction exceeded the two-hour safety timeout.",
            )
            .retryable(true));
        }
        if !result.is_success() {
            return Err(AppError::new(
                "E-2102",
                ErrorCategory::Engine,
                "FFmpeg Frame Extraction Failed",
                "FFmpeg could not extract frames from the source video. Check the stage log for details.",
            )
            .with_technical(format!(
                "exit_code={:?}, log_path={:?}",
                result.exit_code, result.log_path
            ))
            .retryable(true));
        }

        let manifest = validate_frames(&ctx.paths.frames_dir, &plan, &metadata)?;
        write_manifest_atomic(&manifest, &ctx.paths.frames_manifest)?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.frames_manifest.exists() {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Frame Extraction Output Missing",
                "The frame manifest (frames/frames.json) was not created. Extraction may have failed.",
            ));
        }
        if is_image_project(ctx)? {
            let manifest = read_image_manifest(&ctx.paths.frames_manifest)?.ok_or_else(|| {
                AppError::new(
                    "E-1103",
                    ErrorCategory::Media,
                    "Image Frame Manifest Missing",
                    "图片项目没有生成兼容的 frames/frames.json。",
                )
            })?;
            return validate_image_manifest(&ctx.paths.frames_dir, &manifest);
        }
        let manifest = read_manifest(&ctx.paths.frames_manifest)?;
        let validated = validate_frames(
            &ctx.paths.frames_dir,
            &manifest.extraction_plan,
            &manifest.source_metadata,
        )?;
        if validated.total_frames != manifest.total_frames {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Frame Manifest Mismatch",
                "The frame manifest does not match the extracted JPEG files.",
            ));
        }
        Ok(())
    }
}

fn load_project(ctx: &StageContext) -> AppResult<Project> {
    let path = ctx.project_dir.join("project.json");
    let json = std::fs::read_to_string(&path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Project",
            "无法读取 project.json 以确定素材类型。",
        )
        .with_technical(error.to_string())
    })?;
    serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "project.json 无法解析，不能安全准备帧。",
        )
        .with_technical(error.to_string())
    })
}

fn is_image_project(ctx: &StageContext) -> AppResult<bool> {
    Ok(matches!(
        load_project(ctx)?.source,
        Some(ProjectSource::ImageFolder(_))
    ))
}

async fn prepare_image_frames(
    ctx: &StageContext,
    preset_name: &str,
    progress_tx: broadcast::Sender<TaskProgress>,
) -> AppResult<StageState> {
    let project = load_project(ctx)?;
    let preset = load_builtin_preset(preset_name)?;
    let max_frames = if project.settings.max_frames > 0 {
        project.settings.max_frames
    } else {
        preset.frame_extraction.max_frames
    } as usize;
    let reconstruction_long_edge = if project.settings.resolved_colmap_max_long_edge() > 0 {
        project.settings.resolved_colmap_max_long_edge()
    } else {
        preset.frame_extraction.resolved_colmap_long_edge()
    };
    let training_long_edge = if project.settings.max_long_edge > 0 {
        project.settings.max_long_edge
    } else {
        preset.frame_extraction.target_long_edge
    };
    let scan = scan_image_directory(&ctx.paths.source_dir)?;
    if scan.images.len() < 3 {
        return Err(AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Not Enough Valid Images",
            format!(
                "项目 source/ 中只有 {} 张有效图片，帧准备至少需要 3 张。",
                scan.images.len()
            ),
        ));
    }

    let selected = uniform_sample_indices(scan.images.len(), max_frames);
    let preparing_dir = ctx.project_dir.join("frames.preparing");
    let backup_dir = ctx.project_dir.join("frames.previous");
    if preparing_dir.exists() {
        std::fs::remove_dir_all(&preparing_dir)
            .map_err(|error| filesystem_stage_error("Failed to Clear Temporary Frames", error))?;
    }
    std::fs::create_dir_all(&preparing_dir)
        .map_err(|error| filesystem_stage_error("Failed to Create Temporary Frames", error))?;

    let total = selected.len();
    let mut frames = Vec::with_capacity(total);
    let mut frame_sources = Vec::with_capacity(total);
    let mut skipped_items = scan.invalid_items.clone();
    for (position, source_index) in selected.into_iter().enumerate() {
        if ctx.cancellation.is_cancelled() {
            let _ = std::fs::remove_dir_all(&preparing_dir);
            return Err(AppError::new(
                "E-2104",
                ErrorCategory::Engine,
                "Image Preparation Cancelled",
                "图片标准化已由用户取消，正式 frames/ 产物未改变。",
            ));
        }
        let candidate = &scan.images[source_index];
        let filename = format!("{:06}.jpg", frames.len() + 1);
        let destination = preparing_dir.join(&filename);
        match normalize_image_to_jpeg_with_orientation(
            &candidate.path,
            &destination,
            reconstruction_long_edge,
            92,
            candidate.orientation,
        ) {
            Ok(mut frame) => {
                frame.index = frames.len() as u32;
                frame.filename = filename;
                tracing::info!(
                    source = %candidate.relative_path,
                    width = frame.width,
                    height = frame.height,
                    "image normalized"
                );
                frame_sources.push(ImageFrameSource {
                    filename: frame.filename.clone(),
                    source_relative_path: candidate.relative_path.clone(),
                    original_width: candidate.width,
                    original_height: candidate.height,
                    camera: candidate.camera.clone(),
                    camera_group_id: String::new(),
                });
                frames.push(frame);
            }
            Err(error) => {
                tracing::warn!(
                    source = %candidate.relative_path,
                    error = %error,
                    "image normalization skipped"
                );
                skipped_items.push(crate::image_input::ImageIssue {
                    relative_path: candidate.relative_path.clone(),
                    reason: error.user_message_zh(),
                });
            }
        }
        let _ = progress_tx.send(
            TaskProgress::new(
                "frame_extraction",
                format!("标准化图片 {}/{}", position + 1, total),
            )
            .with_percent((position + 1) as f64 / total as f64)
            .with_items((position + 1) as u64, total as u64),
        );
        if ctx.cancellation.is_cancelled() {
            let _ = std::fs::remove_dir_all(&preparing_dir);
            return Err(AppError::new(
                "E-2104",
                ErrorCategory::Engine,
                "Image Preparation Cancelled",
                "图片标准化已由用户取消，正式 frames/ 产物未改变。",
            ));
        }
    }

    if frames.len() < 3 {
        let examples = skipped_items
            .iter()
            .rev()
            .take(3)
            .map(|item| format!("{}（{}）", item.relative_path, item.reason))
            .collect::<Vec<_>>()
            .join("；");
        let _ = std::fs::remove_dir_all(&preparing_dir);
        return Err(AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Image Preparation Produced Too Few Frames",
            format!("成功标准化的图片不足 3 张。失败示例：{examples}"),
        )
        .retryable(true));
    }

    let camera_groups = assign_camera_groups(&frames, &mut frame_sources);
    let manifest = ImageFrameManifest {
        schema_version: 3,
        source_kind: "images".into(),
        source_image_count: scan.images.len() as u32,
        selected_image_count: frames.len() as u32,
        target_long_edge: reconstruction_long_edge,
        reconstruction_long_edge,
        training_long_edge,
        total_size_bytes: frames.iter().map(|frame| frame.size_bytes).sum(),
        frames,
        frame_sources,
        camera_groups,
        skipped_items,
    };
    let preparing_manifest = preparing_dir.join("frames.json");
    write_image_manifest_atomic(&manifest, &preparing_manifest)?;
    validate_image_manifest(&preparing_dir, &manifest)?;
    publish_prepared_frames(&preparing_dir, &ctx.paths.frames_dir, &backup_dir)?;

    tracing::info!(
        source_images = manifest.source_image_count,
        selected_images = manifest.selected_image_count,
        reconstruction_long_edge,
        training_long_edge,
        camera_groups = manifest.camera_groups.len(),
        skipped = manifest.skipped_items.len(),
        "image frame preparation complete"
    );
    let mut state = StageState::new(PipelineStageId::FrameExtraction);
    state.status = StageStatus::Completed;
    state.progress = 1.0;
    Ok(state)
}

fn publish_prepared_frames(preparing: &Path, frames: &Path, backup: &Path) -> AppResult<()> {
    if backup.exists() {
        std::fs::remove_dir_all(backup)
            .map_err(|error| filesystem_stage_error("Failed to Clear Frame Backup", error))?;
    }
    let had_frames = frames.exists();
    if had_frames {
        std::fs::rename(frames, backup)
            .map_err(|error| filesystem_stage_error("Failed to Back Up Existing Frames", error))?;
    }
    if let Err(error) = std::fs::rename(preparing, frames) {
        if had_frames {
            let _ = std::fs::rename(backup, frames);
        }
        return Err(filesystem_stage_error(
            "Failed to Publish Prepared Frames",
            error,
        ));
    }
    if backup.exists() {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

fn filesystem_stage_error(title: &str, error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        title,
        "无法安全更新帧准备目录。",
    )
    .with_technical(error.to_string())
}

fn require_engine<'a>(path: Option<&'a PathBuf>, name: &str) -> AppResult<&'a PathBuf> {
    path.ok_or_else(|| {
        AppError::new(
            "E-2101",
            ErrorCategory::Engine,
            format!("{name} Not Found"),
            format!(
                "{name} is required for frame extraction but was not found in the configured engine directory, application resources, or PATH."
            ),
        )
    })
}

fn find_unique_video(source_dir: &Path) -> AppResult<PathBuf> {
    let mut videos: Vec<PathBuf> = std::fs::read_dir(source_dir)
        .map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Source Directory",
                "Could not inspect the project's source media directory.",
            )
            .with_technical(error.to_string())
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "mp4" | "mov" | "avi" | "mkv" | "m4v"
                    )
                })
                .unwrap_or(false)
        })
        .collect();
    videos.sort();
    match videos.len() {
        1 => Ok(videos.remove(0)),
        0 => Err(AppError::new(
            "E-1101",
            ErrorCategory::Media,
            "Source Video Missing",
            "Frame extraction requires exactly one supported video in the project source directory.",
        )),
        count => Err(AppError::new(
            "E-1101",
            ErrorCategory::Media,
            "Multiple Source Videos",
            format!(
                "Found {count} videos in the project source directory; select a project with exactly one source video."
            ),
        )),
    }
}

fn prepare_output_directory(frames_dir: &Path, manifest_path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(frames_dir).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Create Frames Directory",
            "Could not create the frame extraction output directory.",
        )
        .with_technical(error.to_string())
    })?;
    for entry in std::fs::read_dir(frames_dir)
        .map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Frames Directory",
                "Could not prepare the frame extraction output directory.",
            )
            .with_technical(error.to_string())
        })?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let is_jpeg = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
            })
            .unwrap_or(false);
        if path.is_file() && is_jpeg {
            std::fs::remove_file(&path).map_err(|error| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "Failed to Clear Previous Frames",
                    "Could not remove a previous frame before extraction.",
                )
                .with_technical(format!("{}: {error}", path.display()))
            })?;
        }
    }
    if manifest_path.exists() {
        std::fs::remove_file(manifest_path).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Clear Previous Manifest",
                "Could not remove the previous frame manifest before extraction.",
            )
            .with_technical(error.to_string())
        })?;
    }
    Ok(())
}

fn read_manifest(path: &Path) -> AppResult<FrameManifest> {
    let json = std::fs::read_to_string(path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Frame Manifest",
            "Could not read the frame extraction manifest.",
        )
        .with_technical(error.to_string())
    })?;
    serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Frame Manifest",
            "The frame extraction manifest is malformed or incompatible.",
        )
        .with_technical(error.to_string())
    })
}

fn has_frames(dir: &std::path::Path) -> bool {
    if !dir.exists() {
        return false;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader.filter_map(|e| e.ok()).any(|e| {
                e.path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_domain::project::{ImageFolderSource, ProjectStatus};
    use std::path::Path;

    #[tokio::test]
    async fn test_frame_extraction_validate_inputs_missing_source() {
        let stage = FrameExtractionStage::new("balanced");
        let ctx = StageContext::new(
            PipelineStageId::FrameExtraction,
            Path::new("/nonexistent"),
            Some("balanced".into()),
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_frame_extraction_check_cached_empty() {
        let dir = std::env::temp_dir().join("splat-stage-frames-cache");
        let _ = std::fs::create_dir_all(&dir);
        let ctx = StageContext::new(
            PipelineStageId::FrameExtraction,
            &dir,
            Some("balanced".into()),
        );
        assert!(!FrameExtractionStage::new("balanced")
            .check_cached(&ctx)
            .unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_has_frames() {
        let dir = std::env::temp_dir().join("splat-stage-has-frames");
        let _ = std::fs::create_dir_all(&dir);
        assert!(!has_frames(&dir));
        std::fs::write(dir.join("000001.jpg"), b"fake").unwrap();
        assert!(has_frames(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn image_project_prepares_frames_without_ffmpeg() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source").join("中文子目录");
        std::fs::create_dir_all(&source).unwrap();
        for index in 0..4 {
            let image = image::RgbImage::from_pixel(
                40 + index,
                20,
                image::Rgb([index as u8 * 20, 50, 100]),
            );
            image
                .save_with_format(
                    source.join(format!("IMAGE_{index}.JPG")),
                    image::ImageFormat::Jpeg,
                )
                .unwrap();
        }
        let mut project = Project::new("image-test");
        project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "images".into(),
            image_count: 4,
            copied_to_project: true,
        }));
        project.settings.preset = "fast".into();
        project.settings.max_frames = 3;
        project.settings.max_long_edge = 24;
        project.status = ProjectStatus::Ready;
        std::fs::write(
            root.path().join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();

        let ctx = StageContext::new(
            PipelineStageId::FrameExtraction,
            root.path(),
            Some("fast".into()),
        );
        let stage = FrameExtractionStage::new("fast");
        stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await
            .unwrap();

        assert!(root.path().join("frames/000001.jpg").is_file());
        assert!(root.path().join("frames/000003.jpg").is_file());
        assert!(!root.path().join("frames/000004.jpg").exists());
        let manifest = read_image_manifest(&root.path().join("frames/frames.json"))
            .unwrap()
            .unwrap();
        assert_eq!(manifest.schema_version, 3);
        assert_eq!(manifest.source_image_count, 4);
        assert_eq!(manifest.selected_image_count, 3);
        assert!(manifest
            .frames
            .iter()
            .all(|frame| frame.width.max(frame.height) <= 24));
        assert_eq!(manifest.training_long_edge, 24);
        assert_eq!(manifest.frame_sources.len(), 3);
        assert!(!manifest.camera_groups.is_empty());
        assert!(stage.check_cached(&ctx).unwrap());
        stage.validate_outputs(&ctx).unwrap();
    }
}
