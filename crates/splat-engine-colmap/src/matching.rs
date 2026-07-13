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
            let reason = if total_keypoints == 0 {
                "Feature extraction produced no keypoints for any image. \
                 The images may be corrupted or have insufficient detail."
            } else {
                "COLMAP found no matching features between any image pairs. \
                 This usually means the images lack sufficient overlap or texture."
            };

            return Err(AppError::new(
                "E-3020",
                ErrorCategory::Engine,
                "Feature Matching Failed",
                reason,
            )
            .with_suggestions(vec![
                "Ensure adjacent images have sufficient overlap (at least 50%)",
                "Check that the scene has enough texture and detail",
                "Try reducing the frame extraction interval for more images",
                "Avoid large areas of uniform color or repetitive patterns",
                "If using sequential matching, try increasing --SequentialMatching.overlap",
            ]));
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
