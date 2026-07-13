use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Brush Gaussian Splatting training stage.
///
/// Takes the COLMAP sparse reconstruction and runs GPU training
/// to produce a Gaussian Splatting model. Delegates to BrushAdapter
/// for command generation and progress parsing.
///
/// TODO: Full implementation with BrushAdapter + ProcessRunner.
pub struct BrushTrainingStage {
    /// Training preset name (e.g. "balanced", "quality", "fast")
    preset_name: String,
}

impl BrushTrainingStage {
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
        }
    }
}

#[async_trait::async_trait]
impl PipelineStage for BrushTrainingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::BrushTraining
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        let model_dir = ctx.paths.colmap_model_dir();
        let has_colmap =
            model_dir.join("cameras.bin").exists() || model_dir.join("cameras.txt").exists();
        if !has_colmap {
            return Err(AppError::new(
                "E-4002",
                ErrorCategory::Engine,
                "COLMAP Model Missing",
                "The COLMAP sparse model is required for training. Run COLMAP reconstruction first.",
            ));
        }
        if !ctx.paths.frames_dir.exists() {
            return Err(AppError::new(
                "E-1101",
                ErrorCategory::Media,
                "Frames Missing",
                "The frames directory is required for training. Extract frames first.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        // Check if training output already exists
        if ctx.paths.output_ply.exists() {
            let meta = std::fs::metadata(&ctx.paths.output_ply).map_err(|e| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "PLY Check Failed",
                    e.to_string(),
                )
            })?;
            if meta.len() > 0 {
                return Ok(true);
            }
        }
        // Also check training checkpoints directory
        if ctx.paths.training_checkpoints.exists()
            && has_checkpoint_files(&ctx.paths.training_checkpoints)
        {
            return Ok(true);
        }
        Ok(false)
    }

    async fn execute(
        &self,
        _ctx: &StageContext,
        _progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        tracing::info!("Brush training started (preset: {})", self.preset_name);

        // TODO: Full implementation:
        // 1. DatasetValidator.validate(colmap_dir, frames_dir)
        // 2. Load preset → TrainingConfig
        // 3. Check for existing checkpoints → resume iteration
        // 4. BrushAdapter.build_train_command(config, colmap, frames, training)
        // 5. ProcessRunner.execute(train_spec) + BrushProgressParser
        // 6. Monitor iteration progress + checkpoint creation
        // 7. ExportManager.export → output/scene.ply

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.output_ply.exists() {
            return Err(AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "Training Output Missing",
                "The trained PLY model was not found in the output directory. Training may have failed.",
            ));
        }
        Ok(())
    }
}

fn has_checkpoint_files(dir: &std::path::Path) -> bool {
    if !dir.exists() {
        return false;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader.filter_map(|e| e.ok()).any(|e| {
                e.path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext == "pth" || ext == "pt" || ext == "ckpt")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_brush_training_no_colmap() {
        let stage = BrushTrainingStage::new("balanced");
        let ctx = StageContext::new(
            PipelineStageId::BrushTraining,
            Path::new("/nonexistent"),
            Some("balanced".into()),
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_has_checkpoint_files() {
        let dir = std::env::temp_dir().join("splat-stage-brush-cp");
        let _ = std::fs::create_dir_all(&dir);
        assert!(!has_checkpoint_files(&dir));
        std::fs::write(dir.join("ckpt_7000.pth"), b"test").unwrap();
        assert!(has_checkpoint_files(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
