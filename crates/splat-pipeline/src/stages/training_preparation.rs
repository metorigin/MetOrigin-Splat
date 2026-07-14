use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::read_colmap_result;
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
        let source_images = preferred_image_dir(ctx);
        Ok(has_config
            && has_checkpoints_dir
            && colmap_support::has_complete_model(&model)
            && count_images(&images) == count_images(source_images))
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

        // Brush scans one dataset root recursively. Build an isolated COLMAP
        // layout so duplicate frame directories and old PLY files cannot be
        // selected accidentally. Hard links avoid duplicating image data when
        // the filesystem supports them; copy is the portable fallback.
        prepare_brush_dataset(ctx, &model_dir, image_dir)?;

        // 3. Write config summary
        let config = serde_json::json!({
            "preset": self.preset_name,
            "prepared_at": Utc::now().to_rfc3339(),
            "dataset": {
                "root": "training/dataset",
                "model_path": "training/dataset/sparse/0",
                "image_path": "training/dataset/images",
                "image_count": image_count,
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
        if !colmap_support::has_complete_model(&ctx.paths.training_dataset.join("sparse/0"))
            || count_images(&ctx.paths.training_dataset.join("images")) == 0
        {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Brush Dataset Missing",
                "The prepared Brush dataset is incomplete.",
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

fn prepare_brush_dataset(
    ctx: &StageContext,
    model_dir: &std::path::Path,
    image_dir: &std::path::Path,
) -> AppResult<()> {
    let temporary = ctx.paths.training_dir.join("dataset.tmp");
    if temporary.exists() {
        std::fs::remove_dir_all(&temporary).map_err(dataset_error)?;
    }
    let target_model = temporary.join("sparse/0");
    let target_images = temporary.join("images");
    std::fs::create_dir_all(&target_model).map_err(dataset_error)?;
    std::fs::create_dir_all(&target_images).map_err(dataset_error)?;

    link_directory_files(ctx, model_dir, &target_model, |_| true)?;
    link_directory_files(ctx, image_dir, &target_images, |path| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png"
                )
            })
            .unwrap_or(false)
    })?;

    if ctx.paths.training_dataset.exists() {
        std::fs::remove_dir_all(&ctx.paths.training_dataset).map_err(dataset_error)?;
    }
    std::fs::rename(&temporary, &ctx.paths.training_dataset).map_err(dataset_error)
}

fn link_directory_files(
    ctx: &StageContext,
    source: &std::path::Path,
    target: &std::path::Path,
    include: impl Fn(&std::path::Path) -> bool,
) -> AppResult<()> {
    let entries = std::fs::read_dir(source).map_err(dataset_error)?;
    for entry in entries.filter_map(Result::ok) {
        if ctx.cancellation.is_cancelled() {
            return Err(AppError::new(
                "E-4004",
                ErrorCategory::Engine,
                "Brush Dataset Preparation Cancelled",
                "Preparing the Brush dataset was cancelled.",
            ));
        }
        let source_path = entry.path();
        if !source_path.is_file() || !include(&source_path) {
            continue;
        }
        let target_path = target.join(entry.file_name());
        if std::fs::hard_link(&source_path, &target_path).is_err() {
            std::fs::copy(&source_path, &target_path).map_err(dataset_error)?;
        }
    }
    Ok(())
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

    #[tokio::test]
    async fn test_prep_complete() {
        let dir = std::env::temp_dir().join("splat-stage-prep");
        let _ = std::fs::create_dir_all(&dir);

        // Create a fake COLMAP model
        let model_dir = dir.join("colmap").join("sparse").join("0");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("cameras.bin"), b"data").unwrap();
        std::fs::write(model_dir.join("images.bin"), b"data").unwrap();
        std::fs::write(model_dir.join("points3D.bin"), b"data").unwrap();
        let result = ColmapResult::new(2, 2, 10, std::path::PathBuf::from("colmap/sparse/0"));
        write_colmap_result_atomic(&result, &dir.join("colmap/result.json")).unwrap();

        // Create frames
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames").join("000001.jpg"), b"data").unwrap();
        std::fs::write(dir.join("frames").join("000002.jpg"), b"data").unwrap();

        let ctx = StageContext::new(
            PipelineStageId::TrainingPreparation,
            &dir,
            Some("quality".into()),
        );
        let stage = TrainingPreparationStage::new("quality");
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_ok());

        // Check config was created
        assert!(dir
            .join("training")
            .join("config")
            .join("config.json")
            .exists());
        assert!(dir.join("training").join("checkpoints").exists());

        let _ = std::fs::remove_dir_all(&dir);
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
