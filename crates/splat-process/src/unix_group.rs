//! Ownership of the private process group created for one engine invocation.
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

#[derive(Debug)]
pub(crate) struct ProcessGroup {
    // Zero means cleanup already completed. Never signal an invalid/own group.
    pgid: AtomicI32,
    cleanup: Mutex<()>,
    #[cfg(test)]
    fail_cleanup: std::sync::atomic::AtomicBool,
}

impl ProcessGroup {
    pub(crate) fn new(pid: u32) -> Self {
        Self {
            pgid: AtomicI32::new(i32::try_from(pid).unwrap_or(0)),
            cleanup: Mutex::new(()),
            #[cfg(test)]
            fail_cleanup: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) async fn terminate(
        &self,
        child: &Mutex<tokio::process::Child>,
    ) -> Result<(), String> {
        // Cancellation and normal-exit cleanup may arrive together. Signal the
        // owned group only once, including when a late handle is cancelled.
        let _guard = self.cleanup.lock().await;
        let pgid = self.pgid.load(Ordering::Acquire);
        if pgid == 0 {
            return Ok(());
        }
        if self
            .signal_after_reaping(pgid, libc::SIGTERM, child)
            .await?
        {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
            while tokio::time::Instant::now() < deadline {
                if !self.signal_after_reaping(pgid, 0, child).await? {
                    self.pgid.store(0, Ordering::Release);
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            self.signal_after_reaping(pgid, libc::SIGKILL, child)
                .await?;
        }
        self.pgid.store(0, Ordering::Release);
        Ok(())
    }

    async fn signal_after_reaping(
        &self,
        pgid: i32,
        signal: i32,
        child: &Mutex<tokio::process::Child>,
    ) -> Result<bool, String> {
        // Darwin returns EPERM for a group containing only an unreaped zombie,
        // including for signal 0. Reap through Tokio (preserving its cached exit
        // status), then retry the exit/signal race briefly. A persistent EPERM
        // remains an error; it is never treated as successful termination.
        #[cfg(test)]
        if self.fail_cleanup.load(Ordering::Acquire) {
            return Err("injected process group cleanup failure".into());
        }
        let mut retries = 4;
        loop {
            if self.pgid.load(Ordering::Acquire) != pgid {
                return Ok(false);
            }
            child
                .lock()
                .await
                .try_wait()
                .map_err(|error| error.to_string())?;
            match signal_group(pgid, signal) {
                Err(error) if error.raw_os_error() == Some(libc::EPERM) && retries > 0 => {
                    retries -= 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                result => {
                    return result
                        .map_err(|error| format!("Process group signal {signal} failed: {error}"))
                }
            }
        }
    }

    pub(crate) fn lifecycle_guard(self: &Arc<Self>) -> LifecycleGuard {
        LifecycleGuard {
            group: self.clone(),
            armed: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn inject_cleanup_failure(&self, fail: bool) {
        self.fail_cleanup.store(fail, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn retains_ownership(&self) -> bool {
        self.pgid.load(Ordering::Acquire) != 0
    }

    fn kill_on_drop(&self) {
        let pgid = self.pgid.load(Ordering::Acquire);
        if pgid != 0 {
            match signal_group(pgid, libc::SIGKILL) {
                Ok(_) => {
                    let _ =
                        self.pgid
                            .compare_exchange(pgid, 0, Ordering::AcqRel, Ordering::Acquire);
                }
                Err(error) => {
                    // Other scope/handle owners can retry. Never discard the
                    // only group identity merely because a signal failed.
                    tracing::warn!(pgid, %error, "Failed to clean up owned process group on drop");
                }
            }
        }
    }
}

pub(crate) struct LifecycleGuard {
    group: Arc<ProcessGroup>,
    armed: bool,
}

impl LifecycleGuard {
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LifecycleGuard {
    fn drop(&mut self) {
        if self.armed {
            self.group.kill_on_drop();
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Last-owner cleanup also covers a dropped/aborted lifecycle task.
        // Async graceful shutdown is no longer possible at this boundary.
        self.kill_on_drop();
    }
}

fn signal_group(pgid: i32, signal: i32) -> std::io::Result<bool> {
    // SAFETY: getpgrp has no arguments or memory preconditions.
    let own_group = unsafe { libc::getpgrp() };
    if pgid <= 1 || pgid == own_group {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Refusing to signal an invalid or application process group",
        ));
    }
    // SAFETY: kill takes integer identifiers only. The negative PID selects the
    // private group established by CommandExt::process_group(0) before exec.
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_application_and_invalid_groups() {
        // SAFETY: getpgrp has no memory preconditions.
        let own_group = unsafe { libc::getpgrp() };
        for pgid in [own_group, 0, 1, -1] {
            assert!(signal_group(pgid, 0).is_err());
        }
    }

    #[tokio::test]
    async fn aborting_lifecycle_kills_group_even_with_a_live_handle() {
        use std::os::unix::process::CommandExt;
        let mut command = tokio::process::Command::new("sleep");
        command.arg("60").kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let group = Arc::new(ProcessGroup::new(child.id().unwrap()));
        let owner = group.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let lifecycle = tokio::spawn(async move {
            let _guard = owner.lifecycle_guard();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        lifecycle.abort();
        assert!(lifecycle.await.unwrap_err().is_cancelled());
        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("aborted lifecycle must terminate its group")
            .unwrap();
        assert!(!status.success());
        assert_eq!(group.pgid.load(Ordering::Acquire), 0);
        // A stale handle must not signal a possibly reused PGID.
        group.terminate(&Mutex::new(child)).await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_reaps_exited_leader_before_signalling() {
        use std::os::unix::process::CommandExt;
        use tokio::io::AsyncReadExt;
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "printf done"])
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let group = ProcessGroup::new(child.id().unwrap());
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut Vec::new())
            .await
            .unwrap();
        // No background waiter: the exited leader may still be a zombie.
        let child = Mutex::new(child);
        group.terminate(&child).await.unwrap();
        assert!(child.lock().await.wait().await.unwrap().success());
    }
}
