use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};

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
                return Some(ply_files[0].clone());
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

    /// Validate that a PLY file exists and has reasonable content.
    pub fn validate_ply(path: &Path) -> AppResult<()> {
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
                "Failed to Read PLY File",
                format!("Could not read PLY file: {}", e),
            )
        })?;

        if meta.len() == 0 {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "Empty PLY File",
                format!(
                    "The PLY file '{}' is empty (0 bytes). The model may have failed to export.",
                    path.display()
                ),
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

        if Self::vertex_count(path)? == 0 {
            return Err(AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "PLY Contains No Splats",
                "The PLY header reports zero vertices.",
            ));
        }

        Ok(())
    }

    /// Read the `element vertex` count from an ASCII or binary PLY header.
    pub fn vertex_count(path: &Path) -> AppResult<u64> {
        use std::io::BufRead;

        let file = std::fs::File::open(path).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read PLY Header",
                "The PLY file could not be opened for validation.",
            )
            .with_technical(error.to_string())
        })?;
        let mut reader = std::io::BufReader::new(file);
        let mut line = String::new();
        let mut vertices = None;
        loop {
            line.clear();
            let bytes = reader.read_line(&mut line).map_err(|error| {
                AppError::new(
                    "E-4006",
                    ErrorCategory::Engine,
                    "Invalid PLY Header",
                    "The PLY header could not be parsed.",
                )
                .with_technical(error.to_string())
            })?;
            if bytes == 0 || line.trim() == "end_header" {
                break;
            }
            if let Some(value) = line.trim().strip_prefix("element vertex ") {
                vertices = value.parse::<u64>().ok();
            }
        }
        vertices.ok_or_else(|| {
            AppError::new(
                "E-4006",
                ErrorCategory::Engine,
                "PLY Vertex Count Missing",
                "The PLY header does not declare an element vertex count.",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_fake_ply(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let header = b"ply\nformat ascii 1.0\ncomment test\nelement vertex 1\nend_header\n0\n";
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
}
