use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};

/// Final export stage — closes the end-to-end pipeline loop.
///
/// This stage completes the Gaussian Splatting pipeline by:
/// 1. Finding the best PLY file from Brush training output
/// 2. Validating the PLY file integrity
/// 3. Copying it to `output/scene.ply`
/// 4. Generating `output/manifest.json`
///
/// After this stage succeeds, the user has a usable `.ply` file in
/// the project's output directory that can be viewed in any PLY viewer.
pub struct ExportStage;

impl Default for ExportStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ExportStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ExportStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::Export
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.training_dir.exists() {
            return Err(AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "Training Directory Missing",
                "The training output directory was not found. Run Brush training before exporting.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        Ok(ctx.paths.output_ply.exists() && ctx.paths.output_manifest.exists())
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        // 1. Ensure output directory exists
        std::fs::create_dir_all(&ctx.paths.output_dir).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Output Directory",
                format!(
                    "Could not create output directory '{}': {}",
                    ctx.paths.output_dir.display(),
                    e
                ),
            )
        })?;

        // 2. Find best PLY in training output
        let _ = progress_tx.send(
            TaskProgress::new("export", "Searching for trained PLY model...").with_percent(0.1),
        );

        let ply_source = find_best_ply(&ctx.paths.training_dir).ok_or_else(|| {
            AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "No Output PLY Found",
                format!(
                    "No PLY file found in '{}'. The training may not have completed successfully.",
                    ctx.paths.training_dir.display()
                ),
            )
            .with_suggestions(vec![
                "Run Brush training first",
                "Check that training produced output files",
                "Verify the training log for errors",
            ])
        })?;

        let source_size = std::fs::metadata(&ply_source).map(|m| m.len()).unwrap_or(0);

        let _ = progress_tx.send(
            TaskProgress::new(
                "export",
                format!(
                    "Found PLY: {} ({:.1} MB)",
                    ply_source.file_name().unwrap_or_default().to_string_lossy(),
                    source_size as f64 / (1024.0 * 1024.0),
                ),
            )
            .with_percent(0.3),
        );

        // 3. Validate the source PLY
        validate_ply(&ply_source)?;

        let _ = progress_tx
            .send(TaskProgress::new("export", "PLY validated, copying...").with_percent(0.5));

        // 4. Copy PLY to output/scene.ply
        std::fs::copy(&ply_source, &ctx.paths.output_ply).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Copy PLY",
                format!(
                    "Could not copy PLY to '{}': {}",
                    ctx.paths.output_ply.display(),
                    e
                ),
            )
        })?;

        let _ = progress_tx.send(
            TaskProgress::new("export", "PLY exported to output directory.").with_percent(0.7),
        );

        // 5. Validate the copied PLY
        validate_ply(&ctx.paths.output_ply)?;

        // 6. Generate output manifest
        let ply_meta = std::fs::metadata(&ctx.paths.output_ply).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read PLY",
                e.to_string(),
            )
        })?;

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
                "size_bytes": ply_meta.len(),
                "size_mb": format!("{:.2}", ply_meta.len() as f64 / (1024.0 * 1024.0)),
            },
            "training_preset": null,
            "total_iterations": null,
            "gaussian_count": null,
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
                format!("Could not write manifest: {}", e),
            )
        })?;

        let _ = progress_tx.send(
            TaskProgress::new(
                "export",
                format!(
                    "Export complete: {:.1} MB → {}",
                    ply_meta.len() as f64 / (1024.0 * 1024.0),
                    ctx.paths.output_ply.display(),
                ),
            )
            .with_percent(1.0),
        );

        tracing::info!(
            "Pipeline complete! PLY exported: {} -> {} ({:.1} MB)",
            ply_source.display(),
            ctx.paths.output_ply.display(),
            ply_meta.len() as f64 / (1024.0 * 1024.0),
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.output_ply.exists() {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Export Failed",
                "The final PLY file was not created in the output directory.",
            ));
        }
        if !ctx.paths.output_manifest.exists() {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Manifest Not Created",
                "The output manifest file (output/manifest.json) was not created.",
            ));
        }
        validate_ply(&ctx.paths.output_ply)
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Find the best PLY file in a training output directory.
fn find_best_ply(training_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // Priority 1: Direct files in training root
    for name in &["point_cloud.ply", "scene.ply", "output.ply"] {
        let path = training_dir.join(name);
        if path.exists() && path.is_file() {
            return Some(path);
        }
    }

    // Priority 2: Files in output/ subdirectory
    let output_dir = training_dir.join("output");
    if output_dir.exists() {
        for name in &["point_cloud.ply", "scene.ply"] {
            let path = output_dir.join(name);
            if path.exists() && path.is_file() {
                return Some(path);
            }
        }
    }

    // Priority 3: Any .ply file in the training directory root
    if let Ok(reader) = std::fs::read_dir(training_dir) {
        let mut ply_files: Vec<std::path::PathBuf> = reader
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().is_file()
                    && e.path()
                        .extension()
                        .map(|ext| ext == "ply")
                        .unwrap_or(false)
            })
            .map(|e| e.path())
            .collect();

        if !ply_files.is_empty() {
            ply_files.sort_by(|a, b| {
                let ma = std::fs::metadata(a).and_then(|m| m.modified()).ok();
                let mb = std::fs::metadata(b).and_then(|m| m.modified()).ok();
                ma.cmp(&mb).reverse()
            });
            return Some(ply_files[0].clone());
        }
    }

    None
}

/// Validate a PLY file exists, is non-empty, and has a valid header.
fn validate_ply(path: &std::path::Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "PLY File Not Found",
            format!("The PLY file '{}' does not exist.", path.display()),
        ));
    }

    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read PLY",
            e.to_string(),
        )
    })?;

    if meta.len() == 0 {
        return Err(AppError::new(
            "E-4006",
            ErrorCategory::Engine,
            "Empty PLY File",
            format!("The PLY file '{}' is empty (0 bytes).", path.display()),
        ));
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
                    "Invalid PLY File",
                    format!(
                        "The file '{}' does not start with a valid PLY header.",
                        path.display()
                    ),
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

    fn create_fake_ply(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        let header = b"ply\nformat ascii 1.0\ncomment test\nend_header\n";
        std::fs::write(&path, header).unwrap();
        path
    }

    #[tokio::test]
    async fn test_export_no_training_dir() {
        let stage = ExportStage::new();
        let ctx = StageContext::new(PipelineStageId::Export, Path::new("/nonexistent"), None);
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[tokio::test]
    async fn test_export_with_valid_ply() {
        let dir = std::env::temp_dir().join("splat-stage-export-valid");
        let _ = std::fs::create_dir_all(&dir);
        // Create training dir with a PLY
        let training_dir = dir.join("training");
        std::fs::create_dir_all(&training_dir).unwrap();
        create_fake_ply(&training_dir, "point_cloud.ply");

        let ctx = StageContext::new(PipelineStageId::Export, &dir, None);

        let stage = ExportStage::new();
        let result = stage
            .execute(&ctx, tokio::sync::broadcast::channel(8).0)
            .await;
        assert!(result.is_ok(), "Export should succeed: {:?}", result.err());

        // Check output files exist
        assert!(dir.join("output").join("scene.ply").exists());
        assert!(dir.join("output").join("manifest.json").exists());

        // Validate manifest content
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("output").join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schema_version"], 1);
        assert!(manifest["ply"]["size_bytes"].as_u64().unwrap_or(0) > 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_direct() {
        let dir = std::env::temp_dir().join("splat-export-find");
        let _ = std::fs::create_dir_all(&dir);
        create_fake_ply(&dir, "point_cloud.ply");
        assert!(find_best_ply(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_subdir() {
        let dir = std::env::temp_dir().join("splat-export-find-sub");
        let out_dir = dir.join("output");
        let _ = std::fs::create_dir_all(&out_dir);
        create_fake_ply(&out_dir, "scene.ply");
        assert!(find_best_ply(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_none() {
        let dir = std::env::temp_dir().join("splat-export-find-none");
        let _ = std::fs::create_dir_all(&dir);
        assert!(find_best_ply(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ply_valid() {
        let dir = std::env::temp_dir().join("splat-export-val-valid");
        let _ = std::fs::create_dir_all(&dir);
        let path = create_fake_ply(&dir, "test.ply");
        assert!(validate_ply(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ply_empty() {
        let dir = std::env::temp_dir().join("splat-export-val-empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.ply");
        std::fs::write(&path, b"").unwrap();
        assert!(validate_ply(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ply_not_found() {
        assert!(validate_ply(Path::new("/nonexistent/test.ply")).is_err());
    }

    #[test]
    fn test_check_cached_output_exists() {
        let dir = std::env::temp_dir().join("splat-export-cached");
        let _ = std::fs::create_dir_all(dir.join("output"));
        std::fs::write(dir.join("output").join("scene.ply"), b"ply\n").unwrap();
        std::fs::write(dir.join("output").join("manifest.json"), b"{}").unwrap();

        let stage = ExportStage::new();
        let ctx = StageContext::new(PipelineStageId::Export, &dir, None);
        let cached = stage.check_cached(&ctx).unwrap();
        assert!(cached);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
