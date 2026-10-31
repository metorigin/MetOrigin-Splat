use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_brush::ExportManager;
use std::path::Path;
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

fn project_display_name(project_dir: &Path) -> String {
    let saved_name = std::fs::read(project_dir.join("project.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|project| project["name"].as_str().map(str::to_owned))
        .filter(|name| !name.trim().is_empty());
    saved_name.unwrap_or_else(|| {
        let directory_name = project_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("project");
        directory_name
            .strip_suffix(".splat-project")
            .unwrap_or(directory_name)
            .to_owned()
    })
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
        let manifest: serde_json::Value = match std::fs::read_to_string(&ctx.paths.output_manifest)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
        {
            Some(manifest) => manifest,
            None => return Ok(false),
        };
        let actual_size = std::fs::metadata(&ctx.paths.output_ply)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(actual_size > 0
            && manifest["ply"]["size_bytes"].as_u64() == Some(actual_size)
            && manifest["ply"]["vertex_count"].as_u64().unwrap_or(0) > 0)
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

        ExportManager::validate_ply(&ctx.paths.output_ply)?;
        let ply_meta = std::fs::metadata(&ctx.paths.output_ply).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Output PLY",
                "The final PLY metadata could not be read.",
            )
            .with_technical(error.to_string())
        })?;
        let vertex_count = ExportManager::vertex_count(&ctx.paths.output_ply)?;
        let training: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&ctx.paths.training_result).map_err(|error| {
                AppError::new(
                    "E-4005",
                    ErrorCategory::Engine,
                    "Brush Training Result Missing",
                    "The Brush training result is required for the output manifest.",
                )
                .with_technical(error.to_string())
            })?,
        )?;
        let project_name = project_display_name(&ctx.project_dir);

        let manifest = serde_json::json!({
            "schema_version": 1,
            "project": project_name,
            "created_at": Utc::now().to_rfc3339(),
            "ply": {
                "filename": "scene.ply",
                "size_bytes": ply_meta.len(),
                "size_mb": format!("{:.2}", ply_meta.len() as f64 / (1024.0 * 1024.0)),
                "vertex_count": vertex_count,
            },
            "training": training,
            "previews": [
                { "kind": "gaussian_splat", "path": "scene.ply" }
            ],
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
        if !self.check_cached(ctx)? {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Invalid Output Manifest",
                "The output manifest is missing or does not match scene.ply.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let _ = std::fs::create_dir_all(dir.join("training"));
        std::fs::write(
            dir.join("output").join("scene.ply"),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
            )),
        )
        .unwrap();
        std::fs::write(
            dir.join("training").join("result.json"),
            br#"{"brush_version":"brush-cli 0.3.0","total_iterations":3000}"#,
        )
        .unwrap();

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
        assert_eq!(content["previews"][0]["path"], "scene.ply");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_preview_manifest_preserves_project_display_name() {
        let root = tempfile::tempdir().unwrap();
        let cases = [
            (
                "scene.v2",
                Some(serde_json::json!({"name": "庭院原名.v4"})),
                "庭院原名.v4",
            ),
            (
                "scene.v2.splat-project",
                Some(serde_json::json!({"name": "旧工程原名.v4"})),
                "旧工程原名.v4",
            ),
            ("街景.v2", None, "街景.v2"),
            ("街景.v2.splat-project", None, "街景.v2"),
            (
                "空名.v2",
                Some(serde_json::json!({"name": "  "})),
                "空名.v2",
            ),
        ];

        for (directory_name, project, expected_name) in cases {
            let directory = root.path().join(directory_name);
            std::fs::create_dir_all(directory.join("output")).unwrap();
            std::fs::create_dir_all(directory.join("training")).unwrap();
            std::fs::write(
                directory.join("output/scene.ply"),
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
                )),
            )
            .unwrap();
            std::fs::write(directory.join("training/result.json"), b"{}").unwrap();
            if let Some(project) = project {
                std::fs::write(
                    directory.join("project.json"),
                    serde_json::to_vec(&project).unwrap(),
                )
                .unwrap();
            }

            let context = StageContext::new(PipelineStageId::PreviewGeneration, &directory, None);
            PreviewGenerationStage::new()
                .execute(&context, broadcast::channel(8).0)
                .await
                .unwrap();
            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(directory.join("output/manifest.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(manifest["project"], expected_name, "{directory_name}");
        }
    }

    #[tokio::test]
    async fn test_preview_cached() {
        let dir = std::env::temp_dir().join("splat-stage-preview-cached");
        let _ = std::fs::create_dir_all(dir.join("output"));
        let ply = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
        ));
        std::fs::write(dir.join("output").join("scene.ply"), ply).unwrap();
        std::fs::write(
            dir.join("output").join("manifest.json"),
            format!(
                "{{\"ply\":{{\"size_bytes\":{},\"vertex_count\":1}}}}",
                ply.len()
            ),
        )
        .unwrap();

        let stage = PreviewGenerationStage::new();
        let ctx = StageContext::new(PipelineStageId::PreviewGeneration, &dir, None);
        assert!(stage.check_cached(&ctx).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
