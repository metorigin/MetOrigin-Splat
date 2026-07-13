use chrono::Utc;
use tokio::sync::broadcast;

use crate::command::CommandSpec;
use crate::event::{ProcessEvent, ProcessResult};

/// A fake process runner for testing pipeline logic without real processes.
///
/// Simulates process execution by sleeping for a configurable duration
/// and emitting fake stdout/stderr events, then returning success or failure.
///
/// # Example
///
/// ```ignore
/// let runner = FakeProcessRunner::new(true);
/// let spec = CommandSpec::new("test.exe", vec!["--do-stuff"], "test.log");
/// let result = runner.execute_fake(spec).await;
/// assert!(result.is_success());
/// ```
pub struct FakeProcessRunner {
    /// Whether the fake run should succeed
    pub should_succeed: bool,
    /// Simulated duration in milliseconds
    pub simulated_duration_ms: u64,
    event_sender: broadcast::Sender<ProcessEvent>,
}

impl FakeProcessRunner {
    /// Create a new fake process runner.
    pub fn new(should_succeed: bool) -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            should_succeed,
            simulated_duration_ms: 100,
            event_sender: sender,
        }
    }

    /// Create a fake runner with a specific simulated duration.
    pub fn with_duration(should_succeed: bool, duration_ms: u64) -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            should_succeed,
            simulated_duration_ms: duration_ms,
            event_sender: sender,
        }
    }

    /// Simulate a process execution that emits events and returns a result.
    pub async fn execute_fake(&self, spec: CommandSpec) -> ProcessResult {
        let start = std::time::Instant::now();

        // Emit started event
        let _ = self.event_sender.send(ProcessEvent::started());

        // Simulate work
        tokio::time::sleep(std::time::Duration::from_millis(self.simulated_duration_ms)).await;

        // Emit a few fake output lines
        let _ = self.event_sender.send(ProcessEvent::StdoutLine {
            line: format!("[fake] Running: {:?}", spec.program),
            timestamp: Utc::now(),
        });

        if self.should_succeed {
            let _ = self.event_sender.send(ProcessEvent::StdoutLine {
                line: "[fake] Completed successfully.".into(),
                timestamp: Utc::now(),
            });
            let _ = self.event_sender.send(ProcessEvent::exited(0));
            ProcessResult {
                exit_code: Some(0),
                cancelled: false,
                timed_out: false,
                duration_ms: start.elapsed().as_millis() as u64,
                log_path: Some(spec.log_file.to_string_lossy().to_string()),
            }
        } else {
            let _ = self.event_sender.send(ProcessEvent::StderrLine {
                line: "[fake] Simulated failure.".into(),
                timestamp: Utc::now(),
            });
            let _ = self.event_sender.send(ProcessEvent::exited(1));
            ProcessResult {
                exit_code: Some(1),
                cancelled: false,
                timed_out: false,
                duration_ms: start.elapsed().as_millis() as u64,
                log_path: Some(spec.log_file.to_string_lossy().to_string()),
            }
        }
    }

    /// Subscribe to process events.
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.event_sender.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn test_fake_runner_success() {
        let runner = FakeProcessRunner::new(true);
        let spec = CommandSpec::new("test.exe", vec!["--do-stuff"], "test.log");
        let result = runner.execute_fake(spec).await;
        assert!(result.is_success());
        assert_eq!(result.exit_code, Some(0));
    }

    #[tokio::test]
    async fn test_fake_runner_failure() {
        let runner = FakeProcessRunner::new(false);
        let spec = CommandSpec::new("test.exe", vec!["--fail"], "test.log");
        let result = runner.execute_fake(spec).await;
        assert!(!result.is_success());
        assert_eq!(result.exit_code, Some(1));
    }

    #[tokio::test]
    async fn test_fake_runner_events() {
        let runner = FakeProcessRunner::new(true);
        let mut rx = runner.subscribe();

        let spec = CommandSpec::new("test.exe", vec!["--verbose"], "test.log");
        let handle = tokio::spawn(async move { runner.execute_fake(spec).await });

        // Read events in order
        let event1 = rx.recv().await.unwrap();
        assert!(matches!(event1, ProcessEvent::Started { .. }));

        let result = handle.await.unwrap();
        assert!(result.is_success());
    }
}
