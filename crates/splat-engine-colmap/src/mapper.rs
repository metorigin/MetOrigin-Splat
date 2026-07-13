use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

use crate::result::ColmapResult;
use crate::types::ModelInfo;

/// Executes and analyzes COLMAP sparse reconstruction (mapper).
///
/// Responsibilities:
/// - Building `colmap mapper` commands
/// - Running `colmap model_analyzer` on output models
/// - Selecting the best model when multiple disconnected reconstructions exist
/// - Parsing model statistics into structured `ColmapResult`
pub struct ColmapMapper {
    colmap_path: PathBuf,
}

impl ColmapMapper {
    /// Create a new mapper with the path to the COLMAP executable.
    pub fn new(colmap_path: PathBuf) -> Self {
        Self { colmap_path }
    }

    /// Build a `CommandSpec` for `colmap mapper`.
    ///
    /// Equivalent CLI:
    /// ```bash
    /// colmap mapper \
    ///     --database_path <database_path> \
    ///     --image_path <image_path> \
    ///     --output_path <output_path>
    /// ```
    pub fn build_command(
        &self,
        database_path: &Path,
        image_path: &Path,
        output_path: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        CommandSpec::new(
            &self.colmap_path,
            vec![
                "mapper".into(),
                "--database_path".into(),
                database_path.as_os_str().to_owned(),
                "--image_path".into(),
                image_path.as_os_str().to_owned(),
                "--output_path".into(),
                output_path.as_os_str().to_owned(),
            ],
            log_path,
        )
    }

    /// Analyze the sparse reconstruction output directory.
    ///
    /// Scans for model subdirectories (`0/`, `1/`, ...), runs
    /// `colmap model_analyzer` on each, and selects the one with
    /// the most registered images.
    ///
    /// # Errors
    ///
    /// Returns:
    /// - `E-3030` if no valid models found in the sparse directory
    /// - `E-3031` if the sparse directory does not exist
    pub fn analyze_result(
        &self,
        sparse_dir: &Path,
        total_input_images: usize,
    ) -> AppResult<ColmapResult> {
        if !sparse_dir.exists() {
            return Err(AppError::new(
                "E-3031",
                ErrorCategory::Filesystem,
                "Sparse Directory Not Found",
                format!(
                    "The COLMAP sparse output directory '{}' does not exist. \
                     Mapping may not have been executed.",
                    sparse_dir.display()
                ),
            ));
        }

        // 1. Find all model subdirectories
        let model_dirs = find_model_directories(sparse_dir)?;

        if model_dirs.is_empty() {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "No Sparse Model Generated",
                "COLMAP mapper did not produce any valid sparse reconstruction. \
                 The reconstruction may have failed completely.",
            )
            .with_suggestions(vec![
                "Check that images have sufficient quality and overlap",
                "Examine the COLMAP mapper log for specific errors",
                "Try with a smaller subset of images to isolate the issue",
            ]));
        }

        // 2. Run model_analyzer on each model
        let mut models: Vec<(PathBuf, ModelInfo)> = Vec::new();
        for dir in &model_dirs {
            match self.analyze_model(dir) {
                Ok(info) => models.push((dir.clone(), info)),
                Err(e) => {
                    tracing::warn!("Failed to analyze model '{}': {}", dir.display(), e);
                }
            }
        }

        if models.is_empty() {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "No Analyzable Sparse Model",
                "COLMAP produced model directories but none could be analyzed. \
                 The model files may be corrupted or in an unexpected format.",
            ));
        }

        // 3. Sort by registered images (descending) — pick the best
        models.sort_by_key(|model| std::cmp::Reverse(model.1.registered_images));
        let (best_dir, best_info) = &models[0];

        // 4. Warn about disconnected models
        if models.len() > 1 {
            tracing::warn!(
                "COLMAP produced {} disconnected models. Selected '{}' with {} images.",
                models.len(),
                best_dir.file_name().unwrap_or_default().to_string_lossy(),
                best_info.registered_images,
            );
        }

        tracing::info!(
            "Sparse reconstruction: {} registered images, {} 3D points, {:.3}px reprojection error",
            best_info.registered_images,
            best_info.point_count,
            best_info.mean_reprojection_error,
        );

        Ok(ColmapResult {
            registered_images: best_info.registered_images,
            total_images: total_input_images,
            point_count: best_info.point_count,
            model_path: best_dir.clone(),
            observations: Some(best_info.observations),
            mean_reprojection_error: Some(best_info.mean_reprojection_error),
        })
    }

    /// Analyze one sparse model with this adapter's resolved COLMAP binary.
    pub fn analyze_model(&self, model_dir: &Path) -> AppResult<ModelInfo> {
        analyze_model(&self.colmap_path, model_dir)
    }
}

/// Run `colmap model_analyzer` on a model directory and parse the output.
fn analyze_model(colmap_path: &Path, model_dir: &Path) -> AppResult<ModelInfo> {
    let output = std::process::Command::new(colmap_path)
        .args(["model_analyzer", "--path"])
        .arg(model_dir.as_os_str())
        .output()
        .map_err(|e| {
            AppError::new(
                "E-3032",
                ErrorCategory::Engine,
                "Model Analyzer Failed",
                format!("Could not run colmap model_analyzer: {}", e),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::new(
            "E-3032",
            ErrorCategory::Engine,
            "Model Analyzer Error",
            format!(
                "colmap model_analyzer returned an error for '{}': {}",
                model_dir.display(),
                stderr.trim()
            ),
        ));
    }

    let analyzer_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(ModelInfo {
        cameras: parse_int_field(&analyzer_output, "Cameras:"),
        images: parse_int_field(&analyzer_output, "Images:"),
        registered_images: parse_int_field(&analyzer_output, "Registered images:"),
        point_count: parse_int_field(&analyzer_output, "Points:"),
        observations: parse_int_field(&analyzer_output, "Observations:"),
        mean_track_length: parse_float_field(&analyzer_output, "Mean track length:"),
        mean_reprojection_error: parse_float_field(&analyzer_output, "Mean reprojection error:"),
    })
}

/// Find all valid model subdirectories within a sparse directory.
///
/// A valid model directory contains `cameras.bin` or `cameras.txt`.
fn find_model_directories(sparse_dir: &Path) -> AppResult<Vec<PathBuf>> {
    let reader = std::fs::read_dir(sparse_dir).map_err(|e| {
        AppError::new(
            "E-3031",
            ErrorCategory::Filesystem,
            "Failed to Read Sparse Directory",
            format!(
                "Could not read sparse directory '{}': {}",
                sparse_dir.display(),
                e
            ),
        )
    })?;

    let mut dirs: Vec<PathBuf> = reader
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let has_bin = p.join("cameras.bin").exists()
                || p.join("images.bin").exists()
                || p.join("points3D.bin").exists();
            let has_txt = p.join("cameras.txt").exists();
            has_bin || has_txt
        })
        .collect();

    // Sort by name (0, 1, 2, ...) for consistent ordering
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    Ok(dirs)
}

// ─── Parsing helpers ──────────────────────────────────────────────────────

/// Parse an integer field from model_analyzer output.
///
/// ```text
/// Cameras: 703          → 703
/// Registered images: 0  → 0
/// ```
fn parse_int_field(output: &str, field: &str) -> usize {
    output
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some((_, value)) = trimmed.split_once(field) {
                value.split_whitespace().next().and_then(|v| v.parse().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// Parse a float field from model_analyzer output.
///
/// Handles:
/// ```text
/// Mean track length: 15.75         → 15.75
/// Mean reprojection error: 0.85px  → 0.85
/// ```
fn parse_float_field(output: &str, field: &str) -> f64 {
    output
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some((_, value)) = trimmed.split_once(field) {
                let raw = value.split_whitespace().next()?;
                // Strip trailing "px" suffix if present
                let cleaned = if let Some(stripped) = raw.strip_suffix("px") {
                    stripped
                } else {
                    raw
                };
                cleaned.parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_output() -> &'static str {
        "Cameras: 703\nImages: 703\nRegistered images: 703\nPoints: 226238\nObservations: 3563506\nMean track length: 15.751138\nMean observations per image: 5068.998578\nMean reprojection error: 0.854211px\n"
    }

    fn colmap_4_output() -> &'static str {
        "I20260713 22:51:29.237229 93340 model.cc:441] Cameras: 1\n\
I20260713 22:51:29.237253 93340 model.cc:445] Images: 197\n\
I20260713 22:51:29.237257 93340 model.cc:446] Registered images: 197\n\
I20260713 22:51:29.237261 93340 model.cc:448] Points: 28456\n\
I20260713 22:51:29.237265 93340 model.cc:449] Observations: 178663\n\
I20260713 22:51:29.237300 93340 model.cc:451] Mean track length: 6.278570\n\
I20260713 22:51:29.237327 93340 model.cc:456] Mean reprojection error: 0.717093px\n"
    }

    // ─── parse_int_field ───────────────────────────────────────────────

    #[test]
    fn test_parse_int_cameras() {
        assert_eq!(parse_int_field(sample_output(), "Cameras:"), 703);
    }

    #[test]
    fn test_parse_int_images() {
        assert_eq!(parse_int_field(sample_output(), "Images:"), 703);
    }

    #[test]
    fn test_parse_int_registered() {
        assert_eq!(parse_int_field(sample_output(), "Registered images:"), 703);
    }

    #[test]
    fn test_parse_int_points() {
        assert_eq!(parse_int_field(sample_output(), "Points:"), 226238);
    }

    #[test]
    fn test_parse_int_observations() {
        assert_eq!(parse_int_field(sample_output(), "Observations:"), 3563506);
    }

    #[test]
    fn test_parse_int_missing_field() {
        assert_eq!(parse_int_field(sample_output(), "Foobar:"), 0);
    }

    #[test]
    fn test_parse_int_empty() {
        assert_eq!(parse_int_field("", "Cameras:"), 0);
    }

    #[test]
    fn test_parse_int_zero() {
        assert_eq!(
            parse_int_field("Registered images: 0", "Registered images:"),
            0
        );
    }

    #[test]
    fn test_parse_colmap_4_prefixed_output() {
        let output = colmap_4_output();
        assert_eq!(parse_int_field(output, "Cameras:"), 1);
        assert_eq!(parse_int_field(output, "Registered images:"), 197);
        assert_eq!(parse_int_field(output, "Points:"), 28_456);
        assert_eq!(parse_int_field(output, "Observations:"), 178_663);
        assert!((parse_float_field(output, "Mean track length:") - 6.278570).abs() < 0.0001);
        assert!((parse_float_field(output, "Mean reprojection error:") - 0.717093).abs() < 0.0001);
    }

    // ─── parse_float_field ─────────────────────────────────────────────

    #[test]
    fn test_parse_float_track_length() {
        let v = parse_float_field(sample_output(), "Mean track length:");
        assert!((v - 15.751138).abs() < 0.0001);
    }

    #[test]
    fn test_parse_float_reprojection_error() {
        let v = parse_float_field(sample_output(), "Mean reprojection error:");
        assert!((v - 0.854211).abs() < 0.0001);
    }

    #[test]
    fn test_parse_float_without_px() {
        let output = "Mean reprojection error: 0.85\n";
        let v = parse_float_field(output, "Mean reprojection error:");
        assert!((v - 0.85).abs() < 0.001);
    }

    #[test]
    fn test_parse_float_missing_field() {
        assert!((parse_float_field(sample_output(), "Foobar:") - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_float_empty() {
        assert!((parse_float_field("", "Mean track length:") - 0.0).abs() < 0.001);
    }

    // ─── find_model_directories ────────────────────────────────────────

    #[test]
    fn test_find_model_directories_empty() {
        let dir = std::env::temp_dir().join("splat-colmap-find-empty");
        let _ = std::fs::create_dir_all(&dir);
        let result = find_model_directories(&dir).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_model_directories_with_cameras_bin() {
        let dir = std::env::temp_dir().join("splat-colmap-find-bin");
        let model_dir = dir.join("0");
        let _ = std::fs::create_dir_all(&model_dir);
        // Create a minimal cameras.bin marker
        std::fs::write(model_dir.join("cameras.bin"), [0u8; 10]).unwrap();

        let result = find_model_directories(&dir).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name().unwrap(), "0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_model_directories_only_valid() {
        let dir = std::env::temp_dir().join("splat-colmap-find-valid");
        let _ = std::fs::create_dir_all(dir.join("0"));
        let _ = std::fs::create_dir_all(dir.join("logs")); // no cameras.bin
        let _ = std::fs::create_dir_all(dir.join("tmp"));

        std::fs::write(dir.join("0").join("cameras.bin"), [0u8; 10]).unwrap();

        let result = find_model_directories(&dir).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name().unwrap(), "0");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
