//! Hardware detection and profiling for MetaOrigin Splat.
//!
//! Detects OS, CPU, GPU, memory, disk space, and engine launch capability.
//! The primary compatibility check is whether the engine self-test passes.

pub mod detector;
pub mod locator;

pub use detector::HardwareDetector;
pub use locator::EngineLocator;
