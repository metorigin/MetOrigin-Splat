use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Preview generation stage.
///
/// Creates `output/manifest.json` with metadata about the final model.
/// This manifest is used by the UI and external tools to understand
/// what was produced by the pipeline.
pub struct PreviewGenerationStage;

impl Default for PreviewGenerationStage {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewGenerationStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for PreviewGenerationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::PreviewGeneration
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.output_ply.exists() {
            return Err(AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "Output PLY Missing",
                "The output PLY file was not found. Run the export stage first.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        Ok(ctx.paths.output_manifest.exists())
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        std::fs::create_dir_all(&ctx.paths.output_dir).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Output Dir",
                e.to_string(),
            )
        })?;

        let ply_meta = std::fs::metadata(&ctx.paths.output_ply).ok();
        let project_name = ctx
            .project_dir
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .trim_end_matches(".splat-project");

        let manifest = serde_json::json!({
            "schema_version": 1,
            "project": project_name,
            "created_at": Utc::now().to_rfc3339(),
            "ply": {
                "filename": "scene.ply",
                "size_bytes": ply_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "size_mb": format!("{:.2}", ply_meta.as_ref().map(|m| m.len() as f64 / (1024.0 * 1024.0)).unwrap_or(0.0)),
            },
            "stage": "preview_generation",
        });

        std::fs::write(
            &ctx.paths.output_manifest,
            serde_json::to_string_pretty(&manifest)?,
        )
        .map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Write Manifest",
                e.to_string(),
            )
        })?;

        let _ = progress_tx
            .send(TaskProgress::new("preview", "Preview manifest created").with_percent(1.0));

        tracing::info!(
            "Preview manifest created at '{}'",
            ctx.paths.output_manifest.display()
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.output_manifest.exists() {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Manifest Not Created",
                "The output manifest (output/manifest.json) was not created.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn test_preview_no_ply() {
        let stage = PreviewGenerationStage::new();
        let ctx = StageContext::new(
            PipelineStageId::PreviewGeneration,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_preview_creates_manifest() {
        let dir = std::env::temp_dir().join("splat-stage-preview");
        let _ = std::fs::create_dir_all(dir.join("output"));
        std::fs::write(dir.join("output").join("scene.ply"), b"ply\n").unwrap();

        let ctx = StageContext::new(PipelineStageId::PreviewGeneration, &dir, None);
        let stage = PreviewGenerationStage::new();
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_ok());

        let manifest_path = dir.join("output").join("manifest.json");
        assert!(manifest_path.exists());

        let content: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(content["schema_version"], 1);
        assert_eq!(content["stage"], "preview_generation");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_preview_cached() {
        let dir = std::env::temp_dir().join("splat-stage-preview-cached");
        let _ = std::fs::create_dir_all(dir.join("output"));
        std::fs::write(dir.join("output").join("manifest.json"), b"{}").unwrap();

        let stage = PreviewGenerationStage::new();
        let ctx = StageContext::new(PipelineStageId::PreviewGeneration, &dir, None);
        assert!(stage.check_cached(&ctx).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
