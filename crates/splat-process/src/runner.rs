use std::sync::Arc;

use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};

use crate::command::CommandSpec;
use crate::encoding::decode_process_output;
use crate::event::ProcessEvent;
use crate::handle::ProcessHandle;
use crate::log_writer::LogWriter;
use crate::parser::CompositeParser;

/// Unified process runner for all external engines.
///
/// Launches external processes (FFmpeg, COLMAP, Brush) and provides:
///
/// - Real-time stdout/stderr streaming via broadcast channel
/// - Simultaneous log file writing with timestamps
/// - Exit code handling and crash detection
/// - Cancellation with process tree termination (Windows: `taskkill /T`)
/// - Timeout enforcement
/// - CJK path and encoding compatibility
/// - Extensible progress parsing
///
/// # Example
///
/// ```no_run
/// use splat_process::{CommandSpec, ProcessRunner};
///
/// # async fn example() {
/// let runner = ProcessRunner::new();
/// let spec = CommandSpec::new(
///     "echo",
///     vec!["hello world"],
///     "logs/echo.log",
/// );
/// let mut handle = runner.execute(spec).await.unwrap();
/// // Read events from handle.events...
/// # }
/// ```
pub struct ProcessRunner {
    /// Broadcast sender for process events
    event_sender: broadcast::Sender<ProcessEvent>,
    /// Progress parsers to apply to output lines
    parser: Arc<CompositeParser>,
}

impl ProcessRunner {
    /// Create a new process runner with no progress parsers.
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            event_sender: sender,
            parser: Arc::new(CompositeParser::new()),
        }
    }

    /// Create a new process runner with the given progress parsers.
    pub fn with_parser(parser: CompositeParser) -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            event_sender: sender,
            parser: Arc::new(parser),
        }
    }

    /// Execute a command and return a handle to the running process.
    ///
    /// The returned `ProcessHandle` contains an event receiver that streams
    /// stdout/stderr lines, progress updates, and exit/error events.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] if the process cannot be spawned (e.g. program
    /// not found, permission denied, invalid working directory).
    pub async fn execute(&self, spec: CommandSpec) -> AppResult<ProcessHandle> {
        let started_at = Utc::now();

        // Convert CommandSpec to a tokio::process::Command
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(ref cwd) = spec.cwd {
            cmd.current_dir(cwd);
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        // Spawn the process
        let child = cmd.spawn().map_err(|e| {
            AppError::new(
                "E-2101",
                ErrorCategory::Engine,
                "Failed to Start Process",
                format!(
                    "Could not launch '{}': {}. Make sure the engine is installed and available in PATH.",
                    spec.program.display(),
                    e
                ),
            )
            .with_technical(format!("program: {:?}, error: {}", spec.program, e))
            .retryable(true)
        })?;

        // Create handle and event receiver
        let handle = ProcessHandle::new(child, started_at, self.event_sender.subscribe());
        let child_arc = handle.child.clone();

        // Send Started event
        let _ = self.event_sender.send(ProcessEvent::started());

        // Spawn background task to read streams and manage lifecycle
        let event_tx = self.event_sender.clone();
        let parser = self.parser.clone();
        let timeout = spec.timeout;
        let log_path = spec.log_file;
        let process_id = handle.process_id;

        tokio::spawn(async move {
            run_process(child_arc, event_tx, log_path, parser, timeout, process_id).await;
        });

        Ok(handle)
    }

    /// Cancel a running process.
    ///
    /// On Windows, uses `taskkill /T /F` to terminate the entire process tree.
    /// On Unix, sends SIGTERM/SIGKILL to the process.
    pub async fn cancel(&self, handle: &mut ProcessHandle) -> AppResult<()> {
        let pid = handle.process_id;
        let child = handle.child.clone();

        // Send Cancelled event
        let _ = self.event_sender.send(ProcessEvent::cancelled());

        // Kill the process using platform-specific strategy
        let kill_result = kill_process_tree(pid).await;

        if let Err(e) = kill_result {
            tracing::warn!(
                "Process tree kill failed (pid={}): {}, trying direct kill",
                pid,
                e
            );
            let mut guard = child.lock().await;
            let _ = guard.start_kill();
        }

        // Wait for the process to actually exit
        {
            let mut guard = child.lock().await;
            let _ = guard.wait().await;
        }

        tracing::info!("Process cancelled: pid={}", pid);
        Ok(())
    }

    /// Subscribe to process events broadcast channel.
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.event_sender.subscribe()
    }
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Background lifecycle task ────────────────────────────────────────────

async fn run_process(
    child: Arc<Mutex<tokio::process::Child>>,
    event_tx: broadcast::Sender<ProcessEvent>,
    log_path: std::path::PathBuf,
    parser: Arc<CompositeParser>,
    timeout: Option<std::time::Duration>,
    process_id: u32,
) {
    let start = std::time::Instant::now();

    // Open the log file
    let log_writer = LogWriter::create(log_path.clone()).ok();
    let log_writer = Arc::new(Mutex::new(log_writer));

    // Take ownership of stdout/stderr pipes
    let mut guard = child.lock().await;
    let stdout = guard.stdout.take();
    let stderr = guard.stderr.take();
    drop(guard);

    // Spawn concurrent stdout/stderr readers
    let stdout_task = if let Some(stdout) = stdout {
        let tx = event_tx.clone();
        let log = log_writer.clone();
        let p = parser.clone();
        tokio::spawn(async move {
            read_stream(BufReader::new(stdout), tx, log, p, "stdout").await;
        })
    } else {
        return;
    };

    let stderr_task = if let Some(stderr) = stderr {
        let tx = event_tx.clone();
        let log = log_writer.clone();
        tokio::spawn(async move {
            read_stream(
                BufReader::new(stderr),
                tx,
                log,
                Arc::new(CompositeParser::new()),
                "stderr",
            )
            .await;
        })
    } else {
        return;
    };

    // Poll when a timeout is configured so cancellation never leaves a
    // `Child::wait` future holding the child mutex on Windows.
    let wait_result = if let Some(dur) = timeout {
        let deadline = tokio::time::Instant::now() + dur;
        loop {
            let status = {
                let mut guard = child.lock().await;
                guard.try_wait()
            };
            match status {
                Ok(Some(status)) => break Some(Ok(status)),
                Err(error) => break Some(Err(error)),
                Ok(None) if tokio::time::Instant::now() >= deadline => break None,
                Ok(None) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
        }
    } else {
        let mut guard = child.lock().await;
        Some(guard.wait().await)
    };

    // A timed-out process must be terminated before waiting for EOF from its pipes.
    if wait_result.is_none() {
        if let Err(error) = kill_process_tree(process_id).await {
            tracing::warn!(
                "Timed-out process tree kill failed (pid={}): {}",
                process_id,
                error
            );
            let mut guard = child.lock().await;
            let _ = guard.start_kill();
        }

        let mut guard = child.lock().await;
        let _ = guard.wait().await;
    }

    // Wait for stream readers to finish after the child has exited.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Determine and emit the final result
    match wait_result {
        Some(Ok(status)) => {
            let code = status.code().unwrap_or(-1);
            // Write separator to log
            {
                let mut log = log_writer.lock().await;
                if let Some(ref mut w) = *log {
                    let _ = w.write_separator(&format!("Process exited with code {}", code));
                    let _ = w.close();
                }
            }
            let _ = event_tx.send(ProcessEvent::exited(code));
            tracing::debug!(
                "Process completed, exit_code={}, duration_ms={}",
                code,
                elapsed_ms
            );
        }
        Some(Err(e)) => {
            tracing::error!("Process wait error: {}", e);
            let _ = event_tx.send(ProcessEvent::exited(-1));
        }
        None => {
            // Timeout elapsed
            {
                let mut log = log_writer.lock().await;
                if let Some(ref mut w) = *log {
                    let _ = w.write_separator("Process timed out");
                    let _ = w.close();
                }
            }
            let _ = event_tx.send(ProcessEvent::TimedOut {
                timeout_seconds: timeout.map(|d| d.as_secs()).unwrap_or(0),
                timestamp: Utc::now(),
            });
            tracing::warn!(
                "Process timed out, timeout_secs={}",
                timeout.map(|d| d.as_secs()).unwrap_or(0)
            );
        }
    }
}

// ─── Stream reader ────────────────────────────────────────────────────────

async fn read_stream<R>(
    mut reader: R,
    event_tx: broadcast::Sender<ProcessEvent>,
    log_writer: Arc<Mutex<Option<LogWriter>>>,
    parser: Arc<CompositeParser>,
    stream_name: &'static str,
) where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut buf = Vec::<u8>::new();
    loop {
        buf.clear();
        // Read until newline as raw bytes (handles non-UTF-8 encodings)
        let n = reader.read_until(b'\n', &mut buf).await;
        match n {
            Ok(0) => break, // EOF
            Ok(_) => {
                // Decode the raw bytes using proper encoding detection
                let decoded = decode_process_output(&buf);
                let trimmed = decoded.trim_end_matches(&['\r', '\n'][..]);
                if trimmed.is_empty() {
                    continue;
                }

                // Write to log file
                {
                    let mut log = log_writer.lock().await;
                    if let Some(ref mut w) = *log {
                        let _ = w.write_line(stream_name, trimmed);
                    }
                }

                // Try to parse progress
                if !parser.is_empty() {
                    if let Some(progress) = parser.parse(trimmed) {
                        let _ = event_tx.send(ProcessEvent::Progress(progress));
                    }
                }

                // Send as output event
                let event = if stream_name == "stderr" {
                    ProcessEvent::StderrLine {
                        line: trimmed.to_string(),
                        timestamp: Utc::now(),
                    }
                } else {
                    ProcessEvent::StdoutLine {
                        line: trimmed.to_string(),
                        timestamp: Utc::now(),
                    }
                };
                if event_tx.receiver_count() > 0 {
                    let _ = event_tx.send(event);
                }
            }
            Err(e) => {
                tracing::warn!("Error reading {} stream: {}", stream_name, e);
                break;
            }
        }
    }
}

// ─── Platform-specific process termination ───────────────────────────────

/// Terminate a process tree by PID.
async fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output()
            .await
            .map_err(|e| format!("taskkill error: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("taskkill returned non-zero: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Send SIGTERM to the process group
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .await;

        // Give it a moment, then SIGKILL if still alive
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let output = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output()
            .await
            .map_err(|e| format!("kill error: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            // Process might already be dead
            tracing::debug!("kill -KILL returned non-zero, process may have already exited");
            Ok(())
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_log_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("splat-process-test-{}.log", name))
    }

    #[tokio::test]
    async fn test_echo_success() {
        let runner = ProcessRunner::new();
        let spec = CommandSpec::new(
            if cfg!(target_os = "windows") {
                "cmd.exe"
            } else {
                "echo"
            },
            if cfg!(target_os = "windows") {
                vec!["/C", "echo hello"]
            } else {
                vec!["hello"]
            },
            test_log_path("echo"),
        );

        let mut handle = runner.execute(spec).await.unwrap();
        assert!(handle.process_id > 0);

        // Collect events for up to 5 seconds
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut has_started = false;
        let mut has_exited = false;

        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            while let Ok(event) = handle.events.try_recv() {
                match &event {
                    ProcessEvent::Started { .. } => has_started = true,
                    ProcessEvent::StdoutLine { line, .. } => {
                        tracing::debug!("STDOUT: {}", line);
                    }
                    ProcessEvent::Exited { code, .. } => {
                        has_exited = true;
                        tracing::debug!("EXITED: {}", code);
                    }
                    _ => {}
                }
            }
            if has_started && has_exited {
                break;
            }
        }
        assert!(has_started, "should have received Started event within 5s");
        assert!(has_exited, "should have received Exited event within 5s");

        assert!(has_started, "should have received Started event");
        assert!(has_exited, "should have received Exited event");
    }

    #[tokio::test]
    async fn test_error_on_nonexistent_command() {
        let runner = ProcessRunner::new();
        let spec = CommandSpec::new(
            "nonexistent-command-12345-test",
            Vec::<String>::new(),
            test_log_path("nonexistent"),
        );

        let result = runner.execute(spec).await;
        assert!(result.is_err(), "should fail on nonexistent command");

        if let Err(e) = result {
            assert_eq!(e.category, ErrorCategory::Engine);
        }
    }

    #[tokio::test]
    async fn test_exit_code_propagation() {
        let runner = ProcessRunner::new();

        // Use a command that exits with a specific code
        let (cmd, args) = if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C", "exit 42"])
        } else {
            ("sh", vec!["-c", "exit 42"])
        };

        let spec = CommandSpec::new(cmd, args, test_log_path("exit42"));
        let mut handle = runner.execute(spec).await.unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            while let Ok(event) = handle.events.try_recv() {
                if let ProcessEvent::Exited { code, .. } = event {
                    // Note: on Unix, exit code 42 is propagated as-is.
                    // On Windows, cmd may wrap it differently.
                    assert!(code == 42 || cfg!(target_os = "windows"));
                    return;
                }
            }
        }
        panic!("Did not receive Exited event within 5 second timeout");
    }

    #[tokio::test]
    async fn test_cancel_running_process() {
        let runner = ProcessRunner::new();

        let (cmd, args) = if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C", "timeout /t 60 /nobreak > nul"])
        } else {
            ("sleep", vec!["60"])
        };

        let spec = CommandSpec::new(cmd, args, test_log_path("cancel"));
        let mut handle = runner.execute(spec).await.unwrap();

        // Give it a moment to start
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Cancel the process
        let result = runner.cancel(&mut handle).await;
        assert!(result.is_ok(), "cancel should succeed: {:?}", result);

        // Verify we got a Cancelled event (with 5 second timeout)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            while let Ok(event) = handle.events.try_recv() {
                if matches!(event, ProcessEvent::Cancelled { .. }) {
                    return;
                }
            }
        }
        panic!("Did not receive Cancelled event within 5 second timeout");
    }

    #[tokio::test]
    async fn test_timeout_terminates_process() {
        let runner = ProcessRunner::new();
        let (cmd, args) = if cfg!(target_os = "windows") {
            ("ping.exe", vec!["-n", "10", "127.0.0.1"])
        } else {
            ("sleep", vec!["10"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("timeout"))
            .with_timeout(std::time::Duration::from_millis(100));
        let mut handle = runner.execute(spec).await.unwrap();

        let timed_out = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if matches!(
                    handle.events.recv().await,
                    Ok(ProcessEvent::TimedOut { .. })
                ) {
                    break;
                }
            }
        })
        .await;
        assert!(timed_out.is_ok(), "should emit a timeout event");

        let mut child = handle.child.lock().await;
        assert!(
            child.try_wait().unwrap().is_some(),
            "timed-out process must be terminated"
        );
    }
}
