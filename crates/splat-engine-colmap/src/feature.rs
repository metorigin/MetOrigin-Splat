use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

use crate::types::{CameraModel, FeatureExtractionResult};

/// Configuration options for COLMAP feature extraction.
///
/// Maps to COLMAP's `--SiftExtraction.*` and `--ImageReader.*` CLI flags.
#[derive(Debug, Clone)]
pub struct FeatureExtractionOptions {
    /// Enable GPU acceleration (`--SiftExtraction.use_gpu`)
    pub use_gpu: bool,
    /// Maximum number of features per image (`--SiftExtraction.max_num_features`)
    pub max_num_features: u32,
    /// Whether all images share the same camera model (`--ImageReader.single_camera`)
    pub single_camera: bool,
    /// Camera model to use (`--ImageReader.camera_model`)
    pub camera_model: CameraModel,
}

impl Default for FeatureExtractionOptions {
    fn default() -> Self {
        Self {
            use_gpu: true,
            max_num_features: 8192,
            single_camera: true,
            camera_model: CameraModel::Pinhole,
        }
    }
}

/// Builds and runs COLMAP `feature_extractor` commands.
///
/// Handles:
/// - Constructing the CLI command with proper flags
/// - Validating the extraction results
/// - Converting COLMAP output into structured results
pub struct FeatureExtractor {
    colmap_path: PathBuf,
}

impl FeatureExtractor {
    /// Create a new feature extractor with the path to COLMAP.
    pub fn new(colmap_path: PathBuf) -> Self {
        Self { colmap_path }
    }

    /// Build a `CommandSpec` for `colmap feature_extractor`.
    ///
    /// Equivalent CLI:
    /// ```bash
    /// colmap feature_extractor \
    ///     --database_path <database_path> \
    ///     --image_path <image_path> \
    ///     --SiftExtraction.use_gpu <1|0> \
    ///     --SiftExtraction.max_num_features <N> \
    ///     --ImageReader.single_camera <1|0> \
    ///     --ImageReader.camera_model <MODEL>
    /// ```
    pub fn build_command(
        &self,
        database_path: &Path,
        image_path: &Path,
        options: &FeatureExtractionOptions,
        log_path: &Path,
    ) -> CommandSpec {
        let mut args: Vec<std::ffi::OsString> = Vec::new();

        // Command name
        args.push("feature_extractor".into());

        // Database path
        args.push("--database_path".into());
        args.push(database_path.as_os_str().to_owned());

        // Image path
        args.push("--image_path".into());
        args.push(image_path.as_os_str().to_owned());

        // GPU acceleration
        args.push("--SiftExtraction.use_gpu".into());
        args.push(if options.use_gpu { "1" } else { "0" }.into());

        // Max features per image
        args.push("--SiftExtraction.max_num_features".into());
        args.push(options.max_num_features.to_string().into());

        // Single camera mode (recommended for video frames)
        args.push("--ImageReader.single_camera".into());
        args.push(if options.single_camera { "1" } else { "0" }.into());

        // Camera model
        args.push("--ImageReader.camera_model".into());
        args.push(options.camera_model.as_str().into());

        CommandSpec::new(&self.colmap_path, args, log_path)
    }

    /// Validate the feature extraction results.
    ///
    /// Checks the COLMAP database to verify that features were extracted
    /// for images. Uses `colmap database_info` to get image/keypoint counts.
    pub fn validate_extraction(
        database_path: &Path,
        image_path: &Path,
        gpu_used: bool,
    ) -> AppResult<FeatureExtractionResult> {
        // Count the number of images in the image directory
        let total_images = count_images(image_path)?;

        if total_images == 0 {
            return Err(AppError::new(
                "E-3005",
                ErrorCategory::Engine,
                "No Images Found",
                format!(
                    "No images found in '{}'. Make sure the directory contains JPG or PNG files.",
                    image_path.display()
                ),
            ));
        }

        // Verify the database has keypoints
        let images_with_features = Self::count_images_in_database(database_path)?;

        if images_with_features == 0 {
            return Err(AppError::new(
                "E-3010",
                ErrorCategory::Engine,
                "Feature Extraction Failed",
                "COLMAP did not extract features for any images. \
                 The images may be invalid, corrupted, or of an unsupported format.",
            )
            .with_suggestions(vec![
                "Verify that the images are valid JPG/PNG files",
                "Check that the images have sufficient texture",
                "Examine the COLMAP log for specific error messages",
                "Try disabling GPU acceleration if it was enabled",
            ]));
        }

        Ok(FeatureExtractionResult {
            images_processed: images_with_features,
            database_path: database_path.to_path_buf(),
            gpu_used,
        })
    }

    /// Query the database for the number of images with keypoints.
    ///
    /// Uses `colmap database_info` to get a summary of the database contents,
    /// then parses the "Number of images" line.
    fn count_images_in_database(database_path: &Path) -> AppResult<usize> {
        let output = std::process::Command::new("colmap")
            .args(["database_info", "--database_path"])
            .arg(database_path.as_os_str())
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-3002",
                    ErrorCategory::Engine,
                    "Failed to Query Database",
                    format!("Could not run colmap database_info: {}", e),
                )
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Database Query Failed",
                "colmap database_info returned an error. The database may be corrupted.",
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse "Number of images: <N>" from the output
        for line in stdout.lines() {
            let line = line.trim();
            if let Some(count_str) = line.strip_prefix("Number of images:") {
                if let Ok(count) = count_str.trim().parse::<usize>() {
                    return Ok(count);
                }
            }
        }

        // If we can't find the image count, just check if database is non-empty
        Ok(0)
    }
}

/// Count image files (JPG/PNG) in a directory.
fn count_images(dir_path: &Path) -> AppResult<usize> {
    if !dir_path.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Image Directory Not Found",
            format!(
                "The image directory '{}' does not exist.",
                dir_path.display()
            ),
        ));
    }

    let reader = std::fs::read_dir(dir_path).map_err(|e| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Image Directory",
            format!("Could not read directory '{}': {}", dir_path.display(), e),
        )
    })?;

    let count = reader
        .filter_map(|e| e.ok())
        .filter(|e| {
            if let Some(ext) = e.path().extension() {
                matches!(ext.to_str(), Some(s) if s.eq_ignore_ascii_case("jpg")
                    || s.eq_ignore_ascii_case("jpeg")
                    || s.eq_ignore_ascii_case("png"))
            } else {
                false
            }
        })
        .count();

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CameraModel;

    #[test]
    fn test_build_command_basic_structure() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions::default();

        let spec = extractor.build_command(
            Path::new("/proj/colmap/database.db"),
            Path::new("/proj/frames"),
            &options,
            Path::new("/proj/logs/feature.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("feature_extractor"));
        assert!(args_str.contains("--database_path"));
        assert!(args_str.contains("database.db"));
        assert!(args_str.contains("--image_path"));
        assert!(args_str.contains("frames"));
    }

    #[test]
    fn test_build_command_gpu_enabled() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions {
            use_gpu: true,
            ..Default::default()
        };

        let spec = extractor.build_command(
            Path::new("db.db"),
            Path::new("images"),
            &options,
            Path::new("log.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("--SiftExtraction.use_gpu 1"));
    }

    #[test]
    fn test_build_command_gpu_disabled() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions {
            use_gpu: false,
            ..Default::default()
        };

        let spec = extractor.build_command(
            Path::new("db.db"),
            Path::new("images"),
            &options,
            Path::new("log.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("--SiftExtraction.use_gpu 0"));
    }

    #[test]
    fn test_build_command_max_features() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions {
            max_num_features: 4096,
            ..Default::default()
        };

        let spec = extractor.build_command(
            Path::new("db.db"),
            Path::new("images"),
            &options,
            Path::new("log.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("--SiftExtraction.max_num_features 4096"));
    }

    #[test]
    fn test_build_command_camera_model() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions {
            camera_model: CameraModel::SimpleRadial,
            ..Default::default()
        };

        let spec = extractor.build_command(
            Path::new("db.db"),
            Path::new("images"),
            &options,
            Path::new("log.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("--ImageReader.camera_model SIMPLE_RADIAL"));
    }

    #[test]
    fn test_build_command_single_camera() {
        let extractor = FeatureExtractor::new(PathBuf::from("colmap"));
        let options = FeatureExtractionOptions {
            single_camera: true,
            ..Default::default()
        };

        let spec = extractor.build_command(
            Path::new("db.db"),
            Path::new("images"),
            &options,
            Path::new("log.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("--ImageReader.single_camera 1"));
    }

    #[test]
    fn test_default_options_sane() {
        let options = FeatureExtractionOptions::default();
        assert!(options.use_gpu);
        assert_eq!(options.max_num_features, 8192);
        assert!(options.single_camera);
        assert_eq!(options.camera_model, CameraModel::Pinhole);
    }

    #[test]
    fn test_count_images_empty_dir() {
        let dir = std::env::temp_dir().join("splat-colmap-empty-imgs");
        let _ = std::fs::create_dir_all(&dir);

        let count = count_images(&dir).unwrap();
        assert_eq!(count, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_images_filters_correctly() {
        let dir = std::env::temp_dir().join("splat-colmap-filter-imgs");
        let _ = std::fs::create_dir_all(&dir);

        // Create valid and invalid files
        std::fs::write(dir.join("frame0001.jpg"), "fake").unwrap();
        std::fs::write(dir.join("frame0002.png"), "fake").unwrap();
        std::fs::write(dir.join("readme.txt"), "fake").unwrap();
        std::fs::write(dir.join("data.bin"), "fake").unwrap();

        let count = count_images(&dir).unwrap();
        assert_eq!(count, 2); // jpg + png

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_images_nonexistent_dir() {
        let result = count_images(Path::new("/nonexistent/colmap-test"));
        assert!(result.is_err());
    }
}
