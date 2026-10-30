//! Cleanup ownership for one supervised operation, including abnormal exits.
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use splat_domain::{AppError, AppResult, ErrorCategory};
use tokio::sync::watch;

use crate::{ProcessHandle, ProcessRunner};

tokio::task_local! { static CURRENT: ProcessScope; }

static PENDING_CLEANUP: OnceLock<Mutex<Vec<ProcessHandle>>> = OnceLock::new();

/// Created before lifecycle spawn so even a never-polled/aborted future keeps
/// scope-less cleanup owned. A successful lifecycle explicitly disarms it.
pub(crate) struct UnscopedCleanupGuard(Option<ProcessHandle>);
impl UnscopedCleanupGuard {
    pub(crate) fn new(handle: &ProcessHandle) -> Self {
        Self((!ProcessScope::is_active()).then(|| handle.clone()))
    }
    pub(crate) fn disarm(&mut self) {
        self.0 = None;
    }
}
impl Drop for UnscopedCleanupGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            retain_pending_handle(handle);
        }
    }
}

fn retain_pending_handle(handle: ProcessHandle) {
    let mut pending = PENDING_CLEANUP
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !pending
        .iter()
        .any(|existing| Arc::ptr_eq(&existing.lifecycle, &handle.lifecycle))
    {
        pending.push(handle);
    }
}

#[derive(Clone, Default)]
pub struct ProcessScope {
    processes: Arc<Mutex<Vec<ProcessHandle>>>,
    background: Arc<Mutex<Vec<BackgroundReceipt>>>,
}

#[derive(Clone)]
struct BackgroundReceipt {
    abort: tokio::task::AbortHandle,
    finished: watch::Receiver<bool>,
}

struct Finished(watch::Sender<bool>);
impl Drop for Finished {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

impl ProcessScope {
    /// Retry scope-less failed lifecycle cleanup after IPC/preflight work has
    /// drained. Standard mutexes are used only to snapshot/remove receipts.
    pub async fn finish_pending_cleanup() -> AppResult<()> {
        let Some(registry) = PENDING_CLEANUP.get() else {
            return Ok(());
        };
        let pending = registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        for handle in pending {
            let scope = Self::default();
            scope
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(handle.clone());
            scope.finish().await?;
            registry
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|existing| !Arc::ptr_eq(&existing.lifecycle, &handle.lifecycle));
        }
        Ok(())
    }

    /// Transfer a failed temporary probe scope before its private runtime is
    /// dropped. Completed receipts are skipped; unresolved ones stay retryable
    /// from the application's runtime through finish_pending_cleanup.
    pub(crate) fn retain_pending_cleanup(&self) {
        let processes = self
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        for handle in processes {
            let complete = handle
                .lifecycle
                .try_lock()
                .is_ok_and(|receipt| receipt.task.is_none() && receipt.error.is_none());
            if !complete {
                retain_pending_handle(handle);
            }
        }
    }

    pub fn is_active() -> bool {
        CURRENT.try_with(|_| ()).is_ok()
    }

    /// Bind direct awaited process launches to this run. Raw tokio::spawn does
    /// not inherit task locals; use spawn_scoped for run-owned background work.
    pub async fn run<F: Future>(&self, future: F) -> F::Output {
        CURRENT.scope(self.clone(), future).await
    }

    /// Called only after the primary worker has joined. Retains every receipt
    /// across cancellation/timeouts/errors so callers can retry this operation.
    pub async fn finish(&self) -> AppResult<()> {
        let mut index = 0;
        loop {
            let task = self
                .background
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(index)
                .cloned();
            let Some(mut task) = task else { break };
            task.abort.abort();
            while !*task.finished.borrow_and_update() {
                task.finished
                    .changed()
                    .await
                    .map_err(|_| cleanup_error("Background task receipt closed"))?;
            }
            index += 1;
        }
        let processes = self
            .processes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for mut process in processes {
            // Hold the receipt while awaiting by reference, never take it before
            // an await. A cancelled finish must leave it available for retry.
            let lifecycle = process.lifecycle.clone();
            let mut receipt = lifecycle.lock().await;
            if receipt.error.is_some() {
                // The lifecycle has joined, but its previous cleanup failed.
                // Keep the receipt until an explicit retry proves termination.
                ProcessRunner::new().cancel(&mut process).await?;
                receipt.error = None;
            }
            if let Some(task) = receipt.task.as_mut() {
                if !task.is_finished() {
                    ProcessRunner::new().cancel(&mut process).await?;
                }
                let outcome = task.await;
                receipt.task = None;
                let failure = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(error) => Some(error.to_string()),
                };
                if let Some(error) = failure {
                    receipt.error = Some(error.clone());
                    return Err(cleanup_error(&error));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn register_process(handle: &ProcessHandle) {
    let _ = CURRENT.try_with(|scope| {
        scope
            .processes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(handle.clone());
    });
}

/// Spawn run-owned background work, explicitly propagating process ownership.
/// Outside a supervised run this has the usual tokio::spawn behavior.
pub fn spawn_scoped<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let scope = CURRENT.try_with(Clone::clone).ok();
    let (sender, finished) = watch::channel(false);
    let signal = Finished(sender);
    let child_scope = scope.clone();
    let task = tokio::spawn(async move {
        let _signal = signal;
        match child_scope {
            Some(scope) => scope.run(future).await,
            None => future.await,
        }
    });
    if let Some(scope) = scope {
        scope
            .background
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(BackgroundReceipt {
                abort: task.abort_handle(),
                finished,
            });
    }
    task
}

fn cleanup_error(detail: &str) -> AppError {
    AppError::new(
        "E-2104",
        ErrorCategory::Engine,
        "Process Cleanup Failed",
        "The engine cleanup did not finish; the operation remains owned for retry.",
    )
    .with_technical(detail)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{CommandSpec, ProcessEvent};
    use std::time::Duration;

    struct WriterCleanup(std::path::PathBuf);
    impl Drop for WriterCleanup {
        fn drop(&mut self) {
            if let Ok(pid) = std::fs::read_to_string(self.0.join("writer-pid")) {
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

    fn failing_cleanup_spec(directory: &std::path::Path) -> CommandSpec {
        CommandSpec::new("/bin/sh", vec![
            "-c".to_owned(),
            "sh -c 'trap \"\" TERM; while :; do printf x >> \"$1\"; sleep 0.02; done' writer \"$1\" & echo $! > \"$3\"; while [ ! -e \"$2\" ]; do sleep 0.01; done; exit 0".to_owned(),
            "parent".to_owned(), directory.join("writes").to_string_lossy().into_owned(),
            directory.join("exit").to_string_lossy().into_owned(),
            directory.join("writer-pid").to_string_lossy().into_owned(),
        ], directory.join("process.log"))
    }

    async fn wait_for_writes(directory: &std::path::Path) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while std::fs::metadata(directory.join("writes"))
                .map(|m| m.len() == 0)
                .unwrap_or(true)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn assert_stopped(directory: &std::path::Path) {
        let before = std::fs::metadata(directory.join("writes")).unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            std::fs::metadata(directory.join("writes")).unwrap().len(),
            before
        );
    }

    #[tokio::test]
    async fn public_runner_helpers_propagate_cleanup_failure_and_scope_retry_preserves_ownership() {
        for capture in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let _cleanup = WriterCleanup(directory.path().to_owned());
            let scope = ProcessScope::default();
            let worker_scope = scope.clone();
            let spec = failing_cleanup_spec(directory.path());
            let worker = tokio::spawn(async move {
                worker_scope
                    .run(async {
                        let runner = ProcessRunner::new();
                        if capture {
                            runner
                                .run_to_completion_capture(
                                    spec,
                                    tokio_util::sync::CancellationToken::new(),
                                    65536,
                                )
                                .await
                                .map(|_| ())
                        } else {
                            runner
                                .run_to_completion(
                                    spec,
                                    tokio_util::sync::CancellationToken::new(),
                                    None,
                                )
                                .await
                                .map(|_| ())
                        }
                    })
                    .await
            });
            wait_for_writes(directory.path()).await;
            let handle = scope.processes.lock().unwrap()[0].clone();
            handle.process_group.inject_cleanup_failure(true);
            std::fs::write(directory.path().join("exit"), b"").unwrap();
            let error = tokio::time::timeout(Duration::from_secs(5), worker)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, "E-2104");
            assert!(handle.process_group.retains_ownership());
            assert!(handle.lifecycle.lock().await.error.is_some());
            assert!(
                scope.finish().await.is_err(),
                "persistent cleanup failure must block finalization"
            );
            assert!(handle.process_group.retains_ownership());
            scope.retain_pending_cleanup();
            assert!(PENDING_CLEANUP
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .iter()
                .any(|item| Arc::ptr_eq(&item.lifecycle, &handle.lifecycle)));
            handle.process_group.inject_cleanup_failure(false);
            scope.finish().await.unwrap();
            assert!(!handle.process_group.retains_ownership());
            assert!(handle.lifecycle.lock().await.error.is_none());
            assert_stopped(directory.path()).await;
            scope.finish().await.unwrap();
        }
    }

    #[tokio::test]
    async fn standalone_lifecycle_registers_failure_after_caller_drops_and_registry_retry_removes_it(
    ) {
        // Other runtime-abort tests may enqueue already-killed receipts; retries
        // below drain them too without assuming this is the only global entry.
        let directory = tempfile::tempdir().unwrap();
        let _cleanup = WriterCleanup(directory.path().to_owned());
        let handle = ProcessRunner::new()
            .execute(failing_cleanup_spec(directory.path()))
            .await
            .unwrap();
        handle.process_group.inject_cleanup_failure(true);
        wait_for_writes(directory.path()).await;
        let lifecycle = handle.lifecycle.clone();
        let group = handle.process_group.clone();
        let mut events = handle.events.resubscribe();
        drop(handle); // The caller disappears before the lifecycle fails.
        std::fs::write(directory.path().join("exit"), b"").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !matches!(events.recv().await.unwrap(), ProcessEvent::Exited { .. }) {}
            loop {
                let registered = PENDING_CLEANUP.get().is_some_and(|registry| {
                    registry
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|item| Arc::ptr_eq(&item.lifecycle, &lifecycle))
                });
                if registered {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // No run_to_completion wrapper consumed this failure; registration was
        // owned by the lifecycle itself and survives discarding the caller.
        assert!(ProcessScope::finish_pending_cleanup().await.is_err());
        assert!(group.retains_ownership());
        group.inject_cleanup_failure(false);
        tokio::time::timeout(Duration::from_secs(3), async {
            while ProcessScope::finish_pending_cleanup().await.is_err() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!group.retains_ownership());
        assert!(!PENDING_CLEANUP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .iter()
            .any(|item| Arc::ptr_eq(&item.lifecycle, &lifecycle)));
        assert_stopped(directory.path()).await;
    }

    #[tokio::test]
    async fn nonzero_engine_exit_with_successful_cleanup_is_not_a_cleanup_failure() {
        let directory = tempfile::tempdir().unwrap();
        let scope = ProcessScope::default();
        let result = scope
            .run(ProcessRunner::new().run_to_completion(
                CommandSpec::new(
                    "/bin/sh",
                    vec!["-c", "exit 7"],
                    directory.path().join("exit7.log"),
                ),
                tokio_util::sync::CancellationToken::new(),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(7));
        scope.finish().await.unwrap();
        assert!(scope.processes.lock().unwrap()[0]
            .lifecycle
            .try_lock()
            .unwrap()
            .error
            .is_none());
    }

    #[tokio::test]
    async fn aborted_worker_cleanup_is_retryable_and_does_not_kill_unrelated_process() {
        let directory = tempfile::tempdir().unwrap();
        let scope = ProcessScope::default();
        let worker_scope = scope.clone();
        let log = directory.path().join("engine.log");
        let log_for_worker = log.clone();
        let (ready, running) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            worker_scope
                .run(async move {
                    let mut handle = ProcessRunner::new()
                        .execute(CommandSpec::new(
                            "sh",
                            vec!["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"],
                            log_for_worker,
                        ))
                        .await
                        .unwrap();
                    while !matches!(
                        handle.events.recv().await.unwrap(),
                        ProcessEvent::StdoutLine { .. }
                    ) {}
                    ready.send(handle).unwrap();
                    std::future::pending::<()>().await;
                })
                .await;
        });
        let process = running.await.unwrap();
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), scope.finish())
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(5), scope.finish())
            .await
            .unwrap()
            .unwrap();
        assert!(process.child.lock().await.try_wait().unwrap().is_some());
        assert!(unrelated.try_wait().unwrap().is_none());
        assert!(std::fs::read_to_string(log).unwrap().contains("ready"));
        scope.finish().await.unwrap();
        unrelated.kill().await.unwrap();
        unrelated.wait().await.unwrap();
    }

    #[tokio::test]
    async fn panicked_worker_scope_cleans_processes_launched_in_scoped_background_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("nested.log");
        let scope = ProcessScope::default();
        let worker_scope = scope.clone();
        let (ready, running) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            worker_scope
                .run(async move {
                    spawn_scoped(async move {
                        let handle = ProcessRunner::new()
                            .execute(CommandSpec::new("sleep", vec!["60"], log))
                            .await
                            .unwrap();
                        ready.send(handle).unwrap();
                        std::future::pending::<()>().await;
                    });
                    panic!("injected worker failure");
                })
                .await;
        });
        assert!(worker.await.unwrap_err().is_panic());
        let process = running.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), scope.finish())
            .await
            .unwrap()
            .unwrap();
        assert!(process.child.lock().await.try_wait().unwrap().is_some());
        assert!(scope
            .background
            .lock()
            .unwrap()
            .iter()
            .all(|task| *task.finished.borrow()));
    }
}
