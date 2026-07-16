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
pub mod progress;
pub mod training;

pub use adapter::BrushAdapter;
pub use checkpoint::{Checkpoint, CheckpointScanner};
pub use config::{TrainingConfig, TrainingPreset};
pub use dataset::{DatasetCheck, DatasetValidationResult, DatasetValidator};
pub use export::{ExportManager, ExportRequest, ExportResult};
pub use gpu::{require_nvidia_smi, NvidiaSmiInfo};
pub use progress::BrushProgressParser;
pub use training::TrainingRequest;
