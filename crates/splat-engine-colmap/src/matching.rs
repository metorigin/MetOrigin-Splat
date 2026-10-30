use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

use crate::database::inspect_database;
use crate::types::MatchingResult;

/// Validates the result of COLMAP feature matching.
///
/// After `colmap sequential_matcher` or `exhaustive_matcher` finishes,
/// this validator checks the database to confirm that feature matches
/// were actually found between images.
pub struct MatchingValidator;

impl MatchingValidator {
    /// Validate matching results by querying the COLMAP database.
    ///
    /// Runs `colmap database_info --database_path <path>` and parses
    /// the output to extract image/keypoint/match counts.
    ///
    /// # Errors
    ///
    /// Returns `E-3020` if no matches were found (matching failed).
    pub fn validate_matching(database_path: &Path) -> AppResult<MatchingResult> {
        let stats = inspect_database(database_path)?;
        let total_images = stats.images;
        let total_keypoints = stats.keypoints;
        let total_matches = stats.verified_matches;

        if total_matches == 0 {
            let (title, reason, suggestions) = if total_keypoints == 0 {
                (
                    "没有可用于匹配的图片特征",
                    format!(
                        "数据库中有 {} 张图片、0 个特征点，没有可用于匹配的图片特征。\
                         请检查照片是否可读取、清晰且有足够纹理，并从特征提取阶段重新处理。",
                        total_images
                    ),
                    vec![
                        "确认照片可正常读取，且画面清晰、有可识别纹理",
                        "查看特征提取日志，并从特征提取阶段重新处理",
                    ],
                )
            } else {
                (
                    "未找到有效图片匹配",
                    format!(
                        "数据库中已有 {} 张图片、{} 个特征点，但有效匹配为 0。\
                         请增加相邻照片的重叠，保留可识别纹理并补拍清晰照片后重试。",
                        total_images, total_keypoints
                    ),
                    vec![
                        "确保相邻照片有足够重叠，建议至少 50%",
                        "补拍包含清晰纹理和细节的照片，避免大面积纯色或重复图案",
                        "拍摄时保持相机稳定、减小相邻视角变化；视频可缩短抽帧间隔",
                    ],
                )
            };

            return Err(
                AppError::new("E-3020", ErrorCategory::Engine, title, reason)
                    .with_suggestions(suggestions),
            );
        }

        Ok(MatchingResult {
            has_matches: true,
            total_images,
            total_keypoints,
            total_matches,
        })
    }
}

/// Extract a numeric field value from `colmap database_info` output.
///
/// Handles lines like:
/// ```text
///   Number of images: 100
///   Number of matches: 15234
/// ```
///
/// Returns `0` if the field is not found or cannot be parsed.
pub fn parse_database_field(output: &str, field_name: &str) -> usize {
    if !field_name.ends_with(':') {
        return 0;
    }

    output
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some(value_str) = trimmed.strip_prefix(field_name) {
                value_str
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matching_fixture(
        keypoints: usize,
        matches: usize,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("database.db");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY);\
                 CREATE TABLE images (image_id INTEGER PRIMARY KEY);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL);\
                 CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL);\
                 INSERT INTO images VALUES (1), (2);",
            )
            .unwrap();
        for image_id in [1, 2] {
            connection
                .execute(
                    "INSERT INTO keypoints VALUES (?1, ?2)",
                    rusqlite::params![image_id, keypoints],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO two_view_geometries VALUES (2147483649, ?1)",
                [matches],
            )
            .unwrap();
        (dir, database)
    }

    fn localized_matching_error(error: AppError) -> String {
        assert_eq!(error.code, "E-3020");
        assert_eq!(error.category, ErrorCategory::Engine);
        assert!(!error.retryable);
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
            format!("[E-3020] {}: {}", error.title, error.user_message)
        );
        displayed
    }

    #[test]
    fn test_validate_matching_zero_keypoints_preserves_extraction_guidance() {
        let (_dir, database) = matching_fixture(0, 0);
        let error = MatchingValidator::validate_matching(&database).unwrap_err();
        let displayed = localized_matching_error(error);
        assert!(displayed.contains("2 张图片、0 个特征点"));
        assert!(displayed.contains("可读取、清晰且有足够纹理"));
        assert!(displayed.contains("从特征提取阶段重新处理"));
        assert!(!displayed.contains("重叠"));
    }

    #[test]
    fn test_validate_matching_no_matches_preserves_overlap_guidance() {
        let (_dir, database) = matching_fixture(123, 0);
        let error = MatchingValidator::validate_matching(&database).unwrap_err();
        let displayed = localized_matching_error(error);
        assert!(displayed.contains("2 张图片、246 个特征点，但有效匹配为 0"));
        assert!(displayed.contains("增加相邻照片的重叠"));
        assert!(displayed.contains("纹理并补拍清晰照片后重试"));
        assert!(!displayed.contains("引擎执行失败"));
    }

    #[test]
    fn test_validate_matching_verified_matches_keep_success_counts() {
        let (_dir, database) = matching_fixture(123, 42);
        let result = MatchingValidator::validate_matching(&database).unwrap();
        assert!(result.has_matches);
        assert_eq!(result.total_images, 2);
        assert_eq!(result.total_keypoints, 246);
        assert_eq!(result.total_matches, 42);
    }

    fn sample_database_output() -> &'static str {
        "Database summary:\n  Number of images: 100\n  Number of keypoints: 819200\n  Number of matches: 15234\n  Number of matched keypoints: 45678\n"
    }

    #[test]
    fn test_parse_database_field_images() {
        let result = parse_database_field(sample_database_output(), "Number of images:");
        assert_eq!(result, 100);
    }

    #[test]
    fn test_parse_database_field_keypoints() {
        let result = parse_database_field(sample_database_output(), "Number of keypoints:");
        assert_eq!(result, 819200);
    }

    #[test]
    fn test_parse_database_field_matches() {
        let result = parse_database_field(sample_database_output(), "Number of matches:");
        assert_eq!(result, 15234);
    }

    #[test]
    fn test_parse_database_field_missing() {
        let result = parse_database_field(sample_database_output(), "Number of foobar:");
        assert_eq!(result, 0);
    }

    #[test]
    fn test_parse_database_field_empty() {
        assert_eq!(parse_database_field("", "Number of images:"), 0);
    }

    #[test]
    fn test_parse_database_field_no_colon() {
        let output = "Something else 42";
        assert_eq!(parse_database_field(output, "Something else"), 0);
    }

    #[test]
    fn test_validate_matching_no_colmap() {
        // When colmap is not installed, this should return an engine error
        let result = MatchingValidator::validate_matching(Path::new("/nonexistent/database.db"));
        assert!(result.is_err());
        if let Err(e) = result {
            // Either E-3021 (can't run colmap) or E-3022 (non-zero exit)
            assert_eq!(e.category, ErrorCategory::Engine);
        }
    }
}
