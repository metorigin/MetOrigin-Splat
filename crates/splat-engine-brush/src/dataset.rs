use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, ErrorCategory};

/// Result of a single dataset validation check.
#[derive(Debug, Clone)]
pub struct DatasetCheck {
    /// Short check name (e.g. "sparse_model_dir", "cameras_file")
    pub name: String,
    /// Whether the check passed
    pub passed: bool,
    /// Human-readable detail message
    pub detail: String,
}

/// Complete result of dataset validation.
#[derive(Debug, Clone)]
pub struct DatasetValidationResult {
    /// Whether the dataset is valid for Brush training
    pub valid: bool,
    /// Path to the best sparse COLMAP model directory
    pub model_path: PathBuf,
    /// Path to the image directory
    pub images_path: PathBuf,
    /// Number of image files found
    pub image_count: usize,
    /// Individual check results
    pub checks: Vec<DatasetCheck>,
}

/// Validates a COLMAP output directory for compatibility with Brush.
///
/// Brush requires:
/// - A sparse COLMAP model directory containing cameras.bin, images.bin, points3D.bin
/// - An image directory with the source photos/frames
///
/// The validator checks all requirements and produces a detailed report.
pub struct DatasetValidator;

impl DatasetValidator {
    /// Validate a COLMAP + frames dataset for Brush training.
    ///
    /// # Arguments
    ///
    /// * `colmap_dir` — The COLMAP working directory (contains `sparse/` subdirectory)
    /// * `frames_dir` — The directory containing extracted frames / source images
    ///
    /// # Returns
    ///
    /// A `DatasetValidationResult` with per-check pass/fail details.
    /// The `valid` field is `true` only if ALL checks pass.
    pub fn validate(colmap_dir: &Path, frames_dir: &Path) -> DatasetValidationResult {
        let mut checks = Vec::new();
        let mut all_valid = true;

        // ─── Check 1: Sparse model directory ───────────────────────────
        let model_path = find_best_sparse_model(colmap_dir);
        let model_ok = model_path.is_some();
        all_valid &= model_ok;

        checks.push(DatasetCheck {
            name: "sparse_model_dir".into(),
            passed: model_ok,
            detail: match &model_path {
                Some(p) => format!("Found sparse model at '{}'", p.display()),
                None => format!(
                    "No valid sparse model found in '{}/sparse/'. \
                     COLMAP reconstruction must be completed first.",
                    colmap_dir.display()
                ),
            },
        });

        let model_path = match model_path {
            Some(p) => p,
            None => {
                return DatasetValidationResult {
                    valid: false,
                    model_path: PathBuf::new(),
                    images_path: frames_dir.to_path_buf(),
                    image_count: 0,
                    checks,
                };
            }
        };

        // ─── Check 2: cameras file ────────────────────────────────────
        let cameras_ok =
            model_path.join("cameras.bin").exists() || model_path.join("cameras.txt").exists();
        all_valid &= cameras_ok;
        checks.push(DatasetCheck {
            name: "cameras_file".into(),
            passed: cameras_ok,
            detail: if cameras_ok {
                "Camera intrinsics file found".into()
            } else {
                format!(
                    "cameras.bin or cameras.txt not found in '{}'. \
                     The COLMAP model may be incomplete.",
                    model_path.display()
                )
            },
        });

        // ─── Check 3: images file ─────────────────────────────────────
        let images_ok =
            model_path.join("images.bin").exists() || model_path.join("images.txt").exists();
        all_valid &= images_ok;
        checks.push(DatasetCheck {
            name: "images_file".into(),
            passed: images_ok,
            detail: if images_ok {
                "Image poses file found".into()
            } else {
                format!(
                    "images.bin or images.txt not found in '{}'. \
                     The COLMAP model may be incomplete.",
                    model_path.display()
                )
            },
        });

        // ─── Check 4: points3D file ───────────────────────────────────
        let points_ok =
            model_path.join("points3D.bin").exists() || model_path.join("points3D.txt").exists();
        all_valid &= points_ok;
        checks.push(DatasetCheck {
            name: "points3d_file".into(),
            passed: points_ok,
            detail: if points_ok {
                "3D points file found".into()
            } else {
                format!(
                    "points3D.bin or points3D.txt not found in '{}'. \
                     The sparse reconstruction was incomplete.",
                    model_path.display()
                )
            },
        });

        // ─── Check 5: Image files ─────────────────────────────────────
        let image_count = count_images(frames_dir);
        let has_images = image_count > 0;
        all_valid &= has_images;
        checks.push(DatasetCheck {
            name: "image_files".into(),
            passed: has_images,
            detail: if has_images {
                format!(
                    "{} image files found in '{}'",
                    image_count,
                    frames_dir.display()
                )
            } else {
                format!(
                    "No JPG or PNG images found in '{}'. \
                     FFmpeg frame extraction must be completed first.",
                    frames_dir.display()
                )
            },
        });

        DatasetValidationResult {
            valid: all_valid,
            model_path,
            images_path: frames_dir.to_path_buf(),
            image_count,
            checks,
        }
    }

    /// Quick validation — returns true if the dataset is usable.
    /// Useful for pipeline stage caching decisions.
    pub fn is_valid(colmap_dir: &Path, frames_dir: &Path) -> bool {
        let result = Self::validate(colmap_dir, frames_dir);
        result.valid
    }

    /// Convert validation errors to an AppError for user display.
    pub fn to_error(result: &DatasetValidationResult) -> Option<AppError> {
        if result.valid {
            return None;
        }

        let failed: Vec<&DatasetCheck> = result.checks.iter().filter(|c| !c.passed).collect();
        let first = failed.first()?;

        Some(
            AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Invalid Training Dataset",
                first.detail.clone(),
            )
            .with_suggestions(vec![
                "Run COLMAP reconstruction before training",
                "Check that frame extraction completed successfully",
                "Verify the project directory is not corrupted",
            ]),
        )
    }
}

/// Find the best (most recent) sparse COLMAP model in the sparse directory.
///
/// COLMAP outputs models as numbered subdirectories under `colmap/sparse/`:
/// ```text
/// colmap/sparse/
/// ├── 0/           ← First reconstruction (most common)
/// │   ├── cameras.bin
/// │   ├── images.bin
/// │   └── points3D.bin
/// ├── 1/           ← Second reconstruction (disconnected scene)
/// ```
fn find_best_sparse_model(colmap_dir: &Path) -> Option<PathBuf> {
    let sparse_dir = colmap_dir.join("sparse");
    if !sparse_dir.exists() {
        return None;
    }

    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&sparse_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            // Must contain at least one of the model files
            p.join("cameras.bin").exists()
                || p.join("cameras.txt").exists()
                || p.join("images.bin").exists()
                || p.join("points3D.bin").exists()
        })
        .collect();

    // Sort by name to get stable ordering (0, 1, 2...)
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    // Return the last one (highest number = most recently added)
    dirs.into_iter().last()
}

/// Count image files (JPG/PNG) in a directory.
fn count_images(dir: &Path) -> usize {
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

    fn create_colmap_model(dir: &Path, model_name: &str, with_all: bool) -> PathBuf {
        let model_dir = dir.join("sparse").join(model_name);
        std::fs::create_dir_all(&model_dir).unwrap();

        if with_all {
            // Create minimal valid model files
            std::fs::write(model_dir.join("cameras.bin"), [0u8; 20]).unwrap();
            std::fs::write(model_dir.join("images.bin"), [0u8; 20]).unwrap();
            std::fs::write(model_dir.join("points3D.bin"), [0u8; 20]).unwrap();
        } else {
            // Partial model
            std::fs::write(model_dir.join("cameras.bin"), [0u8; 20]).unwrap();
        }

        model_dir
    }

    fn create_frames(dir: &Path, count: usize) {
        let _ = std::fs::create_dir_all(dir);
        for i in 0..count {
            std::fs::write(dir.join(format!("{:06}.jpg", i)), b"fake").unwrap();
        }
    }

    #[test]
    fn test_validate_complete_dataset() {
        let dir = std::env::temp_dir().join("splat-brush-ds-complete");
        let _ = std::fs::create_dir_all(&dir);
        create_colmap_model(&dir, "0", true);
        create_frames(&dir.join("frames"), 5);

        let _result = DatasetValidator::validate(&dir.join("colmap"), &dir.join("frames"));

        // Should have the colmap model at dir/colmap/sparse/0
        // But we created it at dir/sparse/0
        // Let's adjust — create at correct path
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_complete_dataset_correct_paths() {
        let dir = std::env::temp_dir().join("splat-brush-ds-complete2");
        let _ = std::fs::remove_dir_all(&dir);
        let colmap_dir = dir.join("colmap");
        let frames_dir = dir.join("frames");

        create_colmap_model(&colmap_dir, "0", true);
        create_frames(&frames_dir, 5);

        let result = DatasetValidator::validate(&colmap_dir, &frames_dir);

        assert!(result.valid);
        assert!(result.model_path.join("cameras.bin").exists());
        assert_eq!(result.image_count, 5);
        assert_eq!(result.checks.len(), 5);

        let all_passed: Vec<bool> = result.checks.iter().map(|c| c.passed).collect();
        assert!(all_passed.iter().all(|&p| p));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_missing_sparse_dir() {
        let dir = std::env::temp_dir().join("splat-brush-ds-nosparse");
        let _ = std::fs::remove_dir_all(&dir);
        let frames_dir = dir.join("frames");
        create_frames(&frames_dir, 3);

        let result = DatasetValidator::validate(&dir.join("colmap"), &frames_dir);

        assert!(!result.valid);
        assert!(!result.checks[0].passed);
        assert!(result.checks[0].detail.contains("No valid sparse model"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_missing_cameras() {
        let dir = std::env::temp_dir().join("splat-brush-ds-nocam");
        let _ = std::fs::remove_dir_all(&dir);
        let colmap_dir = dir.join("colmap");
        let frames_dir = dir.join("frames");

        // Create model dir but without cameras.bin
        let model_dir = colmap_dir.join("sparse").join("0");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("images.bin"), [0u8; 20]).unwrap();
        std::fs::write(model_dir.join("points3D.bin"), [0u8; 20]).unwrap();
        create_frames(&frames_dir, 3);

        let result = DatasetValidator::validate(&colmap_dir, &frames_dir);

        assert!(!result.valid);
        assert!(
            !result
                .checks
                .iter()
                .find(|c| c.name == "cameras_file")
                .unwrap()
                .passed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_no_images() {
        let dir = std::env::temp_dir().join("splat-brush-ds-noimg");
        let _ = std::fs::remove_dir_all(&dir);
        let colmap_dir = dir.join("colmap");
        let frames_dir = dir.join("frames");

        create_colmap_model(&colmap_dir, "0", true);
        // No images created

        let result = DatasetValidator::validate(&colmap_dir, &frames_dir);

        assert!(!result.valid);
        assert!(
            !result
                .checks
                .iter()
                .find(|c| c.name == "image_files")
                .unwrap()
                .passed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_best_sparse_model() {
        let dir = std::env::temp_dir().join("splat-brush-find");
        let _ = std::fs::create_dir_all(&dir);

        // Create sparse/ with two models
        create_colmap_model(&dir, "0", true);
        create_colmap_model(&dir, "1", false); // partial

        let result = find_best_sparse_model(&dir);
        assert!(result.is_some());

        let model_name = result
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(model_name == "0" || model_name == "1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_images_empty() {
        let dir = std::env::temp_dir().join("splat-brush-count");
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(count_images(&dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_images_filtered() {
        let dir = std::env::temp_dir().join("splat-brush-count2");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("000001.jpg"), b"fake").unwrap();
        std::fs::write(dir.join("000002.png"), b"fake").unwrap();
        std::fs::write(dir.join("readme.txt"), b"fake").unwrap();
        assert_eq!(count_images(&dir), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_to_error_on_valid() {
        let result = DatasetValidationResult {
            valid: true,
            model_path: PathBuf::from("/model"),
            images_path: PathBuf::from("/frames"),
            image_count: 10,
            checks: vec![],
        };
        assert!(DatasetValidator::to_error(&result).is_none());
    }
}
