//! Pipeline orchestration for MetaOrigin Splat.
//!
//! Defines the pipeline state machine and stage execution framework.
//! Each stage is independently executable, resumable, and cacheable.
//! The orchestrator manages dependencies, retries, crash recovery,
//! and project locking.

pub mod lock;
pub mod orchestrator;
pub mod recovery;
pub mod stage;
pub mod stages;

pub use lock::{LockGuard, LockInfo, LockStatus, ProjectLock};
pub use orchestrator::{OrchestratorEvent, PipelineConfig, PipelineOrchestrator, SkeletonStage};
pub use recovery::{CrashRecovery, RecoveryAction, RecoveryActionType};
pub use stage::{PipelineStage, StageContext, StagePaths};
pub use stages::{
    BrushTrainingResult, BrushTrainingStage, ColmapFeatureStage, ColmapMappingStage,
    ColmapMatchingStage, ColmapValidationStage, ExportStage, FrameExtractionStage,
    ImagePreprocessingStage, MediaValidationStage, ModelValidationStage, PreviewGenerationStage,
    TrainingPreparationStage,
};
