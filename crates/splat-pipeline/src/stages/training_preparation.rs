use chrono::Utc;
use image::codecs::jpeg::JpegEncoder;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_domain::project::Project;
use splat_engine_colmap::{read_colmap_result, validate_model_image_dimensions, ColmapAdapter};
use splat_process::ProcessRunner;
use std::time::Duration;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Training preparation stage.
///
/// Validates the dataset and creates the necessary directory structure
/// and configuration files for Brush training:
///
/// 1. Validates COLMAP sparse model + frames using DatasetValidator logic
/// 2. Creates `training/config/` and `training/checkpoints/` directories
/// 3. Writes a training config summary JSON for reference
pub struct TrainingPreparationStage {
    preset_name: String,
}

impl TrainingPreparationStage {
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
        }
    }
}

#[async_trait::async_trait]
impl PipelineStage for TrainingPreparationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::TrainingPreparation
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_dir = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        if !colmap_support::has_complete_model(&model_dir) {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "COLMAP Model Required",
                "A valid COLMAP sparse model is required for training. Run COLMAP reconstruction first.",
            ));
        }
        // Need frames
        if !ctx.paths.frames_dir.exists() && !ctx.paths.processed_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Frames Required",
                "Frames are required for training. Run frame extraction first.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        let has_config = ctx.paths.training_config.join("config.json").exists();
        let has_checkpoints_dir = ctx.paths.training_checkpoints.exists();
        let model = ctx.paths.training_dataset.join("sparse/0");
        let images = ctx.paths.training_dataset.join("images");
        let registered_images = read_colmap_result(&ctx.paths.colmap_result)
            .map(|result| result.registered_images)
            .unwrap_or(0);
        if !has_config
            || !has_checkpoints_dir
            || !colmap_support::has_complete_model(&model)
            || count_images(&images) != registered_images
        {
            return Ok(false);
        }
        Ok(validate_model_image_dimensions(&model, &images)
            .map(|validated| validated == registered_images)
            .unwrap_or(false))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        // 1. Validate dataset (quick check)
        let image_dir = preferred_image_dir(ctx);

        let image_count = count_images(image_dir);
        if image_count == 0 {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "No Images Found",
                format!("No images found in '{}'.", image_dir.display()),
            ));
        }

        let colmap_result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_dir = colmap_support::model_path(&ctx.project_dir, &colmap_result.model_path);
        if !colmap_support::has_complete_model(&model_dir) {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Incomplete COLMAP Model",
                "The COLMAP sparse model is missing required files. Make sure mapping completed.",
            ));
        }

        let _ = progress_tx.send(
            TaskProgress::new(
                "training_prep",
                format!("Dataset valid: {} images", image_count),
            )
            .with_percent(0.5),
        );

        // 2. Create training directories
        std::fs::create_dir_all(&ctx.paths.training_config).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Config Dir",
                e.to_string(),
            )
        })?;
        std::fs::create_dir_all(&ctx.paths.training_checkpoints).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Checkpoints Dir",
                e.to_string(),
            )
        })?;

        // image_undistorter scales the images and camera intrinsics together,
        // removes lens distortion and emits only images registered in the
        // selected sparse model.
        let adapter = colmap_support::adapter(ctx)?;
        let training_long_edge = load_project(ctx)?.settings.max_long_edge.max(1);
        let prepared_image_count = prepare_brush_dataset(
            ctx,
            &adapter,
            &model_dir,
            image_dir,
            training_long_edge,
            colmap_result.registered_images,
        )
        .await?;

        // 3. Write config summary
        let config = serde_json::json!({
            "preset": self.preset_name,
            "prepared_at": Utc::now().to_rfc3339(),
            "dataset": {
                "root": "training/dataset",
                "model_path": "training/dataset/sparse/0",
                "image_path": "training/dataset/images",
                "image_count": prepared_image_count,
                "max_long_edge": training_long_edge,
                "source_registered_images": colmap_result.registered_images,
            },
            "checkpoints": "training/checkpoints",
        });

        std::fs::write(
            ctx.paths.training_config.join("config.json"),
            serde_json::to_string_pretty(&config)?,
        )
        .map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Write Config",
                e.to_string(),
            )
        })?;

        let _ = progress_tx.send(
            TaskProgress::new(
                "training_prep",
                format!("Configuration written for preset '{}'", self.preset_name),
            )
            .with_percent(1.0),
        );

        tracing::info!(
            "Training preparation complete: {} images, COLMAP model '{}', preset '{}'",
            image_count,
            model_dir.display(),
            self.preset_name
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.training_config.join("config.json").exists() {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Training Config Missing",
                "The training configuration file was not created.",
            ));
        }
        let model = ctx.paths.training_dataset.join("sparse/0");
        let images = ctx.paths.training_dataset.join("images");
        if !colmap_support::has_complete_model(&model) || count_images(&images) == 0 {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Brush Dataset Missing",
                "The prepared Brush dataset is incomplete.",
            ));
        }
        let expected = read_colmap_result(&ctx.paths.colmap_result)?.registered_images;
        let validated = validate_model_image_dimensions(&model, &images)?;
        if validated != expected || count_images(&images) != expected {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Brush Dataset Incomplete",
                format!(
                    "The prepared Brush dataset contains {validated} registered images; expected {expected}."
                ),
            ));
        }
        Ok(())
    }
}

fn preferred_image_dir(ctx: &StageContext) -> &std::path::Path {
    if count_images(&ctx.paths.processed_dir) > 0 {
        &ctx.paths.processed_dir
    } else {
        &ctx.paths.frames_dir
    }
}

async fn prepare_brush_dataset(
    ctx: &StageContext,
    adapter: &ColmapAdapter,
    model_dir: &std::path::Path,
    image_dir: &std::path::Path,
    max_image_size: u32,
    expected_registered_images: usize,
) -> AppResult<usize> {
    let temporary = ctx.paths.training_dir.join("dataset.tmp");
    if temporary.exists() {
        std::fs::remove_dir_all(&temporary).map_err(dataset_error)?;
    }
    std::fs::create_dir_all(&temporary).map_err(dataset_error)?;
    let command = adapter
        .build_image_undistorter_command(
            image_dir,
            model_dir,
            &temporary,
            max_image_size,
            &ctx.paths.training_logs.join("image-undistorter.log"),
        )
        .with_cwd(&ctx.paths.training_dir)
        .with_timeout(Duration::from_secs(2 * 60 * 60));
    let result = ProcessRunner::new()
        .run_to_completion(command, ctx.cancellation.clone(), None)
        .await?;
    colmap_support::ensure_success(&result, "image undistortion")?;
    normalize_undistorter_layout(&temporary)?;
    let images = temporary.join("images");
    reencode_training_jpegs(ctx, &images, 92)?;
    let model = temporary.join("sparse/0");
    let prepared = validate_model_image_dimensions(&model, &images)?;
    if prepared != expected_registered_images || count_images(&images) != prepared {
        return Err(AppError::new(
            "E-4001",
            ErrorCategory::Engine,
            "Undistorted Training Dataset Incomplete",
            format!(
                "image_undistorter produced {prepared} registered images; expected {expected_registered_images}."
            ),
        ));
    }
    publish_training_dataset(ctx, &temporary)?;
    Ok(prepared)
}

fn normalize_undistorter_layout(temporary: &std::path::Path) -> AppResult<()> {
    let sparse = temporary.join("sparse");
    if colmap_support::has_complete_model(&sparse.join("0")) {
        return Ok(());
    }
    if !colmap_support::has_complete_model(&sparse) {
        return Err(AppError::new(
            "E-4001",
            ErrorCategory::Engine,
            "Undistorted Camera Model Missing",
            "image_undistorter did not produce a complete COLMAP model.",
        ));
    }
    let staging = temporary.join("sparse-model.tmp");
    std::fs::create_dir_all(&staging).map_err(dataset_error)?;
    for entry in std::fs::read_dir(&sparse).map_err(dataset_error)? {
        let entry = entry.map_err(dataset_error)?;
        if entry.file_type().map_err(dataset_error)?.is_file() {
            std::fs::rename(entry.path(), staging.join(entry.file_name()))
                .map_err(dataset_error)?;
        }
    }
    std::fs::remove_dir_all(&sparse).map_err(dataset_error)?;
    std::fs::create_dir_all(&sparse).map_err(dataset_error)?;
    std::fs::rename(staging, sparse.join("0")).map_err(dataset_error)
}

fn reencode_training_jpegs(
    ctx: &StageContext,
    images: &std::path::Path,
    quality: u8,
) -> AppResult<()> {
    let entries = std::fs::read_dir(images).map_err(dataset_error)?;
    for entry in entries.filter_map(Result::ok) {
        if ctx.cancellation.is_cancelled() {
            return Err(AppError::new(
                "E-4004",
                ErrorCategory::Engine,
                "Brush Dataset Preparation Cancelled",
                "Preparing the Brush dataset was cancelled.",
            ));
        }
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
                })
        {
            continue;
        }
        let decoded = image::open(&path).map_err(|error| {
            AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Invalid Undistorted Training Image",
                format!("Could not decode '{}': {error}", path.display()),
            )
        })?;
        let temporary = path.with_extension("jpg.reencoding");
        let mut file = std::fs::File::create(&temporary).map_err(dataset_error)?;
        JpegEncoder::new_with_quality(&mut file, quality)
            .encode_image(&decoded)
            .map_err(|error| {
                AppError::new(
                    "E-1103",
                    ErrorCategory::Media,
                    "Failed to Encode Training JPEG",
                    error.to_string(),
                )
            })?;
        drop(file);
        std::fs::remove_file(&path).map_err(dataset_error)?;
        std::fs::rename(temporary, path).map_err(dataset_error)?;
    }
    Ok(())
}

fn publish_training_dataset(ctx: &StageContext, temporary: &std::path::Path) -> AppResult<()> {
    let previous = ctx.paths.training_dir.join("dataset.previous");
    if previous.exists() {
        std::fs::remove_dir_all(&previous).map_err(dataset_error)?;
    }
    let had_dataset = ctx.paths.training_dataset.exists();
    if had_dataset {
        std::fs::rename(&ctx.paths.training_dataset, &previous).map_err(dataset_error)?;
    }
    if let Err(error) = std::fs::rename(temporary, &ctx.paths.training_dataset) {
        if had_dataset {
            let _ = std::fs::rename(&previous, &ctx.paths.training_dataset);
        }
        return Err(dataset_error(error));
    }
    if previous.exists() {
        let _ = std::fs::remove_dir_all(previous);
    }
    Ok(())
}

fn load_project(ctx: &StageContext) -> AppResult<Project> {
    let bytes = std::fs::read(ctx.project_dir.join("project.json")).map_err(dataset_error)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "Could not read the Brush training resolution from project.json.",
        )
        .with_technical(error.to_string())
    })
}

fn dataset_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Prepare Brush Dataset",
        "The isolated Brush dataset could not be created.",
    )
    .with_technical(error.to_string())
}

fn count_images(dir: &std::path::Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            ext.eq_ignore_ascii_case("jpg")
                                || ext.eq_ignore_ascii_case("jpeg")
                                || ext.eq_ignore_ascii_case("png")
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_engine_colmap::{write_colmap_result_atomic, ColmapResult};
    use std::path::Path;

    fn write_text_training_model(model_dir: &Path) {
        std::fs::create_dir_all(model_dir).unwrap();
        std::fs::write(
            model_dir.join("cameras.txt"),
            "1 SIMPLE_RADIAL 8 6 8 4 3 0\n",
        )
        .unwrap();
        std::fs::write(
            model_dir.join("images.txt"),
            concat!(
                "1 1 0 0 0 0 0 0 1 000001.jpg\n",
                "0 0 -1\n",
                "2 1 0 0 0 0 0 0 1 000002.jpg\n",
                "0 0 -1\n"
            ),
        )
        .unwrap();
        std::fs::write(model_dir.join("points3D.txt"), "# empty test model\n").unwrap();
    }

    #[tokio::test]
    async fn test_prep_no_colmap() {
        let stage = TrainingPreparationStage::new("balanced");
        let ctx = StageContext::new(
            PipelineStageId::TrainingPreparation,
            Path::new("/nonexistent"),
            Some("balanced".into()),
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_prep_complete_cache_and_validation() {
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path();

        let model_dir = dir.join("colmap/sparse/0");
        write_text_training_model(&model_dir);
        let result = ColmapResult::new(2, 2, 10, std::path::PathBuf::from("colmap/sparse/0"));
        write_colmap_result_atomic(&result, &dir.join("colmap/result.json")).unwrap();

        let training_model = dir.join("training/dataset/sparse/0");
        write_text_training_model(&training_model);
        let training_images = dir.join("training/dataset/images");
        std::fs::create_dir_all(&training_images).unwrap();
        image::RgbImage::new(8, 6)
            .save(training_images.join("000001.jpg"))
            .unwrap();
        image::RgbImage::new(8, 6)
            .save(training_images.join("000002.jpg"))
            .unwrap();
        std::fs::create_dir_all(dir.join("training/config")).unwrap();
        std::fs::write(dir.join("training/config/config.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("training/checkpoints")).unwrap();

        let ctx = StageContext::new(
            PipelineStageId::TrainingPreparation,
            dir,
            Some("quality".into()),
        );
        let stage = TrainingPreparationStage::new("quality");
        assert!(stage.check_cached(&ctx).unwrap());
        stage.validate_outputs(&ctx).unwrap();

        image::RgbImage::new(7, 6)
            .save(training_images.join("000002.jpg"))
            .unwrap();
        assert!(!stage.check_cached(&ctx).unwrap());
        assert!(stage.validate_outputs(&ctx).is_err());
    }

    #[test]
    fn test_count_images() {
        let dir = std::env::temp_dir().join("splat-stage-prep-count");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("a.jpg"), b"1").unwrap();
        std::fs::write(dir.join("b.png"), b"2").unwrap();
        std::fs::write(dir.join("c.txt"), b"3").unwrap();
        assert_eq!(count_images(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
