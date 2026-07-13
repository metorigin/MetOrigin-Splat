use chrono::{DateTime, Utc};
use splat_domain::progress::TaskProgress;

/// Events emitted by a running process.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ProcessEvent {
    /// The process has been started
    Started {
        /// Timestamp of when the process started
        timestamp: DateTime<Utc>,
    },
    /// A line from the process stdout
    StdoutLine {
        /// The line content
        line: String,
        /// Timestamp of the output
        timestamp: DateTime<Utc>,
    },
    /// A line from the process stderr
    StderrLine {
        /// The line content
        line: String,
        /// Timestamp of the output
        timestamp: DateTime<Utc>,
    },
    /// Progress update parsed from process output
    Progress(TaskProgress),
    /// The process exited with a code
    Exited {
        /// Exit code (0 typically means success)
        code: i32,
        /// Timestamp of the exit
        timestamp: DateTime<Utc>,
    },
    /// The process was cancelled by the user
    Cancelled {
        /// Timestamp of cancellation
        timestamp: DateTime<Utc>,
    },
    /// The process timed out
    TimedOut {
        /// Timeout duration that was exceeded
        timeout_seconds: u64,
        /// Timestamp of the timeout
        timestamp: DateTime<Utc>,
    },
}

impl ProcessEvent {
    /// Create a Started event.
    pub fn started() -> Self {
        Self::Started {
            timestamp: Utc::now(),
        }
    }

    /// Create an Exited event.
    pub fn exited(code: i32) -> Self {
        Self::Exited {
            code,
            timestamp: Utc::now(),
        }
    }

    /// Create a Cancelled event.
    pub fn cancelled() -> Self {
        Self::Cancelled {
            timestamp: Utc::now(),
        }
    }
}

/// Result of a completed or failed process execution.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProcessResult {
    /// The exit code (None if cancelled/timed out)
    pub exit_code: Option<i32>,
    /// Whether the process was cancelled
    pub cancelled: bool,
    /// Whether the process timed out
    pub timed_out: bool,
    /// Duration the process ran
    pub duration_ms: u64,
    /// Path to the log file
    pub log_path: Option<String>,
}

impl ProcessResult {
    /// Whether the overall execution was successful.
    pub fn is_success(&self) -> bool {
        self.exit_code == Some(0) && !self.cancelled && !self.timed_out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_events() {
        let started = ProcessEvent::started();
        match started {
            ProcessEvent::Started { .. } => {}
            _ => panic!("expected Started variant"),
        }

        let exited = ProcessEvent::exited(0);
        match exited {
            ProcessEvent::Exited { code, .. } => assert_eq!(code, 0),
            _ => panic!("expected Exited variant"),
        }
    }

    #[test]
    fn test_process_result_success() {
        let result = ProcessResult {
            exit_code: Some(0),
            cancelled: false,
            timed_out: false,
            duration_ms: 1000,
            log_path: None,
        };
        assert!(result.is_success());
    }

    #[test]
    fn test_process_result_failure() {
        let result = ProcessResult {
            exit_code: Some(1),
            cancelled: false,
            timed_out: false,
            duration_ms: 500,
            log_path: None,
        };
        assert!(!result.is_success());
    }

    #[test]
    fn test_process_result_cancelled() {
        let result = ProcessResult {
            exit_code: None,
            cancelled: true,
            timed_out: false,
            duration_ms: 200,
            log_path: None,
        };
        assert!(!result.is_success());
    }
}
