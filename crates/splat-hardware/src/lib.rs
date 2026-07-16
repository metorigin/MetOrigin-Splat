//! Hardware detection and profiling for MetOrigin Splat.
//!
//! Detects OS, CPU, GPU, memory, disk space, and engine launch capability.
//! The primary compatibility check is whether the engine self-test passes.

pub mod detector;
pub mod locator;
pub mod manifest;

pub use detector::HardwareDetector;
pub use locator::{
    EngineIntegrityCacheOptions, EngineLocator, EngineLocatorOptions, EngineResolution,
    EngineResolutionMode,
};
pub use manifest::{
    version_matches, EnginePackEngine, EnginePackError, EnginePackFile, EnginePackManifest,
    EnginePackSource, EnginePackStatus, IntegrityStatus,
};
