//! Concrete pipeline stage implementations.
//!
//! Each stage maps to a [`PipelineStageId`] and implements the [`PipelineStage`]
//! trait. Stages are registered in the orchestrator and executed in order.
//!
//! Each stage handles:
//! - Input validation: checking required files and directories exist
//! - Cache detection: checking if outputs already exist to skip the stage
//! - Execution: running the actual work (may delegate to engine adapters)
//! - Output validation: checking that results are correct and complete

pub mod brush_training;
pub mod colmap_feature;
pub mod colmap_mapping;
pub mod colmap_matching;
pub mod colmap_validation;
pub mod export;
pub mod frame_extract;
pub mod image_preprocessing;
pub mod media;
pub mod model_validation;
pub mod preview_generation;
pub mod training_preparation;

pub use brush_training::BrushTrainingStage;
pub use colmap_feature::ColmapFeatureStage;
pub use colmap_mapping::ColmapMappingStage;
pub use colmap_matching::ColmapMatchingStage;
pub use colmap_validation::ColmapValidationStage;
pub use export::ExportStage;
pub use frame_extract::FrameExtractionStage;
pub use image_preprocessing::ImagePreprocessingStage;
pub use media::MediaValidationStage;
pub use model_validation::ModelValidationStage;
pub use preview_generation::PreviewGenerationStage;
pub use training_preparation::TrainingPreparationStage;
