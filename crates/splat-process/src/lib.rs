//! External process runner for MetOrigin Splat.
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
pub mod platform;
pub mod runner;
pub mod scope;
pub mod sync_probe;
#[cfg(unix)]
mod unix_group;
#[cfg(windows)]
mod windows_job;

pub use command::CommandSpec;
pub use encoding::decode_process_output;
pub use event::{ProcessEvent, ProcessResult};
pub use fake::FakeProcessRunner;
pub use handle::ProcessHandle;
pub use log_writer::LogWriter;
pub use parser::{CompositeParser, PercentageParser, ProgressParser};
pub use platform::{background_command, configure_background_command};
pub use runner::{CapturedProcessResult, ProcessRunner};
pub use scope::{spawn_scoped, ProcessScope};
pub use sync_probe::{probe_output_sync, probe_output_sync_with_timeout, ProbeOutput};
