//! Hardware detection and profiling for MetaOrigin Splat.
//!
//! Detects OS, CPU, GPU, memory, disk space, and engine launch capability.
//! The primary compatibility check is whether the engine self-test passes.

pub mod detector;

pub use detector::HardwareDetector;
