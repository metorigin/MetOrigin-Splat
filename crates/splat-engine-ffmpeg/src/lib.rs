//! FFmpeg engine adapter for MetOrigin Splat.
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
pub use manifest::{validate_frames, write_manifest_atomic, FrameEntry, FrameManifest};
pub use plan::{
    load_builtin_preset, plan_extraction, ExtractionPlan, FrameExtractionPreset, Preset,
};
pub use probe::{probe_video, probe_video_with, probe_video_with_async, VideoMetadata};
pub use progress::FfmpegFrameParser;
