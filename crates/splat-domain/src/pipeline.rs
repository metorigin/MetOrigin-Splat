use chrono::{DateTime, Utc};
use std::collections::HashMap;

/// Identifies a specific stage in the Gaussian Splatting pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum PipelineStageId {
    /// Validate input media files
    MediaValidation,
    /// Extract frames from video using FFmpeg
    FrameExtraction,
    /// Preprocess extracted images (resize, normalize)
    ImagePreprocessing,
    /// COLMAP feature extraction (SIFT)
    ColmapFeatureExtraction,
    /// COLMAP feature matching (sequential or exhaustive)
    ColmapMatching,
    /// COLMAP sparse reconstruction (mapping)
    ColmapMapping,
    /// Validate COLMAP output model
    ColmapValidation,
    /// Prepare data for Brush training
    TrainingPreparation,
    /// Brush Gaussian Splatting training
    BrushTraining,
    /// Validate the trained model
    ModelValidation,
    /// Generate preview assets
    PreviewGeneration,
    /// Export final output (PLY, etc.)
    Export,
}

impl PipelineStageId {
    /// Human-readable name for the stage.
    pub fn label(&self) -> &'static str {
        match self {
            Self::MediaValidation => "Media Validation",
            Self::FrameExtraction => "Frame Extraction",
            Self::ImagePreprocessing => "Image Preprocessing",
            Self::ColmapFeatureExtraction => "COLMAP Feature Extraction",
            Self::ColmapMatching => "COLMAP Matching",
            Self::ColmapMapping => "COLMAP Mapping",
            Self::ColmapValidation => "COLMAP Validation",
            Self::TrainingPreparation => "Training Preparation",
            Self::BrushTraining => "Brush Training",
            Self::ModelValidation => "Model Validation",
            Self::PreviewGeneration => "Preview Generation",
            Self::Export => "Export",
        }
    }

    /// All pipeline stages in execution order.
    pub fn all() -> &'static [PipelineStageId] {
        use PipelineStageId::*;
        &[
            MediaValidation,
            FrameExtraction,
            ImagePreprocessing,
            ColmapFeatureExtraction,
            ColmapMatching,
            ColmapMapping,
            ColmapValidation,
            TrainingPreparation,
            BrushTraining,
            ModelValidation,
            PreviewGeneration,
            Export,
        ]
    }
}

impl std::fmt::Display for PipelineStageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.label())
    }
}

/// Status of an individual pipeline stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum StageStatus {
    /// Not yet started
    Pending,
    /// Preparing inputs before execution
    Preparing,
    /// Currently executing
    Running,
    /// In the process of pausing
    Pausing,
    /// Paused (results preserved)
    Paused,
    /// In the process of cancelling
    Cancelling,
    /// Cancelled by the user
    Cancelled,
    /// Completed successfully
    Completed,
    /// Failed with an error
    Failed,
    /// Skipped (e.g. input already present)
    Skipped,
}

impl StageStatus {
    /// Whether the stage is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Cancelled | Self::Failed | Self::Skipped
        )
    }

    /// Whether the stage is currently active.
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Running | Self::Pausing | Self::Cancelling
        )
    }
}

impl std::fmt::Display for StageStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Preparing => write!(f, "preparing"),
            Self::Running => write!(f, "running"),
            Self::Pausing => write!(f, "pausing"),
            Self::Paused => write!(f, "paused"),
            Self::Cancelling => write!(f, "cancelling"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Skipped => write!(f, "skipped"),
        }
    }
}

/// State of a single pipeline stage, persisted across sessions.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StageState {
    /// Stage identifier
    pub stage_id: PipelineStageId,
    /// Current status
    pub status: StageStatus,
    /// Progress percentage (0.0 – 1.0)
    pub progress: f64,
    /// When the stage started execution
    pub started_at: Option<DateTime<Utc>>,
    /// When the stage reached a terminal state
    pub ended_at: Option<DateTime<Utc>>,
    /// Number of retry attempts so far
    pub retry_count: u32,
    /// Error message if the stage failed
    pub error: Option<String>,
    /// Path to the stage log file (relative to project root)
    pub log_path: Option<String>,
}

impl StageState {
    /// Create a new pending stage state.
    pub fn new(stage_id: PipelineStageId) -> Self {
        Self {
            stage_id,
            status: StageStatus::Pending,
            progress: 0.0,
            started_at: None,
            ended_at: None,
            retry_count: 0,
            error: None,
            log_path: None,
        }
    }
}

/// Snapshot of the full pipeline state.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineState {
    /// Map of stage ID to stage state
    pub stages: HashMap<PipelineStageId, StageState>,
    /// ID of the currently executing or last-executed stage
    pub current_stage: Option<PipelineStageId>,
    /// Overall pipeline progress (0.0 – 1.0)
    pub overall_progress: f64,
}

impl PipelineState {
    /// Create a new pipeline state with all stages in Pending status.
    pub fn new() -> Self {
        let mut stages = HashMap::new();
        for stage_id in PipelineStageId::all() {
            stages.insert(*stage_id, StageState::new(*stage_id));
        }
        Self {
            stages,
            current_stage: None,
            overall_progress: 0.0,
        }
    }
}

impl Default for PipelineState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_stage_id_all_order() {
        let all = PipelineStageId::all();
        assert_eq!(all.len(), 12);
        assert_eq!(all[0], PipelineStageId::MediaValidation);
        assert_eq!(all[11], PipelineStageId::Export);
    }

    #[test]
    fn test_pipeline_stage_id_labels() {
        let id = PipelineStageId::ColmapMapping;
        assert_eq!(id.label(), "COLMAP Mapping");
        assert_eq!(format!("{}", id), "COLMAP Mapping");
    }

    #[test]
    fn test_stage_status_terminal() {
        assert!(StageStatus::Completed.is_terminal());
        assert!(StageStatus::Failed.is_terminal());
        assert!(!StageStatus::Running.is_terminal());
        assert!(!StageStatus::Pending.is_terminal());
    }

    #[test]
    fn test_stage_status_active() {
        assert!(StageStatus::Running.is_active());
        assert!(StageStatus::Preparing.is_active());
        assert!(!StageStatus::Pending.is_active());
        assert!(!StageStatus::Completed.is_active());
    }

    #[test]
    fn test_stage_state_new() {
        let state = StageState::new(PipelineStageId::FrameExtraction);
        assert_eq!(state.status, StageStatus::Pending);
        assert_eq!(state.progress, 0.0);
        assert!(state.started_at.is_none());
        assert_eq!(state.retry_count, 0);
    }

    #[test]
    fn test_pipeline_state_new() {
        let state = PipelineState::new();
        assert_eq!(state.stages.len(), 12);
        assert!(state.current_stage.is_none());
        assert_eq!(state.overall_progress, 0.0);
    }

    #[test]
    fn test_pipeline_state_serialization() {
        let state = PipelineState::new();
        let json = serde_json::to_string(&state).unwrap();
        let deserialized: PipelineState = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.stages.len(), 12);
    }

    #[test]
    fn test_stage_status_display() {
        assert_eq!(format!("{}", StageStatus::Pending), "pending");
        assert_eq!(format!("{}", StageStatus::Running), "running");
        assert_eq!(format!("{}", StageStatus::Failed), "failed");
    }
}
