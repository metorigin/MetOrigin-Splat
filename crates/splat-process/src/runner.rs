use std::sync::Arc;

use chrono::Utc;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::progress::TaskProgress;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};
use tokio_util::sync::CancellationToken;

use crate::command::CommandSpec;
use crate::encoding::decode_process_output;
use crate::event::{ProcessEvent, ProcessResult};
use crate::handle::ProcessHandle;
use crate::log_writer::LogWriter;
use crate::parser::CompositeParser;
use crate::platform::configure_background_command;

#[derive(Debug, Clone)]
pub struct CapturedProcessResult {
    pub process: ProcessResult,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Unified process runner for all external engines.
///
/// Launches external processes (FFmpeg, COLMAP, Brush) and provides:
///
/// - Real-time stdout/stderr streaming via broadcast channel
/// - Simultaneous log file writing with timestamps
/// - Exit code handling and crash detection
/// - Cancellation with process tree termination (Windows: an owned job object)
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
        configure_background_command(cmd.as_std_mut());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
            cmd.kill_on_drop(true);
        }
        cmd.args(&spec.args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(ref cwd) = spec.cwd {
            cmd.current_dir(cwd);
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        #[cfg(windows)]
        let windows_job = {
            use std::os::windows::process::CommandExt;
            cmd.as_std_mut()
                .creation_flags(crate::windows_job::OWNED_CREATION_FLAGS);
            cmd.kill_on_drop(true);
            Arc::new(crate::windows_job::WindowsJob::new().map_err(|error| {
                process_cleanup_error(format!(
                    "Cannot create an owned Windows engine job: {error}"
                ))
            })?)
        };

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

        #[cfg(windows)]
        let mut child = child;
        #[cfg(windows)]
        if let Err(error) = windows_job.assign_and_resume(&child) {
            // The child has not run outside its job. Dropping either object also
            // kills it, including if this bounded reaping await is cancelled.
            let _ = child.start_kill();
            let reaped =
                tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
            return Err(process_cleanup_error(format!(
                "Windows engine ownership could not be established: {error}; reap={reaped:?}"
            )));
        }

        // Create handle and event receiver
        let handle = ProcessHandle::new(
            child,
            started_at,
            self.event_sender.subscribe(),
            #[cfg(windows)]
            windows_job,
        );
        let child_arc = handle.child.clone();

        // Send Started event
        let _ = self.event_sender.send(ProcessEvent::started());

        // Spawn background task to read streams and manage lifecycle
        let event_tx = self.event_sender.clone();
        let parser = self.parser.clone();
        let timeout = spec.timeout;
        let log_path = spec.log_file;
        let process_id = handle.process_id;
        #[cfg(unix)]
        let process_group = handle.process_group.clone();
        #[cfg(unix)]
        let group_guard = process_group.lifecycle_guard();
        #[cfg(windows)]
        let windows_job = handle.windows_job.clone();

        let unscoped_guard = crate::scope::UnscopedCleanupGuard::new(&handle);
        let lifecycle = tokio::spawn(async move {
            let mut unscoped_guard = unscoped_guard;
            // Constructed before spawn: dropping a never-polled future must
            // still terminate its group when the runtime shuts down.
            #[cfg(unix)]
            let mut group_guard = group_guard;
            let result = run_process(
                child_arc,
                event_tx,
                log_path,
                parser,
                timeout,
                process_id,
                #[cfg(unix)]
                process_group,
                #[cfg(windows)]
                windows_job,
            )
            .await;
            // A normal return transfers cleanup failure to the scope receipt.
            // Keep the group identity for retry instead of best-effort dropping
            // it. Panic/abort still leaves the emergency guard armed.
            #[cfg(unix)]
            group_guard.disarm();
            if result.is_ok() {
                unscoped_guard.disarm();
            }
            result
        });

        // No await between spawn and registration: aborting the caller cannot
        // leave a child outside the current run's cleanup ownership.
        handle
            .lifecycle
            .try_lock()
            .expect("new lifecycle receipt")
            .task = Some(lifecycle);
        crate::scope::register_process(&handle);

        Ok(handle)
    }

    /// Execute a command and wait for success, failure, cancellation, or timeout.
    ///
    /// Parsed progress events from either stdout or stderr are optionally
    /// forwarded to the supplied pipeline progress channel.
    pub async fn run_to_completion(
        &self,
        spec: CommandSpec,
        cancellation: CancellationToken,
        progress_tx: Option<broadcast::Sender<TaskProgress>>,
    ) -> AppResult<ProcessResult> {
        let started = std::time::Instant::now();
        let log_path = spec.log_file.to_string_lossy().to_string();
        let mut handle = self.execute(spec).await?;

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    self.cancel_and_finish(&mut handle).await?;
                    return Ok(ProcessResult {
                        exit_code: None,
                        cancelled: true,
                        timed_out: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                        log_path: Some(log_path),
                    });
                }
                event = handle.events.recv() => {
                    match event {
                        Ok(ProcessEvent::Progress(progress)) => {
                            if let Some(sender) = &progress_tx {
                                let _ = sender.send(progress);
                            }
                        }
                        Ok(ProcessEvent::Exited { code, .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(ProcessResult {
                                exit_code: Some(code),
                                cancelled: false,
                                timed_out: false,
                                duration_ms: started.elapsed().as_millis() as u64,
                                log_path: Some(log_path),
                            });
                        }
                        Ok(ProcessEvent::Cancelled { .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(ProcessResult {
                                exit_code: None,
                                cancelled: true,
                                timed_out: false,
                                duration_ms: started.elapsed().as_millis() as u64,
                                log_path: Some(log_path),
                            });
                        }
                        Ok(ProcessEvent::TimedOut { .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(ProcessResult {
                                exit_code: None,
                                cancelled: false,
                                timed_out: true,
                                duration_ms: started.elapsed().as_millis() as u64,
                                log_path: Some(log_path),
                            });
                        }
                        Ok(ProcessEvent::Started { .. }
                            | ProcessEvent::StdoutLine { .. }
                            | ProcessEvent::StderrLine { .. }) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => {
                            self.cancel_and_finish(&mut handle).await?;
                            return Err(AppError::new(
                                "E-2103",
                                ErrorCategory::Engine,
                                "Process Monitoring Failed",
                                "The external process event stream closed before a result was reported.",
                            ));
                        }
                    }
                }
            }
        }
    }

    /// Execute a command while capturing bounded stdout/stderr. Cancellation,
    /// timeout handling and process-tree termination are identical to the
    /// streaming runner.
    pub async fn run_to_completion_capture(
        &self,
        spec: CommandSpec,
        cancellation: CancellationToken,
        max_output_bytes: usize,
    ) -> AppResult<CapturedProcessResult> {
        let started = std::time::Instant::now();
        let log_path = spec.log_file.to_string_lossy().to_string();
        let mut handle = self.execute(spec).await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    self.cancel_and_finish(&mut handle).await?;
                    return Ok(CapturedProcessResult {
                        process: ProcessResult {
                            exit_code: None,
                            cancelled: true,
                            timed_out: false,
                            duration_ms: started.elapsed().as_millis() as u64,
                            log_path: Some(log_path),
                        },
                        stdout,
                        stderr,
                    });
                }
                event = handle.events.recv() => {
                    match event {
                        Ok(ProcessEvent::StdoutLine { line, .. }) => {
                            if let Err(error) = append_captured_line(
                                &mut stdout,
                                &line,
                                max_output_bytes.saturating_sub(stderr.len()),
                            ) {
                                self.cancel_and_finish(&mut handle).await?;
                                return Err(error);
                            }
                        }
                        Ok(ProcessEvent::StderrLine { line, .. }) => {
                            if let Err(error) = append_captured_line(
                                &mut stderr,
                                &line,
                                max_output_bytes.saturating_sub(stdout.len()),
                            ) {
                                self.cancel_and_finish(&mut handle).await?;
                                return Err(error);
                            }
                        }
                        Ok(ProcessEvent::Exited { code, .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(CapturedProcessResult {
                                process: ProcessResult {
                                    exit_code: Some(code),
                                    cancelled: false,
                                    timed_out: false,
                                    duration_ms: started.elapsed().as_millis() as u64,
                                    log_path: Some(log_path),
                                },
                                stdout,
                                stderr,
                            });
                        }
                        Ok(ProcessEvent::Cancelled { .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(CapturedProcessResult {
                                process: ProcessResult {
                                    exit_code: None,
                                    cancelled: true,
                                    timed_out: false,
                                    duration_ms: started.elapsed().as_millis() as u64,
                                    log_path: Some(log_path),
                                },
                                stdout,
                                stderr,
                            });
                        }
                        Ok(ProcessEvent::TimedOut { .. }) => {
                            self.await_cleanup(&mut handle).await?;
                            return Ok(CapturedProcessResult {
                                process: ProcessResult {
                                    exit_code: None,
                                    cancelled: false,
                                    timed_out: true,
                                    duration_ms: started.elapsed().as_millis() as u64,
                                    log_path: Some(log_path),
                                },
                                stdout,
                                stderr,
                            });
                        }
                        Ok(ProcessEvent::Started { .. } | ProcessEvent::Progress(_)) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            self.cancel_and_finish(&mut handle).await?;
                            return Err(AppError::new(
                                "E-2103",
                                ErrorCategory::Engine,
                                "Captured Process Output Lagged",
                                "The process produced output faster than it could be captured safely.",
                            ));
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            self.cancel_and_finish(&mut handle).await?;
                            return Err(AppError::new(
                                "E-2103",
                                ErrorCategory::Engine,
                                "Process Monitoring Failed",
                                "The external process event stream closed before a result was reported.",
                            ));
                        }
                    }
                }
            }
        }
    }

    async fn cancel_and_finish(&self, handle: &mut ProcessHandle) -> AppResult<()> {
        let cancellation = self.cancel(handle).await;
        // Even cancellation failure must not drop standalone ownership before
        // the lifecycle has either completed or registered its failed receipt.
        self.await_cleanup(handle).await?;
        cancellation
    }

    /// Terminal events describe engine status; only this receipt proves all
    /// lifecycle cleanup completed. Retain failures for scope/shutdown retry.
    async fn await_cleanup(&self, handle: &mut ProcessHandle) -> AppResult<()> {
        let lifecycle = handle.lifecycle.clone();
        let mut receipt = lifecycle.lock().await;
        if let Some(error) = &receipt.error {
            return Err(process_cleanup_error(error.clone()));
        }
        if let Some(task) = receipt.task.as_mut() {
            let outcome = task.await;
            receipt.task = None;
            let failure = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(error) => Some(error.to_string()),
            };
            if let Some(error) = failure {
                receipt.error = Some(error.clone());
                return Err(process_cleanup_error(error));
            }
        }
        Ok(())
    }

    /// Cancel a running process.
    ///
    /// On Windows, terminates only the owned job and waits for its descendants.
    /// On Unix, sends SIGTERM then SIGKILL to the owned process group.
    pub async fn cancel(&self, handle: &mut ProcessHandle) -> AppResult<()> {
        let pid = handle.process_id;
        let child = handle.child.clone();

        // Send Cancelled event
        let _ = self.event_sender.send(ProcessEvent::cancelled());

        // Kill the process using platform-specific strategy
        #[cfg(unix)]
        let kill_result = handle.process_group.terminate(&child).await;
        #[cfg(windows)]
        let kill_result = handle.windows_job.terminate().await;
        #[cfg(not(any(unix, windows)))]
        let kill_result = kill_process_tree(pid).await;

        if let Err(ref e) = kill_result {
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
            #[cfg(any(unix, windows))]
            tokio::time::timeout(std::time::Duration::from_secs(2), guard.wait())
                .await
                .map_err(|error| process_cleanup_error(error.to_string()))?
                .map_err(|error| process_cleanup_error(error.to_string()))?;
            #[cfg(not(any(unix, windows)))]
            let _ = guard.wait().await;
        }

        #[cfg(any(unix, windows))]
        kill_result.map_err(process_cleanup_error)?;

        tracing::info!("Process cancelled: pid={}", pid);
        Ok(())
    }

    /// Subscribe to process events broadcast channel.
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.event_sender.subscribe()
    }
}

fn process_cleanup_error(error: String) -> AppError {
    AppError::new(
        "E-2104",
        ErrorCategory::Engine,
        "Process Cleanup Failed",
        "The engine process group could not be fully terminated.",
    )
    .with_technical(error)
    .with_suggestions(vec![
        "Close the application and check for remaining engine processes before retrying.",
    ])
}

fn append_captured_line(buffer: &mut Vec<u8>, line: &str, limit: usize) -> AppResult<()> {
    let required = line.len().saturating_add(1);
    if buffer.len().saturating_add(required) > limit {
        return Err(AppError::new(
            "E-2106",
            ErrorCategory::Engine,
            "Process Output Limit Exceeded",
            format!("The process produced more than {limit} bytes of captured output."),
        ));
    }
    buffer.extend_from_slice(line.as_bytes());
    buffer.push(b'\n');
    Ok(())
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
    #[cfg(unix)] process_group: Arc<crate::unix_group::ProcessGroup>,
    #[cfg(windows)] windows_job: Arc<crate::windows_job::WindowsJob>,
) -> Result<(), String> {
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
    let mut stdout_task = if let Some(stdout) = stdout {
        let tx = event_tx.clone();
        let log = log_writer.clone();
        let p = parser.clone();
        tokio::spawn(async move {
            read_stream(BufReader::new(stdout), tx, log, p, "stdout").await;
        })
    } else {
        let _ = event_tx.send(ProcessEvent::exited(-1));
        return Err("Engine stdout cleanup receipt is unavailable".into());
    };

    let mut stderr_task = if let Some(stderr) = stderr {
        let tx = event_tx.clone();
        let log = log_writer.clone();
        let p = parser.clone();
        tokio::spawn(async move {
            read_stream(BufReader::new(stderr), tx, log, p, "stderr").await;
        })
    } else {
        stdout_task.abort();
        let _ = stdout_task.await;
        let _ = event_tx.send(ProcessEvent::exited(-1));
        return Err("Engine stderr cleanup receipt is unavailable".into());
    };

    // Poll without holding the child mutex across an await. Cancellation may
    // need that mutex for the direct-kill fallback when process-tree killing
    // is unavailable or denied by the operating system.
    let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
    let wait_result = loop {
        let status = {
            let mut guard = child.lock().await;
            guard.try_wait()
        };
        match status {
            Ok(Some(status)) => break Some(Ok(status)),
            Err(error) => break Some(Err(error)),
            Ok(None)
                if deadline
                    .map(|deadline| tokio::time::Instant::now() >= deadline)
                    .unwrap_or(false) =>
            {
                break None;
            }
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
        }
    };

    // On Unix, even a successfully exited leader can leave descendants holding
    // its pipes or writing outputs. Clean up before waiting for stream EOF.
    #[cfg(unix)]
    let mut cleanup_failed = if let Err(error) = process_group.terminate(&child).await {
        tracing::warn!(process_id, %error, "Engine process group cleanup failed");
        let mut guard = child.lock().await;
        if let Err(error) = guard.start_kill() {
            tracing::warn!(process_id, %error, "Direct process cleanup also failed");
        }
        true
    } else {
        false
    };
    #[cfg(windows)]
    let mut cleanup_failed = if let Err(error) = windows_job.terminate().await {
        tracing::warn!(process_id, %error, "Owned Windows job cleanup failed");
        let mut guard = child.lock().await;
        if let Err(error) = guard.start_kill() {
            tracing::warn!(process_id, %error, "Direct Windows child cleanup also failed");
        }
        true
    } else {
        false
    };

    // A timed-out process must be terminated before waiting for EOF from its pipes.
    if wait_result.is_none() {
        #[cfg(not(any(unix, windows)))]
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
        #[cfg(any(unix, windows))]
        match tokio::time::timeout(std::time::Duration::from_secs(2), guard.wait()).await {
            Ok(Ok(_)) => {}
            result => {
                cleanup_failed = true;
                tracing::warn!(process_id, ?result, "Timed-out engine could not be reaped");
            }
        }
        #[cfg(not(any(unix, windows)))]
        let _ = guard.wait().await;
    }

    // Wait for stream readers to finish after the child has exited.
    #[cfg(any(unix, windows))]
    if tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let _ = tokio::join!(&mut stdout_task, &mut stderr_task);
    })
    .await
    .is_err()
    {
        stdout_task.abort();
        stderr_task.abort();
        // Do not report a joined lifecycle while aborted readers still own
        // pipes or logs. Abort is a request; joining proves their drop ran.
        let _ = tokio::join!(&mut stdout_task, &mut stderr_task);
        cleanup_failed = true;
        tracing::warn!(
            process_id,
            "Engine output pipes did not close after group cleanup"
        );
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (&mut stdout_task).await;
        let _ = (&mut stderr_task).await;
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Determine and emit the final result
    match wait_result {
        Some(Ok(status)) => {
            let code = status.code().unwrap_or(-1);
            #[cfg(any(unix, windows))]
            let code = if cleanup_failed { -1 } else { code };
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
    #[cfg(any(unix, windows))]
    if cleanup_failed {
        return Err("Engine process group or output cleanup did not finish; ownership is retained for retry".into());
    }
    Ok(())
}

// ─── Stream reader ────────────────────────────────────────────────────────

// Engines may emit malformed output without any newline. Bound each read and
// event before decoding/logging so capture limits cannot be bypassed by one
// indefinitely growing line. Oversized lines are emitted in bounded chunks.
const MAX_STREAM_LINE_BYTES: usize = 64 * 1024;

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
        let n = (&mut reader)
            .take(MAX_STREAM_LINE_BYTES as u64)
            .read_until(b'\n', &mut buf)
            .await;
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
#[cfg(not(any(unix, windows)))]
async fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("taskkill");
        configure_background_command(command.as_std_mut());
        let output = command
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
    #[tokio::test]
    async fn newline_free_output_is_read_in_bounded_chunks() {
        let payload = vec![b'x'; super::MAX_STREAM_LINE_BYTES * 3 + 17];
        let (sender, mut events) = tokio::sync::broadcast::channel(16);
        super::read_stream(
            tokio::io::BufReader::new(payload.as_slice()),
            sender,
            std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            std::sync::Arc::new(crate::CompositeParser::new()),
            "stdout",
        )
        .await;
        let mut received = Vec::new();
        while let Ok(crate::ProcessEvent::StdoutLine { line, .. }) = events.try_recv() {
            assert!(line.len() <= super::MAX_STREAM_LINE_BYTES);
            received.extend_from_slice(line.as_bytes());
        }
        assert_eq!(received, payload);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_limit_cancels_an_engine_without_waiting_for_a_newline() {
        let directory = tempfile::tempdir().unwrap();
        let scope = crate::ProcessScope::default();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            scope.run(crate::ProcessRunner::new().run_to_completion_capture(
                crate::CommandSpec::new(
                    "sh",
                    vec!["-c", "head -c 131072 /dev/zero | tr '\\0' x; sleep 60"],
                    directory.path().join("oversize.log"),
                ),
                tokio_util::sync::CancellationToken::new(),
                1024,
            )),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        scope.finish().await.unwrap();
    }

    use super::*;
    use crate::parser::PercentageParser;
    use std::path::PathBuf;

    fn test_log_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("splat-process-test-{}.log", name))
    }

    #[cfg(unix)]
    struct DescendantFixture {
        directory: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl DescendantFixture {
        fn new() -> Self {
            Self {
                directory: tempfile::tempdir().unwrap(),
            }
        }

        fn spec(&self, parent_exits: bool) -> CommandSpec {
            // The writer ignores TERM and holds the inherited output pipes.
            // Its sleep children exercise cleanup beyond the immediate child.
            let script = format!(
                "sh -c 'trap \"\" TERM; while :; do printf x >> \"$1\"; sleep 0.05; done' writer \"$1\" & echo $! > \"$2\"; {}",
                if parent_exits { "while [ ! -s \"$1\" ]; do sleep 0.01; done; exit 0" } else { "wait" }
            );
            CommandSpec::new(
                "sh",
                vec![
                    "-c".to_string(),
                    script,
                    "parent".to_string(),
                    self.directory
                        .path()
                        .join("writes")
                        .to_string_lossy()
                        .into_owned(),
                    self.directory
                        .path()
                        .join("pid")
                        .to_string_lossy()
                        .into_owned(),
                ],
                self.directory.path().join("output.log"),
            )
        }

        async fn wait_for_writer(&self) {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while std::fs::metadata(self.directory.path().join("writes"))
                    .map(|meta| meta.len() == 0)
                    .unwrap_or(true)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("descendant must start writing");
        }

        async fn assert_writes_stopped(&self) {
            let path = self.directory.path().join("writes");
            let before = std::fs::metadata(&path).unwrap().len();
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert_eq!(
                std::fs::metadata(path).unwrap().len(),
                before,
                "descendant continued writing after task completion"
            );
        }
    }

    #[cfg(unix)]
    impl Drop for DescendantFixture {
        fn drop(&mut self) {
            // Test-only fallback also cleans up after a failed regression test.
            if let Ok(pid) = std::fs::read_to_string(self.directory.path().join("pid")) {
                if let Ok(pid) = pid.trim().parse::<u32>() {
                    let _ = std::process::Command::new("/bin/kill")
                        .args(["-KILL", &pid.to_string()])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_cancel_stops_term_ignoring_descendants() {
        let fixture = DescendantFixture::new();
        let runner = ProcessRunner::new();
        let mut handle = runner.execute(fixture.spec(false)).await.unwrap();
        fixture.wait_for_writer().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runner.cancel(&mut handle),
        )
        .await
        .expect("group cancellation must be bounded")
        .unwrap();
        fixture.assert_writes_stopped().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_parent_exit_cleans_descendants_before_pipe_eof() {
        let fixture = DescendantFixture::new();
        let runner = ProcessRunner::new();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runner.run_to_completion(fixture.spec(true), CancellationToken::new(), None),
        )
        .await
        .expect("orphaned pipes must not hang a completed command")
        .unwrap();
        assert!(result.is_success());
        fixture.assert_writes_stopped().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_timeout_stops_term_ignoring_descendants() {
        let fixture = DescendantFixture::new();
        let runner = ProcessRunner::new();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runner.run_to_completion(
                fixture
                    .spec(false)
                    .with_timeout(std::time::Duration::from_millis(300)),
                CancellationToken::new(),
                None,
            ),
        )
        .await
        .expect("timeout cleanup must not hang on descendant pipes")
        .unwrap();
        assert!(result.timed_out);
        fixture.assert_writes_stopped().await;
    }

    #[cfg(unix)]
    #[test]
    fn unix_shutdown_before_first_lifecycle_poll_cleans_group() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let runner = ProcessRunner::new();
        let handle = runtime
            .block_on(runner.execute(CommandSpec::new(
                "sleep",
                vec!["60"],
                test_log_path("unpolled-shutdown"),
            )))
            .unwrap();
        // execute has spawned the task, but this current-thread runtime has not
        // polled it. Keep the handle alive across shutdown to exercise the gap.
        drop(runtime);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    if let Some(status) = handle.child.lock().await.try_wait().unwrap() {
                        assert!(!status.success());
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("unpolled lifecycle must still kill its group");
        });
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

    #[cfg(windows)]
    #[tokio::test]
    async fn process_runner_has_no_windows_console() {
        let script = r#"
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MetOriginRunnerConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
[Console]::Out.Write("captured")
if ([MetOriginRunnerConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero) { exit 0 }
exit 17
"#;
        let spec = CommandSpec::new(
            "powershell.exe",
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            test_log_path("no-windows-console"),
        );

        let captured = ProcessRunner::new()
            .run_to_completion_capture(spec, CancellationToken::new(), 1024)
            .await
            .unwrap();

        assert_eq!(captured.process.exit_code, Some(0));
        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "captured");
        assert!(captured.stderr.is_empty());
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
            (
                "powershell.exe",
                vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 10"],
            )
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

    #[tokio::test]
    async fn test_run_to_completion_parses_stderr_progress() {
        let mut parser = CompositeParser::new();
        parser.add(Box::new(PercentageParser::new("test")));
        let runner = ProcessRunner::with_parser(parser);
        let (cmd, args) = if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C", "echo Progress: 45% complete 1>&2"])
        } else {
            ("sh", vec!["-c", "echo 'Progress: 45% complete' >&2"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("stderr-progress"));
        let (progress_tx, mut progress_rx) = broadcast::channel(8);

        let result = runner
            .run_to_completion(spec, CancellationToken::new(), Some(progress_tx))
            .await
            .unwrap();

        assert!(result.is_success());
        let progress = progress_rx.try_recv().unwrap();
        assert!((progress.percent - 0.45).abs() < 0.001);
    }

    #[tokio::test]
    async fn test_run_to_completion_cancels_process_tree() {
        let runner = ProcessRunner::new();
        let (cmd, args) = if cfg!(target_os = "windows") {
            (
                "powershell.exe",
                vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
            )
        } else {
            ("sleep", vec!["60"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("token-cancel"));
        let cancellation = CancellationToken::new();
        let trigger = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            trigger.cancel();
        });

        let result = runner
            .run_to_completion(spec, cancellation, None)
            .await
            .unwrap();

        assert!(result.cancelled);
        assert_eq!(result.exit_code, None);
    }

    #[tokio::test]
    async fn test_capture_enforces_combined_output_limit() {
        let runner = ProcessRunner::new();
        let (cmd, args) = if cfg!(target_os = "windows") {
            (
                "cmd.exe",
                vec!["/C", "for /L %i in (1,1,20) do @echo 1234567890"],
            )
        } else {
            ("sh", vec!["-c", "yes 1234567890 | head -n 20"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("capture-limit"));

        let error = runner
            .run_to_completion_capture(spec, CancellationToken::new(), 32)
            .await
            .unwrap_err();

        assert_eq!(error.code, "E-2106", "{error:?}");
    }

    #[tokio::test]
    async fn test_capture_reports_timeout_and_terminates_process() {
        let runner = ProcessRunner::new();
        let (cmd, args) = if cfg!(target_os = "windows") {
            (
                "powershell.exe",
                vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 10"],
            )
        } else {
            ("sleep", vec!["10"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("capture-timeout"))
            .with_timeout(std::time::Duration::from_millis(100));

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run_to_completion_capture(spec, CancellationToken::new(), 1024),
        )
        .await
        .expect("capture should observe the process timeout")
        .unwrap();

        assert!(result.process.timed_out);
        assert!(!result.process.cancelled);
        assert_eq!(result.process.exit_code, None);
    }

    #[tokio::test]
    async fn test_capture_honors_cancellation_token() {
        let runner = ProcessRunner::new();
        let (cmd, args) = if cfg!(target_os = "windows") {
            (
                "powershell.exe",
                vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
            )
        } else {
            ("sleep", vec!["60"])
        };
        let spec = CommandSpec::new(cmd, args, test_log_path("capture-cancel"));
        let cancellation = CancellationToken::new();
        let trigger = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            trigger.cancel();
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runner.run_to_completion_capture(spec, cancellation, 1024),
        )
        .await
        .expect("capture cancellation should terminate the process")
        .unwrap();

        assert!(result.process.cancelled);
        assert!(!result.process.timed_out);
        assert_eq!(result.process.exit_code, None);
    }
}
