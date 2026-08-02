use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

use crate::database::MatchGraphStats;
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
    pub min_registered_images: usize,
    pub min_track_length: f64,
    pub min_component_coverage: f64,
    pub max_video_missing_segment_rate: f64,
    pub hard_min_registered_images: usize,
    pub hard_min_points: usize,
    pub hard_max_reprojection_error: f64,
}

impl Default for ValidationOptions {
    fn default() -> Self {
        Self {
            min_registration_rate: 0.5,
            max_reprojection_error: 3.0,
            min_points: 1000,
            min_registered_images: 20,
            min_track_length: 2.5,
            min_component_coverage: 0.8,
            max_video_missing_segment_rate: 0.2,
            hard_min_registered_images: 3,
            hard_min_points: 100,
            hard_max_reprojection_error: 8.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityDecision {
    Pass,
    RequiresConfirmation,
    #[default]
    Blocked,
    AcceptedWithWarning,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct RegistrationSegment {
    pub registered: bool,
    pub start_index: usize,
    pub end_index: usize,
    pub start_name: String,
    pub end_name: String,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct ValidationContext {
    pub model_complete: bool,
    pub missing_model_images: Vec<String>,
    pub graph: MatchGraphStats,
    pub ordered_input_names: Vec<String>,
    pub registered_names: Vec<String>,
    pub is_video: bool,
    pub automatic_fallbacks_exhausted: bool,
    pub accepted_for_current_model: bool,
    pub model_hash: Option<String>,
}

/// Result of a single validation check.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ValidationReport {
    /// Whether all critical checks passed
    pub passed: bool,
    #[serde(default)]
    pub decision: QualityDecision,
    /// The model info that was validated
    pub model_info: ModelInfo,
    /// Individual check results
    pub checks: Vec<ValidationCheck>,
    #[serde(default)]
    pub largest_component_images: usize,
    #[serde(default)]
    pub largest_component_coverage: f64,
    #[serde(default)]
    pub registration_segments: Vec<RegistrationSegment>,
    #[serde(default)]
    pub largest_missing_segment: usize,
    #[serde(default)]
    pub automatic_fallbacks_exhausted: bool,
    #[serde(default)]
    pub missing_model_images: Vec<String>,
    #[serde(default)]
    pub model_hash: Option<String>,
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
        Self::validate_detailed(
            model_info,
            total_input_images,
            options,
            &ValidationContext {
                model_complete: true,
                missing_model_images: Vec::new(),
                graph: MatchGraphStats {
                    total_images: total_input_images,
                    verified_edges: total_input_images.saturating_sub(1),
                    largest_component_images: total_input_images,
                    largest_component_coverage: if total_input_images > 0 { 1.0 } else { 0.0 },
                },
                ordered_input_names: Vec::new(),
                registered_names: Vec::new(),
                is_video: false,
                automatic_fallbacks_exhausted: true,
                accepted_for_current_model: false,
                model_hash: None,
            },
        )
    }

    pub fn validate_detailed(
        model_info: &ModelInfo,
        total_input_images: usize,
        options: &ValidationOptions,
        context: &ValidationContext,
    ) -> ValidationReport {
        let rate = if total_input_images > 0 {
            model_info.registered_images as f64 / total_input_images as f64
        } else {
            0.0
        };
        let segments =
            registration_segments(&context.ordered_input_names, &context.registered_names);
        let largest_missing_segment = segments
            .iter()
            .filter(|segment| !segment.registered)
            .map(|segment| segment.count)
            .max()
            .unwrap_or(0);
        let missing_rate = if total_input_images > 0 {
            largest_missing_segment as f64 / total_input_images as f64
        } else {
            1.0
        };
        let mut checks = Vec::new();
        let mut hard_passed = true;
        let mut recommended_passed = true;

        push_check(
            &mut checks,
            "model_complete",
            context.model_complete,
            "Sparse model contains cameras, images, and points3D".into(),
            true,
        );
        hard_passed &= context.model_complete;
        let references_ok = context.missing_model_images.is_empty();
        push_check(
            &mut checks,
            "model_image_references",
            references_ok,
            if references_ok {
                "Every registered model image exists in the reconstruction image set".into()
            } else {
                format!(
                    "{} registered model images are missing: {}",
                    context.missing_model_images.len(),
                    context
                        .missing_model_images
                        .iter()
                        .take(5)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            },
            true,
        );
        hard_passed &= references_ok;

        let hard_images = model_info.registered_images >= options.hard_min_registered_images;
        push_check(
            &mut checks,
            "hard_registered_images",
            hard_images,
            format!(
                "{} / {} images registered (hard minimum: {})",
                model_info.registered_images,
                total_input_images,
                options.hard_min_registered_images
            ),
            true,
        );
        hard_passed &= hard_images;
        let hard_points = model_info.point_count >= options.hard_min_points;
        push_check(
            &mut checks,
            "hard_point_count",
            hard_points,
            format!(
                "{} 3D points (hard minimum: {})",
                model_info.point_count, options.hard_min_points
            ),
            true,
        );
        hard_passed &= hard_points;
        let hard_reprojection = model_info.mean_reprojection_error == 0.0
            || model_info.mean_reprojection_error <= options.hard_max_reprojection_error;
        push_check(
            &mut checks,
            "hard_reprojection_error",
            hard_reprojection,
            format!(
                "{:.3}px mean reprojection error (hard maximum: {:.1}px)",
                model_info.mean_reprojection_error, options.hard_max_reprojection_error
            ),
            true,
        );
        hard_passed &= hard_reprojection;

        let recommended_images =
            model_info.registered_images >= total_input_images.min(options.min_registered_images);
        push_check(
            &mut checks,
            "registered_images",
            recommended_images,
            format!(
                "{} / {} images registered (recommended minimum: {})",
                model_info.registered_images,
                total_input_images,
                total_input_images.min(options.min_registered_images)
            ),
            false,
        );
        recommended_passed &= recommended_images;
        let rate_ok = rate >= options.min_registration_rate;
        push_check(
            &mut checks,
            "registration_rate",
            rate_ok,
            format!(
                "{:.1}% registration (recommended: {:.0}%)",
                rate * 100.0,
                options.min_registration_rate * 100.0
            ),
            false,
        );
        recommended_passed &= rate_ok;
        let points_ok = model_info.point_count >= options.min_points;
        push_check(
            &mut checks,
            "point_count",
            points_ok,
            format!(
                "{} 3D points (recommended: {})",
                model_info.point_count, options.min_points
            ),
            false,
        );
        recommended_passed &= points_ok;
        let track_ok = model_info.mean_track_length >= options.min_track_length;
        push_check(
            &mut checks,
            "mean_track_length",
            track_ok,
            format!(
                "{:.3} mean track length (recommended: {:.1})",
                model_info.mean_track_length, options.min_track_length
            ),
            false,
        );
        recommended_passed &= track_ok;
        let reprojection_ok = model_info.mean_reprojection_error > 0.0
            && model_info.mean_reprojection_error <= options.max_reprojection_error;
        push_check(
            &mut checks,
            "reprojection_error",
            reprojection_ok,
            format!(
                "{:.3}px mean reprojection error (recommended maximum: {:.1}px)",
                model_info.mean_reprojection_error, options.max_reprojection_error
            ),
            false,
        );
        recommended_passed &= reprojection_ok;
        let component_ok =
            context.graph.largest_component_coverage >= options.min_component_coverage;
        push_check(
            &mut checks,
            "largest_match_component",
            component_ok,
            format!(
                "{} / {} images in the largest verified match component ({:.1}%, recommended: {:.0}%)",
                context.graph.largest_component_images,
                context.graph.total_images,
                context.graph.largest_component_coverage * 100.0,
                options.min_component_coverage * 100.0
            ),
            false,
        );
        recommended_passed &= component_ok;
        if context.is_video {
            let continuity_ok = missing_rate <= options.max_video_missing_segment_rate;
            push_check(
                &mut checks,
                "video_missing_segment",
                continuity_ok,
                format!(
                    "Largest unregistered run: {} images ({:.1}%, recommended maximum: {:.0}%)",
                    largest_missing_segment,
                    missing_rate * 100.0,
                    options.max_video_missing_segment_rate * 100.0
                ),
                false,
            );
            recommended_passed &= continuity_ok;
        }

        let decision = if !hard_passed {
            QualityDecision::Blocked
        } else if recommended_passed {
            QualityDecision::Pass
        } else if context.accepted_for_current_model {
            QualityDecision::AcceptedWithWarning
        } else {
            QualityDecision::RequiresConfirmation
        };
        ValidationReport {
            passed: matches!(
                decision,
                QualityDecision::Pass | QualityDecision::AcceptedWithWarning
            ),
            decision,
            model_info: model_info.clone(),
            checks,
            largest_component_images: context.graph.largest_component_images,
            largest_component_coverage: context.graph.largest_component_coverage,
            registration_segments: segments,
            largest_missing_segment,
            automatic_fallbacks_exhausted: context.automatic_fallbacks_exhausted,
            missing_model_images: context.missing_model_images.clone(),
            model_hash: context.model_hash.clone(),
        }
    }
}

fn push_check(
    checks: &mut Vec<ValidationCheck>,
    name: &str,
    passed: bool,
    detail: String,
    blocking: bool,
) {
    checks.push(ValidationCheck {
        name: name.into(),
        passed,
        detail,
        severity: if passed {
            DiagnosticLevel::Info
        } else if blocking {
            DiagnosticLevel::Critical
        } else {
            DiagnosticLevel::Warning
        },
    });
}

fn registration_segments(
    ordered_input_names: &[String],
    registered_names: &[String],
) -> Vec<RegistrationSegment> {
    if ordered_input_names.is_empty() {
        return Vec::new();
    }
    let registered = registered_names
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut current = registered.contains(ordered_input_names[0].as_str());
    for index in 1..ordered_input_names.len() {
        let value = registered.contains(ordered_input_names[index].as_str());
        if value != current {
            segments.push(make_segment(ordered_input_names, start, index - 1, current));
            start = index;
            current = value;
        }
    }
    segments.push(make_segment(
        ordered_input_names,
        start,
        ordered_input_names.len() - 1,
        current,
    ));
    segments
}

fn make_segment(
    names: &[String],
    start: usize,
    end: usize,
    registered: bool,
) -> RegistrationSegment {
    RegistrationSegment {
        registered,
        start_index: start,
        end_index: end,
        start_name: names[start].clone(),
        end_name: names[end].clone(),
        count: end - start + 1,
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
        assert!(report.checks.len() >= 10);
        assert_eq!(report.decision, QualityDecision::Pass);
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
            .find(|c| c.name == "hard_registered_images")
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
        // Unknown error is not a hard failure, but it cannot satisfy the
        // recommended quality threshold without explicit confirmation.
        assert!(report
            .checks
            .iter()
            .any(|c| c.name == "reprojection_error" && !c.passed));
        assert_eq!(report.decision, QualityDecision::RequiresConfirmation);
        assert!(!report.passed);
    }

    #[test]
    fn accepted_warning_is_distinct_from_a_normal_pass() {
        let info = sample_model_info(40, 100, 5000, 1.0);
        let report = ColmapValidator::validate_detailed(
            &info,
            100,
            &ValidationOptions::default(),
            &ValidationContext {
                model_complete: true,
                missing_model_images: Vec::new(),
                graph: MatchGraphStats {
                    total_images: 100,
                    verified_edges: 90,
                    largest_component_images: 90,
                    largest_component_coverage: 0.9,
                },
                ordered_input_names: Vec::new(),
                registered_names: Vec::new(),
                is_video: false,
                automatic_fallbacks_exhausted: true,
                accepted_for_current_model: true,
                model_hash: Some("hash".into()),
            },
        );
        assert_eq!(report.decision, QualityDecision::AcceptedWithWarning);
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
