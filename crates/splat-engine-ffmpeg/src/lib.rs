//! FFmpeg engine adapter for MetaOrigin Splat.
//!
//! Detects FFmpeg availability, reads video metadata via FFprobe,
//! calculates frame extraction parameters, executes extraction,
//! and validates output frames. All FFmpeg interactions go through
//! this adapter — never directly in business logic.

pub mod adapter;
pub mod manifest;
pub mod plan;
pub mod probe;
pub mod progress;

pub use adapter::FfmpegAdapter;
pub use manifest::{FrameEntry, FrameManifest};
pub use plan::{plan_extraction, ExtractionPlan, FrameExtractionPreset, Preset};
pub use probe::{probe_video, VideoMetadata};
pub use progress::FfmpegFrameParser;
