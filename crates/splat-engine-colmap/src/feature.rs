use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

use crate::database::{inspect_database, inspect_database_image_names};
use crate::execution::ColmapExecutionSettings;
use crate::runtime;
use crate::types::{CameraModel, FeatureExtractionResult};

/// Configuration options for COLMAP feature extraction.
///
/// Maps to COLMAP's `--FeatureExtraction.*`, `--SiftExtraction.*`, and
/// `--ImageReader.*` CLI flags.
#[derive(Debug, Clone)]
pub struct FeatureExtractionOptions {
    /// Enable GPU acceleration (`--FeatureExtraction.use_gpu`)
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
    execution_settings: Option<ColmapExecutionSettings>,
}

impl FeatureExtractor {
    /// Create a new feature extractor with the path to COLMAP.
    pub fn new(colmap_path: PathBuf) -> Self {
        Self {
            colmap_path,
            execution_settings: None,
        }
    }

    /// Select a validated frozen profile. Its backend overrides legacy options.
    pub fn with_execution_settings(mut self, settings: ColmapExecutionSettings) -> Self {
        self.execution_settings = Some(settings);
        self
    }

    /// Build a `CommandSpec` for `colmap feature_extractor`.
    ///
    /// Equivalent CLI:
    /// ```bash
    /// colmap feature_extractor \
    ///     --database_path <database_path> \
    ///     --image_path <image_path> \
    ///     --FeatureExtraction.use_gpu <1|0> \
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
        let mut args: Vec<std::ffi::OsString> = vec![
            "feature_extractor".into(),
            "--log_target".into(),
            "stderr".into(),
            "--database_path".into(),
            database_path.as_os_str().to_owned(),
            "--image_path".into(),
            image_path.as_os_str().to_owned(),
            "--FeatureExtraction.use_gpu".into(),
        ];
        let use_gpu = self
            .execution_settings
            .as_ref()
            .map(ColmapExecutionSettings::feature_uses_gpu)
            .unwrap_or(options.use_gpu);
        args.push(if use_gpu { "1" } else { "0" }.into());
        if let Some(settings) = &self.execution_settings {
            args.push("--FeatureExtraction.num_threads".into());
            args.push(settings.threads().to_string().into());
        }

        // Max features per image
        args.push("--SiftExtraction.max_num_features".into());
        args.push(options.max_num_features.to_string().into());

        // Single camera mode (recommended for video frames)
        args.push("--ImageReader.single_camera".into());
        args.push(if options.single_camera { "1" } else { "0" }.into());

        // Camera model
        args.push("--ImageReader.camera_model".into());
        args.push(options.camera_model.as_str().into());

        runtime::command_spec_with_settings(
            &self.colmap_path,
            args,
            log_path,
            self.execution_settings.as_ref(),
        )
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
        let input_images = image_names(image_path)?;
        let total_images = input_images.len();

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

        let stats = inspect_database(database_path)?;

        if stats.images == 0 || stats.keypoints == 0 {
            return Err(AppError::new(
                "E-3010",
                ErrorCategory::Engine,
                "未提取到可用图片特征",
                format!(
                    "输入共 {} 张图片，数据库中有 {} 张图片、{} 个特征点，未获得可用图片特征。\
                     请检查照片是否可读取、清晰且有足够纹理；必要时补拍后重新提取特征。",
                    total_images, stats.images, stats.keypoints
                ),
            )
            .with_suggestions(vec![
                "确认照片是可正常读取的 JPG/PNG 文件",
                "补拍清晰且有可识别纹理的照片，避免大面积纯色或模糊画面",
                "查看 COLMAP 日志确认是否存在图片解码错误，再重新提取特征",
            ]));
        }

        if stats.images != total_images {
            let registered = inspect_database_image_names(database_path)?
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            let missing = input_images
                .iter()
                .filter(|name| !registered.contains(*name))
                .take(8)
                .cloned()
                .collect::<Vec<_>>();
            let missing_text = if missing.is_empty() {
                "无法确定具体文件".to_string()
            } else {
                missing.join("、")
            };
            return Err(AppError::new(
                "E-3010",
                ErrorCategory::Engine,
                "部分图片特征提取失败",
                format!(
                    "COLMAP 为 {} / {} 张输入图片保存了特征。未成功处理：{}。\
                     请检查这些图片是否可读取及尺寸、相机分组是否兼容，再重试特征提取。",
                    stats.images, total_images, missing_text
                ),
            )
            .with_suggestions(vec![
                "图片文件夹项目应关闭 single-camera 模式，以支持横竖构图或不同尺寸",
                "检查被跳过图片在 COLMAP 日志中的 CAMERA_SINGLE_DIM_ERROR 或解码错误",
            ])
            .retryable(true));
        }

        Ok(FeatureExtractionResult {
            images_processed: stats.images,
            database_path: database_path.to_path_buf(),
            gpu_used,
        })
    }
}

/// Count image files (JPG/PNG) in a directory.
fn image_names(dir_path: &Path) -> AppResult<Vec<String>> {
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

    let mut names = reader
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
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();

    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CameraModel;

    fn extraction_fixture(
        input_names: &[&str],
        stored_images: &[(&str, usize)],
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        std::fs::create_dir(&images).unwrap();
        for name in input_names {
            // Validation enumerates filenames; image decoding belongs to COLMAP.
            std::fs::write(images.join(name), []).unwrap();
        }
        let database = dir.path().join("database.db");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY);\
                 CREATE TABLE images (image_id INTEGER PRIMARY KEY, name TEXT NOT NULL);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL);\
                 CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL);",
            )
            .unwrap();
        for (index, (name, keypoints)) in stored_images.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO images VALUES (?1, ?2)",
                    rusqlite::params![index + 1, name],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO keypoints VALUES (?1, ?2)",
                    rusqlite::params![index + 1, keypoints],
                )
                .unwrap();
        }
        (dir, database, images)
    }

    fn localized_extraction_error(error: AppError, retryable: bool) -> String {
        assert_eq!(error.code, "E-3010");
        assert_eq!(error.category, ErrorCategory::Engine);
        assert_eq!(error.retryable, retryable);
        let localized = error.localized_for_ui();
        assert_eq!(localized.title, error.title);
        assert_eq!(localized.user_message, error.user_message);
        assert_eq!(localized.suggestions, error.suggestions);
        assert!(!localized.suggestions.is_empty());
        assert_eq!(localized.code, error.code);
        assert_eq!(localized.category, error.category);
        assert_eq!(localized.retryable, error.retryable);
        assert_eq!(localized.technical_message, error.technical_message);
        assert_eq!(localized.log_path, error.log_path);
        let displayed = localized.to_string();
        assert_eq!(
            displayed,
            format!("[E-3010] {}: {}", error.title, error.user_message)
        );
        displayed
    }

    #[test]
    fn test_validate_extraction_empty_database_preserves_readability_guidance() {
        let (_dir, database, images) = extraction_fixture(&["a.jpg", "b.jpg"], &[]);
        let error = FeatureExtractor::validate_extraction(&database, &images, false).unwrap_err();
        let displayed = localized_extraction_error(error, false);
        assert!(displayed.contains("输入共 2 张图片，数据库中有 0 张图片、0 个特征点"));
        assert!(displayed.contains("可读取"));
        assert!(displayed.contains("重新提取特征"));
        assert!(!displayed.contains("全部图片已读取"));
    }

    #[test]
    fn test_validate_extraction_zero_keypoints_preserves_texture_guidance() {
        let (_dir, database, images) =
            extraction_fixture(&["a.jpg", "b.jpg"], &[("a.jpg", 0), ("b.jpg", 0)]);
        let error = FeatureExtractor::validate_extraction(&database, &images, false).unwrap_err();
        let displayed = localized_extraction_error(error, false);
        assert!(displayed.contains("输入共 2 张图片，数据库中有 2 张图片、0 个特征点"));
        assert!(displayed.contains("清晰且有足够纹理"));
        assert!(displayed.contains("补拍后重新提取特征"));
        assert!(!displayed.contains("引擎执行失败"));
    }

    #[test]
    fn test_validate_extraction_partial_ascii_names_survive_localization() {
        let (_dir, database, images) =
            extraction_fixture(&["a.jpg", "b.png", "c.jpg"], &[("a.jpg", 10)]);
        let error = FeatureExtractor::validate_extraction(&database, &images, false).unwrap_err();
        let displayed = localized_extraction_error(error, true);
        assert!(displayed.contains("部分图片特征提取失败"));
        assert!(displayed.contains("1 / 3 张输入图片"));
        assert!(displayed.contains("未成功处理：b.png、c.jpg"));
        assert!(displayed.contains("尺寸、相机分组是否兼容，再重试特征提取"));
        assert!(!displayed.contains("足够纹理"));
    }

    #[test]
    fn test_validate_extraction_partial_missing_names_stay_sorted_and_bounded() {
        let (_dir, database, images) = extraction_fixture(
            &[
                "present.jpg",
                "i.jpg",
                "h.jpg",
                "g.jpg",
                "f.jpg",
                "e.jpg",
                "d.jpg",
                "c.jpg",
                "b.jpg",
                "a-缺失.png",
            ],
            &[("present.jpg", 10)],
        );
        let error = FeatureExtractor::validate_extraction(&database, &images, false).unwrap_err();
        let displayed = localized_extraction_error(error, true);
        assert!(displayed.contains("1 / 10 张输入图片"));
        assert!(displayed
            .contains("未成功处理：a-缺失.png、b.jpg、c.jpg、d.jpg、e.jpg、f.jpg、g.jpg、h.jpg。"));
        assert!(!displayed.contains("i.jpg"));
    }

    #[test]
    fn test_validate_extraction_complete_database_keeps_success_metadata() {
        let (_dir, database, images) =
            extraction_fixture(&["a.jpg", "b.jpg"], &[("a.jpg", 10), ("b.jpg", 20)]);
        let result = FeatureExtractor::validate_extraction(&database, &images, true).unwrap();
        assert_eq!(result.images_processed, 2);
        assert_eq!(result.database_path, database);
        assert!(result.gpu_used);
    }

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

        assert!(args_str.contains("--FeatureExtraction.use_gpu 1"));
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

        assert!(args_str.contains("--FeatureExtraction.use_gpu 0"));
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

        let count = image_names(&dir).unwrap().len();
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

        let count = image_names(&dir).unwrap().len();
        assert_eq!(count, 2); // jpg + png

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_count_images_nonexistent_dir() {
        let result = image_names(Path::new("/nonexistent/colmap-test"));
        assert!(result.is_err());
    }
}
