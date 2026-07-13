//! External process runner for MetaOrigin Splat.
//!
//! Provides a unified interface for launching, monitoring, and cancelling
//! external processes (FFmpeg, COLMAP, Brush) with:
//!
//! - Real-time stdout/stderr streaming via broadcast channel
//! - Simultaneous log file writing with timestamps
//! - Exit code handling and crash detection
//! - Cancellation with process tree termination
//! - Timeout enforcement
//! - CJK path and encoding compatibility
//! - Extensible progress parsing

pub mod command;
pub mod encoding;
pub mod event;
pub mod fake;
pub mod handle;
pub mod log_writer;
pub mod parser;
pub mod runner;

pub use command::CommandSpec;
pub use encoding::decode_process_output;
pub use event::{ProcessEvent, ProcessResult};
pub use fake::FakeProcessRunner;
pub use handle::ProcessHandle;
pub use log_writer::LogWriter;
pub use parser::{CompositeParser, PercentageParser, ProgressParser};
pub use runner::ProcessRunner;
