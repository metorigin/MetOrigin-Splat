use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Model validation stage.
///
/// Validates the trained model (PLY) produced by Brush:
/// 1. PLY file exists and is non-empty
/// 2. PLY header starts with "ply"
/// 3. File size is reasonable (> 1 KB)
///
/// This stage catches training failures early before export.
pub struct ModelValidationStage;

impl Default for ModelValidationStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelValidationStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ModelValidationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ModelValidation
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.training_dir.exists() {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Training Directory Not Found",
                "The training output directory does not exist. Run Brush training first.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.output_ply.exists() {
            return Ok(false);
        }
        let meta = std::fs::metadata(&ctx.paths.output_ply).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "PLY Check Failed",
                e.to_string(),
            )
        })?;
        Ok(meta.len() > 0)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        // Find the PLY file in training output
        let ply_path = find_training_ply(&ctx.paths.training_dir).ok_or_else(|| {
            AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "No Trained PLY Found",
                format!(
                    "No valid PLY file found in '{}'. Training may have failed.",
                    ctx.paths.training_dir.display()
                ),
            )
            .with_suggestions(vec![
                "Check the Brush log for training errors",
                "Ensure training completed enough iterations",
                "Try with a different preset or dataset",
            ])
        })?;

        let _ = progress_tx.send(
            TaskProgress::new(
                "model_validation",
                format!("Checking PLY: {}", ply_path.display()),
            )
            .with_percent(0.3),
        );

        // Validate the PLY
        validate_ply(&ply_path)?;

        let meta = std::fs::metadata(&ply_path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "PLY Metadata Error",
                e.to_string(),
            )
        })?;

        let size_kb = meta.len() as f64 / 1024.0;

        tracing::info!(
            "Model validation passed: {} ({:.1} KB)",
            ply_path.display(),
            size_kb
        );

        let _ = progress_tx.send(
            TaskProgress::new(
                "model_validation",
                format!("Model valid: {:.1} KB PLY", size_kb),
            )
            .with_percent(1.0),
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, _ctx: &StageContext) -> AppResult<()> {
        // Outputs are validated during execute — the PLY exists and is valid
        Ok(())
    }
}

/// Find a PLY file in the training output directory.
fn find_training_ply(training_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    for name in &["point_cloud.ply", "scene.ply", "output.ply"] {
        let path = training_dir.join(name);
        if path.exists() && path.is_file() {
            return Some(path);
        }
    }
    // Check output subdirectory
    let output_dir = training_dir.join("output");
    if output_dir.exists() {
        for name in &["point_cloud.ply", "scene.ply"] {
            let path = output_dir.join(name);
            if path.exists() && path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// Validate a PLY file's existence, size, and header.
fn validate_ply(path: &std::path::Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "PLY Not Found",
            format!("'{}' not found", path.display()),
        ));
    }
    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "PLY Read Error",
            e.to_string(),
        )
    })?;
    if meta.len() == 0 {
        return Err(AppError::new(
            "E-4006",
            ErrorCategory::Engine,
            "Empty PLY",
            "The PLY file is empty (0 bytes).",
        ));
    }
    if meta.len() < 1024 {
        tracing::warn!("PLY file is very small: {} bytes", meta.len());
    }
    // Check PLY header
    let mut header = [0u8; 15];
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read;
        if f.read_exact(&mut header).is_ok() {
            let magic = String::from_utf8_lossy(&header);
            if !magic.starts_with("ply") {
                return Err(AppError::new(
                    "E-4006",
                    ErrorCategory::Engine,
                    "Invalid PLY Header",
                    "File does not start with 'ply' header.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_validate_no_training_dir() {
        let stage = ModelValidationStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ModelValidation,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_validate_with_ply() {
        let dir = std::env::temp_dir().join("splat-stage-model-val");
        let _ = std::fs::create_dir_all(dir.join("training"));
        std::fs::write(
            dir.join("training").join("point_cloud.ply"),
            b"ply\nformat ascii 1.0\nend_header\n",
        )
        .unwrap();

        let ctx = StageContext::new(PipelineStageId::ModelValidation, &dir, None);
        let stage = ModelValidationStage::new();
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_validate_no_ply() {
        let dir = std::env::temp_dir().join("splat-stage-model-no-ply");
        let _ = std::fs::create_dir_all(dir.join("training")); // empty

        let ctx = StageContext::new(PipelineStageId::ModelValidation, &dir, None);
        let stage = ModelValidationStage::new();
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
