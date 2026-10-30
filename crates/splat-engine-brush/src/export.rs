use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};

pub use crate::ply::PlyHeaderMetadata;

/// Parameters for a PLY export request.
#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// Training output directory (where Brush wrote its results)
    pub training_dir: PathBuf,
    /// Destination path for the exported PLY file
    pub output_path: PathBuf,
    /// Optional: specific checkpoint iteration to export
    pub checkpoint_iteration: Option<u32>,
}

/// Result of a PLY export operation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExportResult {
    /// Path to the exported PLY file
    pub ply_path: PathBuf,
    /// PLY file size in bytes
    pub size_bytes: u64,
    /// Training iteration count (0 if unknown)
    pub total_iterations: u32,
    /// Final training loss value (None if unknown)
    pub final_loss: Option<f64>,
}

/// Manages export of trained PLY models from Brush output.
///
/// # Output File Detection
///
/// ⚠️ Brush output file names must be verified against the pinned version.
/// Common patterns include:
/// - `point_cloud.ply` (root of training dir)
/// - `scene.ply`
/// - `output/point_cloud.ply`
pub struct ExportManager;

impl ExportManager {
    /// Find the best (most recent) PLY file from Brush output.
    ///
    /// Search order:
    /// 1. `training_dir/point_cloud.ply` — most common final output ⚠️
    /// 2. `training_dir/scene.ply` — alternative name ⚠️
    /// 3. `training_dir/output.ply` — generic name ⚠️
    /// 4. `training_dir/output/point_cloud.ply` — subdirectory
    /// 5. `training_dir/output/scene.ply` — subdirectory
    pub fn find_best_ply(training_dir: &Path) -> Option<PathBuf> {
        // Priority 1: Direct files in training root
        for name in &["point_cloud.ply", "scene.ply", "output.ply"] {
            let path = training_dir.join(name);
            if Self::validate_ply(&path).is_ok() {
                return Some(path);
            }
        }

        // Priority 2: Files in output/ subdirectory
        let output_dir = training_dir.join("output");
        if output_dir.exists() {
            for name in &["point_cloud.ply", "scene.ply"] {
                let path = output_dir.join(name);
                if Self::validate_ply(&path).is_ok() {
                    return Some(path);
                }
            }
        }

        // Priority 3: Any .ply file in the training directory root
        if let Ok(reader) = std::fs::read_dir(training_dir) {
            let mut ply_files: Vec<PathBuf> = reader
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
                // Return the most recently modified one
                ply_files.sort_by(|a, b| {
                    let ma = std::fs::metadata(a).and_then(|m| m.modified()).ok();
                    let mb = std::fs::metadata(b).and_then(|m| m.modified()).ok();
                    ma.cmp(&mb).reverse()
                });
                return ply_files
                    .into_iter()
                    .find(|path| Self::validate_ply(path).is_ok());
            }
        }

        None
    }

    /// Export a PLY file to the specified destination.
    ///
    /// Copies the best available PLY from the training output directory
    /// to the destination path. Creates parent directories as needed.
    pub fn export(request: &ExportRequest) -> AppResult<ExportResult> {
        // Find the source PLY
        let ply_source = Self::find_best_ply(&request.training_dir).ok_or_else(|| {
            AppError::new(
                "E-4005",
                ErrorCategory::Engine,
                "No Output PLY Found",
                format!(
                    "No PLY output found in '{}'. The training may not have completed \
                     or Brush did not generate an output file.",
                    request.training_dir.display()
                ),
            )
            .with_suggestions(vec![
                "Wait for training to complete",
                "Check the Brush log for errors",
                "Verify the output directory is not empty",
            ])
        })?;

        // Create parent directories for the destination
        if let Some(parent) = request.output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::new(
                    "E-1201",
                    ErrorCategory::Filesystem,
                    "Failed to Create Output Directory",
                    format!(
                        "Could not create output directory '{}': {}",
                        parent.display(),
                        e
                    ),
                )
            })?;
        }

        // Copy the PLY file
        std::fs::copy(&ply_source, &request.output_path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Export PLY",
                format!(
                    "Could not copy PLY from '{}' to '{}': {}",
                    ply_source.display(),
                    request.output_path.display(),
                    e
                ),
            )
        })?;
        Self::validate_ply(&request.output_path)?;

        // Get file metadata
        let meta = std::fs::metadata(&request.output_path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Output File",
                format!("Could not read exported PLY file: {}", e),
            )
        })?;

        tracing::info!(
            "PLY exported: {} -> {} ({} bytes)",
            ply_source.display(),
            request.output_path.display(),
            meta.len()
        );

        Ok(ExportResult {
            ply_path: request.output_path.clone(),
            size_bytes: meta.len(),
            total_iterations: 0, // TODO: read from checkpoint metadata
            final_loss: None,    // TODO: read from training log
        })
    }

    /// Validate the complete Gaussian header and every vertex value.
    ///
    /// Supports ASCII and both binary byte orders, including Brush 0.3 and 1.x
    /// float properties. Truncated, extra, non-finite or inconsistent SH data
    /// cannot be used as a completed model or a recovery checkpoint.
    pub fn validate_ply(path: &Path) -> AppResult<()> {
        Self::inspect_ply(path).map(|_| ())
    }

    /// Validate a complete model and return its verified Gaussian metadata.
    pub fn inspect_ply(path: &Path) -> AppResult<PlyHeaderMetadata> {
        crate::ply::metadata(path, true)
    }

    /// Fully validate the caller's already-open file, without reopening its path.
    pub fn inspect_open_ply(file: &mut std::fs::File) -> AppResult<PlyHeaderMetadata> {
        crate::ply::metadata_file(file, true)
    }

    /// Read only bounded native-preview header/layout metadata from the same
    /// opened handle. This does not establish that vertex values are valid;
    /// validate the actual response bytes before rendering them.
    pub fn read_preview_header(file: &mut std::fs::File) -> AppResult<PlyHeaderMetadata> {
        crate::ply::preview_header(file)
    }

    /// Fully validate borrowed native-preview response bytes in place. Supports
    /// the renderer's little-endian float32 SH0–3 format without copying a model.
    pub fn inspect_preview_bytes(bytes: &[u8]) -> AppResult<PlyHeaderMetadata> {
        crate::ply::preview_bytes(bytes)
    }

    /// Read a count only after validating the complete Gaussian file.
    ///
    /// Existing callers use a positive count to decide whether an artifact is
    /// usable, so this method must not accept a header-only or partial payload.
    pub fn vertex_count(path: &Path) -> AppResult<u64> {
        Self::inspect_ply(path).map(|metadata| metadata.vertex_count)
    }

    /// Read the header of a file that the caller has already validated.
    ///
    /// This fast path does NOT verify payload completeness. Never use it to
    /// decide whether a checkpoint, export, or preview is valid. The caller must
    /// establish that the previously validated file has not been modified.
    pub fn read_header_metadata(path: &Path) -> AppResult<PlyHeaderMetadata> {
        crate::ply::metadata(path, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_fake_ply(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let header = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
        ));
        std::fs::write(&path, header).unwrap();
        path
    }

    #[test]
    fn test_find_best_ply_direct() {
        let dir = std::env::temp_dir().join("splat-export-direct");
        let _ = std::fs::create_dir_all(&dir);
        create_fake_ply(&dir, "point_cloud.ply");

        let found = ExportManager::find_best_ply(&dir);
        assert!(found.is_some());
        assert!(found.unwrap().ends_with("point_cloud.ply"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_scene() {
        let dir = std::env::temp_dir().join("splat-export-scene");
        let _ = std::fs::create_dir_all(&dir);
        create_fake_ply(&dir, "scene.ply");

        let found = ExportManager::find_best_ply(&dir);
        assert!(found.is_some());
        assert!(found.unwrap().ends_with("scene.ply"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_in_output_subdir() {
        let dir = std::env::temp_dir().join("splat-export-subdir");
        let output_dir = dir.join("output");
        let _ = std::fs::create_dir_all(&output_dir);
        create_fake_ply(&output_dir, "point_cloud.ply");

        let found = ExportManager::find_best_ply(&dir);
        assert!(found.is_some());
        assert!(found.unwrap().ends_with("point_cloud.ply"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_ply_empty() {
        let dir = std::env::temp_dir().join("splat-export-empty");
        let _ = std::fs::create_dir_all(&dir);

        let found = ExportManager::find_best_ply(&dir);
        assert!(found.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_export_creates_copy() {
        let src_dir = std::env::temp_dir().join("splat-export-src");
        let dst_dir = std::env::temp_dir().join("splat-export-dst");
        let _ = std::fs::create_dir_all(&src_dir);
        create_fake_ply(&src_dir, "point_cloud.ply");

        let dst_path = dst_dir.join("scene.ply");
        let request = ExportRequest {
            training_dir: src_dir.clone(),
            output_path: dst_path.clone(),
            checkpoint_iteration: None,
        };

        let result = ExportManager::export(&request).unwrap();
        assert!(result.ply_path.exists());
        assert!(result.size_bytes > 0);

        // Verify content
        let original = std::fs::read_to_string(src_dir.join("point_cloud.ply")).unwrap();
        let exported = std::fs::read_to_string(&dst_path).unwrap();
        assert_eq!(original, exported);

        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dst_dir);
    }

    #[test]
    fn test_export_no_source() {
        let request = ExportRequest {
            training_dir: PathBuf::from("/nonexistent/training"),
            output_path: PathBuf::from("/nonexistent/output.ply"),
            checkpoint_iteration: None,
        };

        let result = ExportManager::export(&request);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_ply_valid() {
        let dir = std::env::temp_dir().join("splat-validate-ply");
        let _ = std::fs::create_dir_all(&dir);
        let path = create_fake_ply(&dir, "test.ply");

        assert!(ExportManager::validate_ply(&path).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ply_empty_file() {
        let dir = std::env::temp_dir().join("splat-validate-empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.ply");
        std::fs::write(&path, b"").unwrap();

        let result = ExportManager::validate_ply(&path);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ply_not_found() {
        let result = ExportManager::validate_ply(Path::new("/nonexistent/model.ply"));
        assert!(result.is_err());
    }

    #[test]
    fn invalid_preferred_output_does_not_hide_a_valid_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("point_cloud.ply"), b"ply\n").unwrap();
        create_fake_ply(dir.path(), "scene.ply");
        assert_eq!(
            ExportManager::find_best_ply(dir.path()),
            Some(dir.path().join("scene.ply"))
        );
        assert!(dir.path().join("point_cloud.ply").exists());
    }

    #[test]
    fn invalid_source_cannot_replace_an_existing_export() {
        let dir = tempfile::tempdir().unwrap();
        let training = dir.path().join("training");
        std::fs::create_dir(&training).unwrap();
        std::fs::write(training.join("point_cloud.ply"), b"ply\n").unwrap();
        let output = create_fake_ply(dir.path(), "scene.ply");
        let original = std::fs::read(&output).unwrap();
        assert!(ExportManager::export(&ExportRequest {
            training_dir: training,
            output_path: output.clone(),
            checkpoint_iteration: None,
        })
        .is_err());
        assert_eq!(std::fs::read(output).unwrap(), original);
    }
}
