use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

use crate::types::{CameraInfo, DiagnosticLevel, ModelInfo};

/// Options controlling model validation thresholds.
#[derive(Debug, Clone)]
pub struct ValidationOptions {
    /// Minimum acceptable registration rate (0.0 – 1.0). Default: 0.5
    pub min_registration_rate: f64,
    /// Maximum acceptable mean reprojection error in pixels. Default: 3.0
    pub max_reprojection_error: f64,
    /// Minimum number of 3D points required. Default: 1000
    pub min_points: usize,
}

impl Default for ValidationOptions {
    fn default() -> Self {
        Self {
            min_registration_rate: 0.5,
            max_reprojection_error: 3.0,
            min_points: 1000,
        }
    }
}

/// Result of a single validation check.
#[derive(Debug, Clone)]
pub struct ValidationCheck {
    /// Short check name (e.g. "registration_rate", "point_count")
    pub name: String,
    /// Whether the check passed
    pub passed: bool,
    /// Human-readable detail message
    pub detail: String,
    /// Severity level
    pub severity: DiagnosticLevel,
}

/// Complete report from model validation.
#[derive(Debug, Clone)]
pub struct ValidationReport {
    /// Whether all critical checks passed
    pub passed: bool,
    /// The model info that was validated
    pub model_info: ModelInfo,
    /// Individual check results
    pub checks: Vec<ValidationCheck>,
}

impl ValidationReport {
    /// Get all failed checks (for diagnostics).
    pub fn failed_checks(&self) -> Vec<&ValidationCheck> {
        self.checks.iter().filter(|c| !c.passed).collect()
    }

    /// Get the most severe level across all checks.
    pub fn worst_level(&self) -> DiagnosticLevel {
        self.checks
            .iter()
            .map(|c| c.severity)
            .max()
            .unwrap_or(DiagnosticLevel::Info)
    }
}

/// Validates a COLMAP sparse reconstruction model.
///
/// Checks:
/// - Model file existence (via model_analyzer success)
/// - Registered image count
/// - Registration rate >= threshold
/// - 3D point count >= minimum
/// - Mean reprojection error < threshold
pub struct ColmapValidator;

impl ColmapValidator {
    /// Run all validation checks on a model.
    ///
    /// # Arguments
    ///
    /// * `model_info` — Parsed model statistics from model_analyzer
    /// * `total_input_images` — Total number of images fed to COLMAP
    /// * `options` — Validation thresholds
    pub fn validate(
        model_info: &ModelInfo,
        total_input_images: usize,
        options: &ValidationOptions,
    ) -> ValidationReport {
        let mut checks = Vec::new();
        let mut all_passed = true;

        // Check 1: Registered images count > 0
        let has_images = model_info.registered_images > 0;
        all_passed &= has_images;
        checks.push(ValidationCheck {
            name: "registered_images".into(),
            passed: has_images,
            detail: format!(
                "{} / {} images registered",
                model_info.registered_images, total_input_images
            ),
            severity: if has_images {
                DiagnosticLevel::Info
            } else {
                DiagnosticLevel::Critical
            },
        });

        // Check 2: Registration rate
        let rate = if total_input_images > 0 {
            model_info.registered_images as f64 / total_input_images as f64
        } else {
            0.0
        };
        let rate_ok = rate >= options.min_registration_rate;
        all_passed &= rate_ok;
        checks.push(ValidationCheck {
            name: "registration_rate".into(),
            passed: rate_ok,
            detail: format!(
                "{:.1}% registration (threshold: {:.0}%)",
                rate * 100.0,
                options.min_registration_rate * 100.0
            ),
            severity: if rate_ok {
                DiagnosticLevel::Info
            } else {
                DiagnosticLevel::Warning
            },
        });

        // Check 3: 3D point count
        let has_enough_points = model_info.point_count >= options.min_points;
        all_passed &= has_enough_points;
        checks.push(ValidationCheck {
            name: "point_count".into(),
            passed: has_enough_points,
            detail: format!(
                "{} 3D points (minimum: {})",
                model_info.point_count, options.min_points
            ),
            severity: if has_enough_points {
                DiagnosticLevel::Info
            } else {
                DiagnosticLevel::Warning
            },
        });

        // Check 4: Reprojection error
        let reproj_ok = if model_info.mean_reprojection_error > 0.0 {
            model_info.mean_reprojection_error < options.max_reprojection_error
        } else {
            true // 0.0 means unknown, skip check
        };
        all_passed &= reproj_ok;
        if model_info.mean_reprojection_error > 0.0 {
            checks.push(ValidationCheck {
                name: "reprojection_error".into(),
                passed: reproj_ok,
                detail: format!(
                    "{:.3}px mean reprojection error (max: {:.1}px)",
                    model_info.mean_reprojection_error, options.max_reprojection_error
                ),
                severity: if reproj_ok {
                    DiagnosticLevel::Info
                } else {
                    DiagnosticLevel::Warning
                },
            });
        }

        ValidationReport {
            passed: all_passed,
            model_info: model_info.clone(),
            checks,
        }
    }
}

/// Parse COLMAP `cameras.txt` and return a list of camera info entries.
///
/// File format:
/// ```text
/// # Camera list with one line of data per camera:
/// #   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]
/// # Number of cameras: 2
/// 1 PINHOLE 1920 1080 1000 1000 960 540
/// 2 SIMPLE_RADIAL 1280 720 800 640 360 -0.1
/// ```
pub fn parse_cameras_text(path: &Path) -> AppResult<Vec<CameraInfo>> {
    if !path.exists() {
        return Err(AppError::new(
            "E-3031",
            ErrorCategory::Filesystem,
            "Camera File Not Found",
            format!("The cameras file '{}' does not exist.", path.display()),
        ));
    }

    let content = std::fs::read_to_string(path).map_err(|e| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Camera File",
            format!("Could not read cameras file: {}", e),
        )
    })?;

    let mut cameras = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 4 {
            if let Ok(camera_id) = parts[0].parse::<u32>() {
                cameras.push(CameraInfo {
                    camera_id,
                    model: parts[1].to_string(),
                    width: parts[2].parse().unwrap_or(0),
                    height: parts[3].parse().unwrap_or(0),
                });
            }
        }
    }

    if cameras.is_empty() {
        return Err(AppError::new(
            "E-3033",
            ErrorCategory::Engine,
            "Empty Camera File",
            "The cameras.txt file contains no valid camera entries.",
        ));
    }

    Ok(cameras)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model_info(registered: usize, total: usize, points: usize, error: f64) -> ModelInfo {
        ModelInfo {
            cameras: 1,
            images: total,
            registered_images: registered,
            point_count: points,
            observations: points * 10,
            mean_track_length: 5.0,
            mean_reprojection_error: error,
        }
    }

    // ─── Validation ────────────────────────────────────────────────────

    #[test]
    fn test_validate_all_pass() {
        let info = sample_model_info(80, 100, 50000, 0.85);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert!(report.passed);
        assert_eq!(report.checks.len(), 4);
    }

    #[test]
    fn test_validate_low_registration_rate() {
        let info = sample_model_info(20, 100, 50000, 0.85);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert!(!report.passed);
        let rate_check = report
            .checks
            .iter()
            .find(|c| c.name == "registration_rate")
            .unwrap();
        assert!(!rate_check.passed);
    }

    #[test]
    fn test_validate_no_registered_images() {
        let info = sample_model_info(0, 100, 0, 0.0);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert!(!report.passed);
        let img_check = report
            .checks
            .iter()
            .find(|c| c.name == "registered_images")
            .unwrap();
        assert!(!img_check.passed);
        assert_eq!(img_check.severity, DiagnosticLevel::Critical);
    }

    #[test]
    fn test_validate_not_enough_points() {
        let info = sample_model_info(80, 100, 100, 0.85);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert!(!report.passed);
        let pts_check = report
            .checks
            .iter()
            .find(|c| c.name == "point_count")
            .unwrap();
        assert!(!pts_check.passed);
    }

    #[test]
    fn test_validate_high_reprojection_error() {
        let info = sample_model_info(80, 100, 50000, 5.5);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert!(!report.passed);
        let err_check = report
            .checks
            .iter()
            .find(|c| c.name == "reprojection_error")
            .unwrap();
        assert!(!err_check.passed);
    }

    #[test]
    fn test_validate_zero_input_images() {
        let info = sample_model_info(0, 0, 0, 0.0);
        let report = ColmapValidator::validate(&info, 0, &ValidationOptions::default());
        assert!(!report.passed);
        // Rate should be 0, not NaN
        let rate_check = report
            .checks
            .iter()
            .find(|c| c.name == "registration_rate")
            .unwrap();
        assert!((rate_check.detail.contains("0.0%")));
    }

    #[test]
    fn test_validate_unknown_reprojection_error_skips() {
        let info = sample_model_info(80, 100, 50000, 0.0);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        // When error is 0.0 (unknown), reprojection check should be skipped
        assert!(!report.checks.iter().any(|c| c.name == "reprojection_error"));
        assert!(report.passed);
    }

    #[test]
    fn test_report_failed_checks() {
        let info = sample_model_info(20, 100, 100, 5.5);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        let failed = report.failed_checks();
        assert!(failed.len() >= 2);
    }

    #[test]
    fn test_report_worst_level() {
        let info = sample_model_info(0, 100, 0, 0.0);
        let report = ColmapValidator::validate(&info, 100, &ValidationOptions::default());
        assert_eq!(report.worst_level(), DiagnosticLevel::Critical);
    }

    // ─── parse_cameras_text ────────────────────────────────────────────

    #[test]
    fn test_parse_cameras_text_basic() {
        let dir = std::env::temp_dir().join("splat-colmap-cameras");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cameras.txt");

        std::fs::write(
            &path,
            "# Camera list with one line of data per camera:\n\
             # Number of cameras: 2\n\
             1 PINHOLE 1920 1080 1000 960 540\n\
             2 SIMPLE_RADIAL 1280 720 800 640 360 -0.1\n",
        )
        .unwrap();

        let cameras = parse_cameras_text(&path).unwrap();
        assert_eq!(cameras.len(), 2);
        assert_eq!(cameras[0].camera_id, 1);
        assert_eq!(cameras[0].model, "PINHOLE");
        assert_eq!(cameras[0].width, 1920);
        assert_eq!(cameras[1].camera_id, 2);
        assert_eq!(cameras[1].model, "SIMPLE_RADIAL");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_cameras_text_skip_comments_and_empty() {
        let dir = std::env::temp_dir().join("splat-colmap-cameras-skip");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cameras.txt");

        std::fs::write(
            &path,
            "# Comment line\n\
             \n\
             \n\
             1 PINHOLE 640 480 500 320 240\n\
             # Another comment\n\
             2 PINHOLE 1920 1080 1000 960 540\n",
        )
        .unwrap();

        let cameras = parse_cameras_text(&path).unwrap();
        assert_eq!(cameras.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_cameras_text_not_found() {
        let result = parse_cameras_text(Path::new("/nonexistent/cameras.txt"));
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cameras_text_empty_file() {
        let dir = std::env::temp_dir().join("splat-colmap-cameras-empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cameras.txt");
        std::fs::write(&path, "# Only comments\n").unwrap();

        let result = parse_cameras_text(&path);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
