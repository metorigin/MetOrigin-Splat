use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_domain::project::{Project, ProjectSource};
use splat_engine_colmap::{
    consolidate_camera_groups, inspect_database, CameraModel, ColmapFeatureParser, DatabaseCreator,
    FeatureExtractionOptions, FeatureExtractor,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Creates a COLMAP database and extracts SIFT features from the preferred
/// processed image directory, falling back to extracted frames when needed.
pub struct ColmapFeatureStage;

impl Default for ColmapFeatureStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapFeatureStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapFeatureStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapFeatureExtraction
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        colmap_support::image_dir(ctx)?;
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        let image_dir = colmap_support::image_dir(ctx)?;
        let stats = match inspect_database(&ctx.paths.colmap_db) {
            Ok(stats) => stats,
            Err(_) => return Ok(false),
        };
        Ok(stats.images == colmap_support::count_images(&image_dir)
            && stats.keypoints > 0
            && colmap_support::fingerprint_matches(ctx))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let image_dir = colmap_support::image_dir(ctx)?;
        let image_count = colmap_support::count_images(&image_dir);
        let adapter = colmap_support::adapter(ctx)?;
        create_colmap_directories(ctx)?;
        reset_feature_outputs(ctx)?;

        let database_command = adapter
            .database_creator()
            .build_command(
                &ctx.paths.colmap_db,
                &ctx.paths.colmap_logs.join("database.log"),
            )
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(5 * 60));
        let database_result = ProcessRunner::new()
            .run_to_completion(database_command, ctx.cancellation.clone(), None)
            .await?;
        colmap_support::ensure_success(&database_result, "database creation")?;
        DatabaseCreator::validate_database(&ctx.paths.colmap_db)?;
        let _ = progress_tx.send(
            TaskProgress::new("ColmapFeatureExtraction", "COLMAP database created")
                .with_percent(0.05),
        );

        let options = feature_extraction_options(ctx, &image_dir)?;
        let feature_command = adapter
            .build_feature_command(&ctx.paths.colmap_db, &image_dir, &options, &ctx.log_path)
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(ColmapFeatureParser::new(
            "ColmapFeatureExtraction",
            image_count as u64,
        )));
        let feature_result = ProcessRunner::with_parser(parsers)
            .run_to_completion(feature_command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        colmap_support::ensure_success(&feature_result, "feature extraction")?;
        FeatureExtractor::validate_extraction(&ctx.paths.colmap_db, &image_dir, true)?;
        if is_image_project(ctx)? {
            let manifest = crate::image_input::read_image_manifest(&ctx.paths.frames_manifest)?
                .ok_or_else(|| {
                    AppError::new(
                        "E-3011",
                        ErrorCategory::Engine,
                        "Image Camera Manifest Missing",
                        "Image projects require a schema 2 or 3 frames.json camera manifest.",
                    )
                })?;
            let groups = manifest
                .frame_sources
                .iter()
                .map(|source| (source.filename.clone(), source.camera_group_id.clone()))
                .collect::<std::collections::BTreeMap<_, _>>();
            let consolidated = consolidate_camera_groups(&ctx.paths.colmap_db, &groups)?;
            tracing::info!(
                cameras_before = consolidated.cameras_before,
                cameras_after = consolidated.cameras_after,
                images = consolidated.images,
                "COLMAP image cameras consolidated from manifest"
            );
        }
        let fingerprint = colmap_support::cache_fingerprint(ctx)?;
        colmap_support::write_json_atomic(&fingerprint, &colmap_support::fingerprint_path(ctx))?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        DatabaseCreator::validate_database(&ctx.paths.colmap_db)?;
        let image_dir = colmap_support::image_dir(ctx)?;
        FeatureExtractor::validate_extraction(&ctx.paths.colmap_db, &image_dir, true)?;
        Ok(())
    }
}

fn feature_extraction_options(
    ctx: &StageContext,
    _image_dir: &std::path::Path,
) -> AppResult<FeatureExtractionOptions> {
    let project_path = ctx.project_dir.join("project.json");
    if !project_path.exists() {
        return Ok(FeatureExtractionOptions::default());
    }
    let json = std::fs::read_to_string(&project_path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Project",
            "无法读取 project.json 以选择 COLMAP 相机策略。",
        )
        .with_technical(error.to_string())
    })?;
    let project: Project = serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "project.json 无法解析，不能安全选择 COLMAP 相机策略。",
        )
        .with_technical(error.to_string())
    })?;
    let image_project = matches!(project.source, Some(ProjectSource::ImageFolder(_)));
    let single_camera = !image_project;
    tracing::info!(
        single_camera,
        source_kind = if image_project { "images" } else { "video" },
        "selected COLMAP camera strategy"
    );
    Ok(FeatureExtractionOptions {
        single_camera,
        camera_model: CameraModel::SimpleRadial,
        ..FeatureExtractionOptions::default()
    })
}

fn is_image_project(ctx: &StageContext) -> AppResult<bool> {
    let json = std::fs::read_to_string(ctx.project_dir.join("project.json")).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Project",
            "Could not inspect the project source kind.",
        )
        .with_technical(error.to_string())
    })?;
    let project: Project = serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "project.json could not be parsed for COLMAP camera grouping.",
        )
        .with_technical(error.to_string())
    })?;
    Ok(matches!(
        project.source,
        Some(ProjectSource::ImageFolder(_))
    ))
}

#[allow(dead_code)]
fn image_dimensions_are_uniform(image_dir: &std::path::Path) -> AppResult<bool> {
    let mut reference = None;
    for entry in std::fs::read_dir(image_dir)
        .map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Inspect Prepared Images",
                "无法读取预处理图片目录以选择 COLMAP 相机策略。",
            )
            .with_technical(error.to_string())
        })?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("jpg")
                        || extension.eq_ignore_ascii_case("jpeg")
                        || extension.eq_ignore_ascii_case("png")
                })
        {
            continue;
        }
        let dimensions = image::image_dimensions(&path).map_err(|error| {
            AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Invalid Prepared Image",
                format!("无法读取预处理图片 '{}': {error}", path.display()),
            )
        })?;
        match reference {
            None => reference = Some(dimensions),
            Some(expected) if expected != dimensions => return Ok(false),
            Some(_) => {}
        }
    }
    Ok(true)
}

fn create_colmap_directories(ctx: &StageContext) -> AppResult<()> {
    for path in [&ctx.paths.colmap_dir, &ctx.paths.colmap_logs] {
        std::fs::create_dir_all(path).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create COLMAP Directory",
                "Could not create a COLMAP working directory.",
            )
            .with_technical(error.to_string())
        })?;
    }
    Ok(())
}

fn reset_feature_outputs(ctx: &StageContext) -> AppResult<()> {
    DatabaseCreator::remove_database(&ctx.paths.colmap_db).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Reset COLMAP Database",
            "Could not clear the previous COLMAP database.",
        )
        .with_technical(error.to_string())
    })?;
    if ctx.paths.colmap_result.exists() {
        let previous = ctx.paths.colmap_dir.join("result.previous.json");
        std::fs::copy(&ctx.paths.colmap_result, previous).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Preserve Previous COLMAP Result",
                "Could not preserve the previous reconstruction result before rebuilding.",
            )
            .with_technical(error.to_string())
        })?;
    }
    for stale in [&ctx.paths.colmap_result, &ctx.paths.colmap_validation] {
        if stale.exists() {
            std::fs::remove_file(stale).map_err(|error| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "Failed to Clear COLMAP Result",
                    "Could not clear a stale COLMAP result file.",
                )
                .with_technical(error.to_string())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_domain::project::{ImageFolderSource, VideoSource};
    use std::path::Path;

    #[test]
    fn test_colmap_feature_no_frames() {
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapFeatureExtraction,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_colmap_feature_cache_no_db() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("frames")).unwrap();
        std::fs::write(dir.path().join("frames/000001.jpg"), b"frame").unwrap();
        let stage = ColmapFeatureStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, dir.path(), None);
        assert!(!stage.check_cached(&ctx).unwrap());
    }

    #[test]
    fn image_projects_extract_per_image_cameras_before_manifest_consolidation() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("processed");
        std::fs::create_dir_all(&images).unwrap();
        image::RgbImage::new(12, 8)
            .save(images.join("000001.jpg"))
            .unwrap();
        image::RgbImage::new(8, 12)
            .save(images.join("000002.jpg"))
            .unwrap();
        let mut project = Project::new("mixed-photo-sizes");
        project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "photos".into(),
            image_count: 73,
            copied_to_project: true,
        }));
        std::fs::write(
            root.path().join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, root.path(), None);
        assert!(
            !feature_extraction_options(&ctx, &images)
                .unwrap()
                .single_camera
        );
        assert_eq!(
            feature_extraction_options(&ctx, &images)
                .unwrap()
                .camera_model,
            CameraModel::SimpleRadial
        );
    }

    #[test]
    fn video_projects_keep_single_camera_mode() {
        let root = tempfile::tempdir().unwrap();
        let mut project = Project::new("video-frames");
        project.source = Some(ProjectSource::Video(VideoSource {
            filename: "input.mp4".into(),
            copied_to_project: true,
        }));
        std::fs::write(
            root.path().join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, root.path(), None);
        assert!(
            feature_extraction_options(&ctx, &root.path().join("processed"))
                .unwrap()
                .single_camera
        );
    }

    #[test]
    fn image_projects_with_uniform_dimensions_are_still_manifest_grouped() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("processed");
        std::fs::create_dir_all(&images).unwrap();
        image::RgbImage::new(12, 8)
            .save(images.join("000001.jpg"))
            .unwrap();
        image::RgbImage::new(12, 8)
            .save(images.join("000002.jpg"))
            .unwrap();
        let mut project = Project::new("uniform-photo-sizes");
        project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "photos".into(),
            image_count: 2,
            copied_to_project: true,
        }));
        std::fs::write(
            root.path().join("project.json"),
            serde_json::to_vec_pretty(&project).unwrap(),
        )
        .unwrap();
        let ctx = StageContext::new(PipelineStageId::ColmapFeatureExtraction, root.path(), None);
        assert!(
            !feature_extraction_options(&ctx, &images)
                .unwrap()
                .single_camera
        );
    }
}
