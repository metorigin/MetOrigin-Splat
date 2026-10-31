//! Brush training engine adapter for MetOrigin Splat.
//!
//! Detects Brush availability, validates dataset compatibility,
//! generates training configurations, launches training,
//! monitors progress, detects checkpoints, and exports PLY models.
//! All Brush interactions go through this adapter.

pub mod adapter;
pub mod checkpoint;
pub mod config;
pub mod dataset;
pub mod export;
pub mod gpu;
pub mod live_preview;
mod ply;
pub mod progress;
pub mod runtime;
pub mod training;

pub use adapter::{BrushAdapter, ProfiledTrainingRequest};
pub use checkpoint::{Checkpoint, CheckpointScanner};
pub use config::{TrainingConfig, TrainingPreset};
pub use dataset::{DatasetCheck, DatasetValidationResult, DatasetValidator};
pub use export::{ExportManager, ExportRequest, ExportResult, PlyHeaderMetadata};
pub use gpu::{require_nvidia_smi, NvidiaSmiInfo};
pub use progress::BrushProgressParser;
pub use runtime::{
    current_runtime_platform, probe_training_runtime, probe_training_runtime_with_selection,
    BrushDeviceSelection, TrainingRuntimeEvidence, VerifiedBrushRuntime,
};
pub use training::TrainingRequest;
