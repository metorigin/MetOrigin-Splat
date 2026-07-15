//! Core domain types for MetOrigin Splat.
//!
//! This crate defines the fundamental data structures used throughout the
//! application: projects, pipelines, stages, errors, hardware profiles,
//! and engine information. These types have no UI or engine-specific
//! dependencies and must be serializable.

pub mod error;
pub mod hardware;
pub mod pipeline;
pub mod progress;
pub mod project;

pub use error::{AppError, AppErrorData, AppResult, ErrorCategory};
pub use hardware::{EngineInfo, EnginePaths, GpuDevice, HardwareProfile};
pub use pipeline::{PipelineStageId, PipelineState, StageState, StageStatus};
pub use progress::TaskProgress;
pub use project::{Project, ProjectId, ProjectSettings, ProjectSource, ProjectStatus};
