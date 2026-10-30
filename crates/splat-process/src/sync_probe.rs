//! Bounded synchronous CLI probes backed by the supervised asynchronous runner.
//!
//! A dedicated OS thread owns the Tokio runtime, so synchronous adapters can be
//! called from either a blocking worker or an existing asynchronous runtime.
use std::io;
use std::process::Command;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::{CommandSpec, ProcessRunner, ProcessScope};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct ProbeOutput {
    pub status: ProbeExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub struct ProbeExitStatus(Option<i32>);

impl ProbeExitStatus {
    pub fn success(&self) -> bool {
        self.0 == Some(0)
    }

    pub fn code(&self) -> Option<i32> {
        self.0
    }
}

/// Apply a ten-second execution deadline and 64 KiB capture limit to a probe.
/// Cleanup of the process group, output readers and log is awaited before
/// returning. Unix cleanup has separate grace periods; Windows retains the
/// shared runner's taskkill behavior, so this is not a cross-platform bound on
/// total cleanup time.
///
/// Preserves the program, OS-native arguments, current directory and added
/// environment variables. Use an ordinary background command: custom stdio,
/// environment clearing/removal and platform spawn hooks are not supported.
/// The shared runner supplies redirected pipes and Windows CREATE_NO_WINDOW.
pub fn probe_output_sync(command: &mut Command) -> io::Result<ProbeOutput> {
    probe_output_sync_with_timeout(command, PROBE_TIMEOUT)
}

/// Apply a caller-selected execution deadline with the same fixed 64 KiB
/// capture limit and fully awaited process-scope cleanup as [`probe_output_sync`].
/// This does not retry the command or change the cleanup grace periods.
pub fn probe_output_sync_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> io::Result<ProbeOutput> {
    probe_with_limits(command, timeout, PROBE_OUTPUT_BYTES)
}

fn probe_with_limits(
    command: &Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> io::Result<ProbeOutput> {
    let directory = tempfile::Builder::new()
        .prefix("metorigin-probe-")
        .tempdir()?;
    let mut spec = CommandSpec::new(
        command.get_program(),
        command
            .get_args()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        directory.path().join("probe.log"),
    )
    .with_timeout(timeout);
    if let Some(cwd) = command.get_current_dir() {
        spec = spec.with_cwd(cwd);
    }
    for (key, value) in command.get_envs() {
        let value = value.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Probe environment removal is unsupported",
            )
        })?;
        spec = spec.with_env(key, value);
    }
    std::thread::Builder::new()
        .name("engine-probe".into())
        .spawn(move || {
            // Keep the log directory alive until the runtime and all its process
            // lifecycle tasks have completed, including error and panic paths.
            let _directory = directory;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async move {
                let scope = ProcessScope::default();
                let worker_scope = scope.clone();
                let worker = tokio::spawn(async move {
                    worker_scope
                        .run(ProcessRunner::new().run_to_completion_capture(
                            spec,
                            CancellationToken::new(),
                            max_output_bytes,
                        ))
                        .await
                });
                let result = worker.await;
                // Never drop the runtime merely because capture timed out,
                // exceeded its output limit, failed, or panicked.
                if let Err(error) = scope.finish().await {
                    // A temporary runtime cannot own a failed cleanup after
                    // this call returns. Hand receipts to the app's retry gate
                    // before dropping either the scope or its runtime.
                    scope.retain_pending_cleanup();
                    return Err(io::Error::other(error));
                }
                let captured = result
                    .map_err(io::Error::other)?
                    .map_err(io::Error::other)?;
                if captured.process.timed_out {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Engine probe timed out",
                    ));
                }
                if captured.process.cancelled {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "Engine probe was cancelled",
                    ));
                }
                Ok(ProbeOutput {
                    status: ProbeExitStatus(captured.process.exit_code),
                    stdout: captured.stdout,
                    stderr: captured.stderr,
                })
            })
        })?
        .join()
        .map_err(|_| io::Error::other("Engine probe thread panicked"))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn shell(script: &str) -> Command {
        let mut command = crate::background_command("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn preserves_unicode_arguments_environment_working_directory_and_nonzero_status() {
        let directory = tempfile::Builder::new()
            .prefix("探测 中文 空格 ")
            .tempdir()
            .unwrap();
        let mut command = shell("printf '%s\\n' \"$1\" \"$METORIGIN_PROBE_VALUE\"; pwd; printf 'diagnostic\\n' >&2; exit 7");
        command
            .arg("probe")
            .arg("参数 中文 空格")
            .env("METORIGIN_PROBE_VALUE", "环境 中文")
            .current_dir(directory.path());
        let output = probe_output_sync(&mut command).unwrap();
        assert!(!output.status.success());
        assert_eq!(output.status.code(), Some(7));
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("参数 中文 空格\n环境 中文\n"));
        assert!(text.contains(directory.path().canonicalize().unwrap().to_str().unwrap()));
        assert_eq!(output.stderr, b"diagnostic\n");
    }

    #[tokio::test]
    async fn synchronous_probe_can_run_inside_an_existing_runtime() {
        let output = probe_output_sync(&mut shell("printf 'version 1.2.3\\n'")).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"version 1.2.3\n");
    }

    #[test]
    fn timeout_waits_for_owned_descendants_to_stop() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("unexpected-write");
        let mut command =
            shell("trap '' TERM; (trap '' TERM; sleep 2; echo leaked > \"$1\") & wait");
        command.arg("probe").arg(&marker);
        let started = Instant::now();
        let error =
            probe_output_sync_with_timeout(&mut command, Duration::from_millis(100)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2100));
        assert!(!marker.exists(), "timed-out probe left a writer alive");
    }

    #[test]
    fn exited_leader_does_not_leave_inherited_pipes_or_background_writers() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("unexpected-write");
        let mut command =
            shell("(sleep 2; echo leaked > \"$1\") & printf 'version 1.2.3\\n'; exit 0");
        command.arg("probe").arg(&marker);
        let started = Instant::now();
        let output = probe_output_sync(&mut command).unwrap();
        assert!(output.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(output.stdout, b"version 1.2.3\n");
        std::thread::sleep(Duration::from_millis(2100));
        assert!(!marker.exists(), "successful probe left a writer alive");
    }

    #[test]
    fn excessive_output_is_an_error_and_never_a_truncated_version() {
        let command = shell("i=0; while [ \"$i\" -lt 10000 ]; do printf '12345678901234567890\\n'; i=$((i+1)); done");
        assert!(probe_with_limits(&command, PROBE_TIMEOUT, 1024).is_err());
    }

    #[test]
    fn custom_timeout_keeps_nonzero_exit_and_captured_output() {
        let output = probe_output_sync_with_timeout(
            &mut shell("sleep 0.05; printf 'version 1.2.3\\n'; exit 7"),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"version 1.2.3\n");
    }

    #[test]
    fn custom_timeout_still_enforces_fixed_64_kib_capture_limit() {
        let error = probe_output_sync_with_timeout(
            &mut shell("/usr/bin/head -c 65537 /dev/zero"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_ne!(error.kind(), io::ErrorKind::TimedOut);
    }
}
