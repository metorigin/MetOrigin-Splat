use std::path::PathBuf;

/// COLMAP camera model selection.
///
/// Different camera models have different numbers of intrinsic parameters:
/// - `PINHOLE`: 4 parameters (fx, fy, cx, cy) — recommended for modern phone/camera images
/// - `SIMPLE_RADIAL`: 4 parameters (f, cx, cy, k) — good fallback with single radial distortion
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CameraModel {
    Pinhole,
    SimpleRadial,
}

impl CameraModel {
    /// Return the COLMAP CLI string for this camera model.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pinhole => "PINHOLE",
            Self::SimpleRadial => "SIMPLE_RADIAL",
        }
    }
}

/// COLMAP feature matching strategy.
///
/// Choose based on how the input images relate to each other:
/// - `Sequential`: for video frames ordered by filename — matches adjacent frames
/// - `Exhaustive`: for independent unordered photos — matches all pairs
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum MatchingStrategy {
    /// Sequential matching with configurable overlap window
    Sequential {
        /// Number of overlapping image pairs (default: 10)
        overlap: u32,
    },
    /// Exhaustive matching — match all image pairs (for <~100 images)
    Exhaustive,
}

impl MatchingStrategy {
    /// Return the COLMAP subcommand name for this strategy.
    pub fn subcommand(&self) -> &'static str {
        match self {
            Self::Sequential { .. } => "sequential_matcher",
            Self::Exhaustive => "exhaustive_matcher",
        }
    }
}

impl Default for MatchingStrategy {
    /// Default: sequential matching with overlap of 10 (suited for video frames)
    fn default() -> Self {
        Self::Sequential { overlap: 10 }
    }
}

/// Result of the feature extraction step.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FeatureExtractionResult {
    /// Number of images that were successfully processed
    pub images_processed: usize,
    /// Path to the COLMAP database
    pub database_path: PathBuf,
    /// Whether GPU was used
    pub gpu_used: bool,
}

// ─── NEW: Matching types ──────────────────────────────────────────────────

/// Result of the feature matching validation step.
#[derive(Debug, Clone)]
pub struct MatchingResult {
    /// Whether the database contains any feature matches
    pub has_matches: bool,
    /// Total number of images in the database
    pub total_images: usize,
    /// Total number of extracted keypoints
    pub total_keypoints: usize,
    /// Total number of feature matches
    pub total_matches: usize,
}

/// Statistics from a COLMAP sparse model, parsed from `model_analyzer` output.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelInfo {
    /// Number of camera models
    pub cameras: usize,
    /// Total number of images
    pub images: usize,
    /// Number of successfully registered images
    pub registered_images: usize,
    /// Number of 3D points in the reconstruction
    pub point_count: usize,
    /// Total number of 2D-3D observations
    pub observations: usize,
    /// Average track length (how many images see each point)
    pub mean_track_length: f64,
    /// Mean reprojection error in pixels
    pub mean_reprojection_error: f64,
}

impl ModelInfo {
    /// Registration rate as a fraction (0.0 – 1.0).
    pub fn registration_rate(&self) -> f64 {
        if self.images == 0 {
            return 0.0;
        }
        self.registered_images as f64 / self.images as f64
    }

    /// Whether the reconstruction quality is acceptable for training.
    ///
    /// Criteria:
    /// - Registration rate >= 50%
    /// - At least 1000 3D points
    /// - Mean reprojection error < 3.0 pixels (or unknown)
    pub fn is_acceptable(&self) -> bool {
        self.registration_rate() >= 0.5
            && self.point_count >= 1000
            && (self.mean_reprojection_error < 3.0 || self.mean_reprojection_error == 0.0)
    }
}

/// Diagnostic severity level.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Critical,
}

/// A single diagnostic message with bilingual support.
#[derive(Debug, Clone)]
pub struct DiagnosticMessage {
    pub level: DiagnosticLevel,
    pub code: String,
    pub message_en: String,
    pub message_zh: String,
    pub suggestions: Vec<String>,
}

/// Parsed camera info from cameras.txt (for deep diagnostics).
#[derive(Debug, Clone)]
pub struct CameraInfo {
    pub camera_id: u32,
    pub model: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_camera_model_pinhole() {
        assert_eq!(CameraModel::Pinhole.as_str(), "PINHOLE");
    }

    #[test]
    fn test_camera_model_simple_radial() {
        assert_eq!(CameraModel::SimpleRadial.as_str(), "SIMPLE_RADIAL");
    }

    #[test]
    fn test_matching_strategy_subcommand_sequential() {
        let s = MatchingStrategy::Sequential { overlap: 10 };
        assert_eq!(s.subcommand(), "sequential_matcher");
    }

    #[test]
    fn test_matching_strategy_subcommand_exhaustive() {
        let s = MatchingStrategy::Exhaustive;
        assert_eq!(s.subcommand(), "exhaustive_matcher");
    }

    #[test]
    fn test_matching_strategy_default() {
        let s = MatchingStrategy::default();
        match s {
            MatchingStrategy::Sequential { overlap } => assert_eq!(overlap, 10),
            _ => panic!("expected Sequential"),
        }
    }

    #[test]
    fn test_feature_extraction_result() {
        let r = FeatureExtractionResult {
            images_processed: 100,
            database_path: PathBuf::from("colmap/database.db"),
            gpu_used: true,
        };
        assert_eq!(r.images_processed, 100);
        assert!(r.gpu_used);
    }

    #[test]
    fn test_camera_model_serialization() {
        let json = serde_json::to_string(&CameraModel::Pinhole).unwrap();
        assert!(json.contains("Pinhole"));
        let deserialized: CameraModel = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, CameraModel::Pinhole);
    }

    #[test]
    fn test_matching_strategy_serialization() {
        let s = MatchingStrategy::Sequential { overlap: 15 };
        let json = serde_json::to_string(&s).unwrap();
        let deserialized: MatchingStrategy = serde_json::from_str(&json).unwrap();
        match deserialized {
            MatchingStrategy::Sequential { overlap } => assert_eq!(overlap, 15),
            _ => panic!("expected Sequential"),
        }
    }

    // ─── New tests ─────────────────────────────────────────────────────

    #[test]
    fn test_matching_result() {
        let r = MatchingResult {
            has_matches: true,
            total_images: 100,
            total_keypoints: 819200,
            total_matches: 15234,
        };
        assert!(r.has_matches);
        assert_eq!(r.total_matches, 15234);
    }

    #[test]
    fn test_model_info_registration_rate() {
        let info = ModelInfo {
            cameras: 1,
            images: 100,
            registered_images: 80,
            point_count: 50000,
            observations: 500000,
            mean_track_length: 10.0,
            mean_reprojection_error: 0.85,
        };
        assert!((info.registration_rate() - 0.8).abs() < 0.001);
        assert!(info.is_acceptable());
    }

    #[test]
    fn test_model_info_low_quality() {
        let info = ModelInfo {
            cameras: 1,
            images: 100,
            registered_images: 10,
            point_count: 100,
            observations: 500,
            mean_track_length: 2.0,
            mean_reprojection_error: 5.5,
        };
        assert!(!info.is_acceptable());
    }

    #[test]
    fn test_model_info_zero_images() {
        let info = ModelInfo {
            cameras: 0,
            images: 0,
            registered_images: 0,
            point_count: 0,
            observations: 0,
            mean_track_length: 0.0,
            mean_reprojection_error: 0.0,
        };
        assert!((info.registration_rate() - 0.0).abs() < 0.001);
        assert!(!info.is_acceptable());
    }

    #[test]
    fn test_model_info_minimum_points() {
        let info = ModelInfo {
            cameras: 1,
            images: 10,
            registered_images: 10,
            point_count: 500,
            observations: 2000,
            mean_track_length: 4.0,
            mean_reprojection_error: 0.5,
        };
        // 只有 500 个点，低于 1000 阈值
        assert!(!info.is_acceptable());
    }

    #[test]
    fn test_diagnostic_level_ordering() {
        assert!(DiagnosticLevel::Info < DiagnosticLevel::Warning);
        assert!(DiagnosticLevel::Warning < DiagnosticLevel::Critical);
    }

    #[test]
    fn test_camera_info() {
        let ci = CameraInfo {
            camera_id: 1,
            model: "PINHOLE".into(),
            width: 1920,
            height: 1080,
        };
        assert_eq!(ci.model, "PINHOLE");
    }
}
