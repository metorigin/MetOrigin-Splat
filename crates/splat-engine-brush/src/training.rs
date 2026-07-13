use std::path::PathBuf;

/// Parameters for a Brush training run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrainingRequest {
    /// Path to the dataset (COLMAP output)
    pub dataset_path: PathBuf,
    /// Path to the output directory
    pub output_path: PathBuf,
    /// Number of training iterations
    pub iterations: u32,
    /// Quality level ("preview", "balanced", "quality")
    pub quality: String,
    /// Path to the checkpoint to resume from (optional)
    pub resume_from: Option<PathBuf>,
}

impl TrainingRequest {
    /// Create a new training request with default parameters.
    pub fn new(dataset_path: PathBuf, output_path: PathBuf) -> Self {
        Self {
            dataset_path,
            output_path,
            iterations: 7000,
            quality: "balanced".into(),
            resume_from: None,
        }
    }

    /// Set the number of training iterations.
    pub fn with_iterations(mut self, iterations: u32) -> Self {
        self.iterations = iterations;
        self
    }

    /// Set the quality level.
    pub fn with_quality(mut self, quality: impl Into<String>) -> Self {
        self.quality = quality.into();
        self
    }

    /// Set a checkpoint to resume from.
    pub fn with_resume(mut self, checkpoint: PathBuf) -> Self {
        self.resume_from = Some(checkpoint);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_training_request_defaults() {
        let req = TrainingRequest::new(PathBuf::from("colmap/sparse"), PathBuf::from("training"));
        assert_eq!(req.iterations, 7000);
        assert_eq!(req.quality, "balanced");
        assert!(req.resume_from.is_none());
    }

    #[test]
    fn test_training_request_custom() {
        let req = TrainingRequest::new(PathBuf::from("colmap/sparse"), PathBuf::from("training"))
            .with_iterations(30000)
            .with_quality("quality");

        assert_eq!(req.iterations, 30000);
        assert_eq!(req.quality, "quality");
    }
}
