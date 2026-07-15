use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Image preprocessing stage.
///
/// Copies frames from `frames/` to `processed/` directory.
///
/// For video frame extraction, FFmpeg already handles scaling and
/// rotation via the filter_graph (computed in plan.rs). This stage
/// exists as a dedicated step to:
/// - Separate raw extracted frames from processed inputs
/// - Allow future addition of image-level preprocessing
/// - Provide a clear cache boundary for frame extraction
///
/// Future improvements:
/// - EXIF orientation correction for photo inputs
/// - Uniform downscaling
/// - Quality filtering (blur detection)
/// - Image deduplication
pub struct ImagePreprocessingStage;

impl Default for ImagePreprocessingStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ImagePreprocessingStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ImagePreprocessingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ImagePreprocessing
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.frames_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Frames Directory Not Found",
                "The frames directory does not exist. Run frame extraction first.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.processed_dir.exists() {
            return Ok(false);
        }
        Ok(count_jpg_files(&ctx.paths.processed_dir) > 0)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let preparing = ctx.project_dir.join("processed.preparing");
        if preparing.exists() {
            std::fs::remove_dir_all(&preparing).map_err(|e| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "Failed to Reset Processed Staging Dir",
                    e.to_string(),
                )
            })?;
        }
        std::fs::create_dir_all(&preparing).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Processed Dir",
                e.to_string(),
            )
        })?;

        // Prefer the frame manifest so preprocessing consumes exactly the
        // deterministic set published by video extraction or image preparation.
        let frame_paths = collect_manifest_frames(ctx)?;
        if frame_paths.is_empty() {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "No Frames to Process",
                format!(
                    "No JPG files found in '{}'.",
                    ctx.paths.frames_dir.display()
                ),
            ));
        }

        let total = frame_paths.len();

        for (i, frame_path) in frame_paths.iter().enumerate() {
            let dest = preparing.join(frame_path.file_name().ok_or_else(|| {
                AppError::new(
                    "E-1103",
                    ErrorCategory::Media,
                    "Invalid Filename",
                    "Frame file has no valid filename.",
                )
            })?);

            if std::fs::hard_link(frame_path, &dest).is_err() {
                std::fs::copy(frame_path, &dest).map_err(|e| {
                    AppError::new(
                        "E-1201",
                        ErrorCategory::Filesystem,
                        "Failed to Copy Frame",
                        format!("Could not copy '{}': {}", frame_path.display(), e),
                    )
                })?;
            }

            // Send progress every 10 frames to reduce overhead
            if i % 10 == 0 || i == total - 1 {
                let pct = (i + 1) as f64 / total as f64;
                let _ = progress_tx.send(
                    TaskProgress::new(
                        "image_preprocessing",
                        format!("Processing image {}/{}", i + 1, total),
                    )
                    .with_percent(pct)
                    .with_items((i + 1) as u64, total as u64),
                );
            }
        }

        let previous = ctx.project_dir.join("processed.previous");
        if previous.exists() {
            std::fs::remove_dir_all(&previous).map_err(processed_publish_error)?;
        }
        let had_previous = ctx.paths.processed_dir.exists();
        if had_previous {
            std::fs::rename(&ctx.paths.processed_dir, &previous)
                .map_err(processed_publish_error)?;
        }
        if let Err(error) = std::fs::rename(&preparing, &ctx.paths.processed_dir) {
            if had_previous {
                let _ = std::fs::rename(&previous, &ctx.paths.processed_dir);
            }
            return Err(processed_publish_error(error));
        }
        if previous.exists() {
            let _ = std::fs::remove_dir_all(previous);
        }

        tracing::info!(
            "Image preprocessing complete: {} frames → {}",
            total,
            ctx.paths.processed_dir.display()
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if count_jpg_files(&ctx.paths.processed_dir) == 0 {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Preprocessing Failed",
                "No output files were created in the processed directory.",
            ));
        }
        Ok(())
    }
}

fn processed_publish_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Publish Processed Images",
        "The processed image set could not be replaced atomically.",
    )
    .with_technical(error.to_string())
}

fn collect_manifest_frames(ctx: &StageContext) -> AppResult<Vec<std::path::PathBuf>> {
    if !ctx.paths.frames_manifest.exists() {
        // Legacy/unit-test compatibility: projects created before manifests were
        // mandatory can still be recovered from their flat JPEG directory.
        return Ok(collect_jpg_files(&ctx.paths.frames_dir));
    }
    let json = std::fs::read_to_string(&ctx.paths.frames_manifest).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Frame Manifest",
            "无法读取 frames/frames.json。",
        )
        .with_technical(error.to_string())
    })?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Frame Manifest",
            "frames/frames.json 无法解析。",
        )
        .with_technical(error.to_string())
    })?;
    let frames = value
        .get("frames")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Frame Manifest Has No Frames",
                "帧清单中没有 frames 数组。",
            )
        })?;
    let mut paths = Vec::with_capacity(frames.len());
    for frame in frames {
        let filename = frame
            .get("filename")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::new(
                    "E-1103",
                    ErrorCategory::Media,
                    "Invalid Frame Manifest Entry",
                    "帧清单包含无效文件名。",
                )
            })?;
        let relative = std::path::Path::new(filename);
        if relative.components().count() != 1
            || !relative
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
                })
        {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Unsafe Frame Manifest Entry",
                format!("帧清单中的路径 '{filename}' 无效。"),
            ));
        }
        let path = ctx.paths.frames_dir.join(relative);
        if !path.is_file() {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Manifest Frame Missing",
                format!("帧清单引用的文件 '{filename}' 不存在。"),
            ));
        }
        paths.push(path);
    }
    Ok(paths)
}

/// Count JPG/JPEG files in a directory.
fn count_jpg_files(dir: &std::path::Path) -> usize {
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
                        .map(|ext| {
                            ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg")
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

/// Collect sorted paths of all JPG files in a directory.
fn collect_jpg_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map(|reader| {
            reader
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg")
                        })
                        .unwrap_or(false)
                })
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();

    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_image_preproc_no_frames() {
        let stage = ImagePreprocessingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ImagePreprocessing,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_image_preproc_copies_frames() {
        let dir = std::env::temp_dir().join("splat-stage-imgpre");
        let _ = std::fs::create_dir_all(dir.join("frames"));

        // Create test frames
        for i in 0..5 {
            std::fs::write(
                dir.join("frames").join(format!("{:06}.jpg", i)),
                b"fake image data",
            )
            .unwrap();
        }

        let ctx = StageContext::new(PipelineStageId::ImagePreprocessing, &dir, None);
        let stage = ImagePreprocessingStage::new();
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_ok());

        // Check frames were copied
        let processed_count = std::fs::read_dir(dir.join("processed")).unwrap().count();
        assert_eq!(processed_count, 5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_jpg_files() {
        let dir = std::env::temp_dir().join("splat-stage-imgpre-count");
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(count_jpg_files(&dir), 0);
        std::fs::write(dir.join("frame.jpg"), b"data").unwrap();
        std::fs::write(dir.join("frame.jpeg"), b"data").unwrap();
        std::fs::write(dir.join("readme.txt"), b"data").unwrap();
        assert_eq!(count_jpg_files(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_collect_jpg_files_sorted() {
        let dir = std::env::temp_dir().join("splat-stage-imgpre-sort");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("000002.jpg"), b"b").unwrap();
        std::fs::write(dir.join("000001.jpg"), b"a").unwrap();
        std::fs::write(dir.join("000010.jpg"), b"c").unwrap();
        let files = collect_jpg_files(&dir);
        assert_eq!(files.len(), 3);
        // Should be sorted alphabetically
        assert!(files[0].to_string_lossy().contains("000001"));
        assert!(files[2].to_string_lossy().contains("000010"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
