use std::path::PathBuf;

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
