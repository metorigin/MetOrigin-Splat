use std::io::Write;
use std::path::{Path, PathBuf};

use crate::types::ModelInfo;
use splat_domain::error::{AppError, AppResult, ErrorCategory};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColmapAttemptStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ColmapAttemptResult {
    pub id: String,
    pub matching_strategy: String,
    pub mapper: String,
    pub status: ColmapAttemptStatus,
    pub model_path: Option<PathBuf>,
    pub model_info: Option<ModelInfo>,
    pub error: Option<String>,
}

/// Result of a COLMAP sparse reconstruction.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ColmapResult {
    /// Number of images successfully registered in the reconstruction
    pub registered_images: usize,
    /// Total number of input images
    pub total_images: usize,
    /// Number of 3D points in the sparse model
    pub point_count: usize,
    /// Path to the sparse model directory
    pub model_path: PathBuf,
    /// Total number of 2D-3D observations (from model_analyzer)
    pub observations: Option<usize>,
    /// Mean reprojection error in pixels (from model_analyzer)
    pub mean_reprojection_error: Option<f64>,
    #[serde(default)]
    pub mean_track_length: Option<f64>,
    #[serde(default)]
    pub strategy_version: u32,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub selected_attempt_id: Option<String>,
    #[serde(default)]
    pub selection_reason: Option<String>,
    #[serde(default)]
    pub attempts: Vec<ColmapAttemptResult>,
    #[serde(default)]
    pub automatic_fallbacks_exhausted: bool,
}

impl ColmapResult {
    /// Calculate the registration rate as a fraction (0.0 – 1.0).
    pub fn registration_rate(&self) -> f64 {
        if self.total_images == 0 {
            return 0.0;
        }
        self.registered_images as f64 / self.total_images as f64
    }

    /// Whether the reconstruction quality is acceptable for training.
    ///
    /// Criteria:
    /// - Registration rate >= 50%
    /// - At least one 3D point
    /// - Mean reprojection error < 3.0px (if known)
    pub fn is_acceptable(&self) -> bool {
        let mut ok = self.registration_rate() >= 0.5 && self.point_count > 0;
        if let Some(obs) = self.observations {
            ok = ok && obs > 0;
        }
        if let Some(err) = self.mean_reprojection_error {
            ok = ok && err < 3.0;
        }
        ok
    }

    /// Create a new ColmapResult with the minimal required fields.
    pub fn new(
        registered_images: usize,
        total_images: usize,
        point_count: usize,
        model_path: PathBuf,
    ) -> Self {
        Self {
            registered_images,
            total_images,
            point_count,
            model_path,
            observations: None,
            mean_reprojection_error: None,
            mean_track_length: None,
            strategy_version: 0,
            source_kind: None,
            selected_attempt_id: None,
            selection_reason: None,
            attempts: Vec::new(),
            automatic_fallbacks_exhausted: false,
        }
    }

    /// Attach observations count.
    pub fn with_observations(mut self, observations: usize) -> Self {
        self.observations = Some(observations);
        self
    }

    /// Attach mean reprojection error.
    pub fn with_error(mut self, error: f64) -> Self {
        self.mean_reprojection_error = Some(error);
        self
    }

    pub fn with_track_length(mut self, track_length: f64) -> Self {
        self.mean_track_length = Some(track_length);
        self
    }
}

pub fn read_colmap_result(path: &Path) -> AppResult<ColmapResult> {
    let json = std::fs::read_to_string(path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read COLMAP Result",
            "Could not read colmap/result.json.",
        )
        .with_technical(error.to_string())
    })?;
    serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-3030",
            ErrorCategory::Engine,
            "Invalid COLMAP Result",
            "colmap/result.json is malformed or incompatible.",
        )
        .with_technical(error.to_string())
    })
}

pub fn write_colmap_result_atomic(result: &ColmapResult, path: &Path) -> AppResult<()> {
    let temporary = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(result).map_err(|error| {
        AppError::new(
            "E-9001",
            ErrorCategory::Internal,
            "Failed to Serialize COLMAP Result",
            "Could not prepare colmap/result.json.",
        )
        .with_technical(error.to_string())
    })?;
    let mut file = std::fs::File::create(&temporary).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write COLMAP Result",
            "Could not create the temporary COLMAP result file.",
        )
        .with_technical(error.to_string())
    })?;
    file.write_all(&json).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write COLMAP Result",
            "Could not write colmap/result.json.",
        )
        .with_technical(error.to_string())
    })?;
    file.sync_all().map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Flush COLMAP Result",
            "Could not finish writing colmap/result.json.",
        )
        .with_technical(error.to_string())
    })?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Save COLMAP Result",
            "Could not move colmap/result.json into place.",
        )
        .with_technical(error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registration_rate() {
        let result = ColmapResult::new(80, 100, 5000, PathBuf::from("/model"));
        assert!((result.registration_rate() - 0.8).abs() < 1e-6);
        assert!(result.is_acceptable());
    }

    #[test]
    fn test_low_registration() {
        let result = ColmapResult::new(10, 100, 100, PathBuf::from("/model"));
        assert!(!result.is_acceptable());
    }

    #[test]
    fn test_zero_images() {
        let result = ColmapResult::new(0, 0, 0, PathBuf::from("/model"));
        assert!((result.registration_rate() - 0.0).abs() < 1e-6);
        assert!(!result.is_acceptable());
    }

    #[test]
    fn test_high_reprojection_error() {
        let result = ColmapResult::new(80, 100, 50000, PathBuf::from("/model"))
            .with_observations(500000)
            .with_error(4.5);
        assert!(!result.is_acceptable());
    }

    #[test]
    fn test_full_result() {
        let result = ColmapResult::new(80, 100, 50000, PathBuf::from("/model"))
            .with_observations(500000)
            .with_error(0.85);
        assert!(result.is_acceptable());
        assert_eq!(result.observations, Some(500000));
        assert!((result.mean_reprojection_error.unwrap() - 0.85).abs() < 0.01);
    }

    #[test]
    fn test_serialization_backward_compatible() {
        // Old format (without optional fields) should still deserialize
        let old_json = r#"{
            "registered_images": 80,
            "total_images": 100,
            "point_count": 5000,
            "model_path": "/model"
        }"#;
        let result: ColmapResult = serde_json::from_str(old_json).unwrap();
        assert_eq!(result.registered_images, 80);
        assert!(result.observations.is_none());
        assert!(result.mean_reprojection_error.is_none());
    }
}
