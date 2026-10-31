//! Real Windows subprocesses with bounded lifetimes. Helper PIDs are captured
//! as kernel handles and their creation time is verified before any cleanup.
use super::*;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const WRITER: &str = "windows_job::tests::owned_writer_fixture";
const PARENT: &str = "windows_job::tests::owned_parent_fixture";
const OWNER: &str = "windows_job::tests::owned_app_fixture";
const ROOT_ENV: &str = "METORIGIN_WINDOWS_JOB_TEST_ROOT";

fn creation_time(process: *mut std::ffi::c_void) -> u64 {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: retained process handle and four initialized FILETIME outputs.
    assert_ne!(
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) },
        0
    );
    (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime)
}

struct CapturedFixture(OwnedHandle);
impl CapturedFixture {
    async fn capture(root: &Path) -> Self {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !std::fs::metadata(root.join("pulse")).is_ok_and(|m| m.len() > 0) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                if let Ok(bytes) = std::fs::read(root.join("writer.json")) {
                    if let Ok(record) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        let pid = record["pid"].as_u64().unwrap() as u32;
                        // SAFETY: only a fixture PID published by this test is
                        // opened; verify creation time before retaining rights.
                        let raw = unsafe {
                            OpenProcess(
                                PROCESS_TERMINATE
                                    | PROCESS_SYNCHRONIZE
                                    | PROCESS_QUERY_LIMITED_INFORMATION,
                                0,
                                pid,
                            )
                        };
                        assert!(
                            !raw.is_null(),
                            "fixture must still be alive before test action"
                        );
                        // SAFETY: OpenProcess returned one owned handle.
                        let captured = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
                        assert_eq!(
                            creation_time(captured.0.as_raw_handle()),
                            record["creation_time"].as_u64().unwrap()
                        );
                        return captured;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned writer must start")
    }

    async fn assert_stopped(&self, root: &Path) {
        tokio::time::timeout(Duration::from_secs(3), async {
            // SAFETY: polling an owned, creation-time-verified process handle.
            while unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned descendant must exit within the cleanup bound");
        let before = std::fs::metadata(root.join("pulse")).unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(std::fs::metadata(root.join("pulse")).unwrap().len(), before);
    }

    async fn assert_keeps_writing(&self, root: &Path) {
        // SAFETY: a retained handle cannot refer to a reused PID.
        assert_eq!(
            unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        let before = std::fs::metadata(root.join("pulse")).unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(std::fs::metadata(root.join("pulse")).unwrap().len() > before);
    }
}

struct OwnedFixtureChild(std::process::Child);
impl std::ops::Deref for OwnedFixtureChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedFixtureChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for OwnedFixtureChild {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            // The retained std Child handle identifies only our own fixture.
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
impl Drop for CapturedFixture {
    fn drop(&mut self) {
        // Failure fallback touches only the exact creation-time-verified handle.
        // SAFETY: the handle stays valid until OwnedHandle closes it afterward.
        unsafe {
            if WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_TIMEOUT {
                TerminateProcess(self.0.as_raw_handle(), 99);
                WaitForSingleObject(self.0.as_raw_handle(), 3000);
            }
        }
    }
}

fn helper_command(name: &str, root: &Path) -> Command {
    let mut command = crate::background_command(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--ignored", "--nocapture"])
        .env(ROOT_ENV, root);
    command
}

fn spec(root: &Path, parent_exits: bool) -> crate::CommandSpec {
    crate::CommandSpec::new(
        std::env::current_exe().unwrap(),
        vec!["--exact", PARENT, "--ignored", "--nocapture"],
        root.join("runner.log"),
    )
    .with_env(ROOT_ENV, root.to_string_lossy().as_ref())
    .with_env(
        "METORIGIN_WINDOWS_JOB_PARENT_EXITS",
        if parent_exits { "1" } else { "0" },
    )
}

fn fixture_root() -> Option<PathBuf> {
    std::env::var_os(ROOT_ENV).map(PathBuf::from)
}

#[test]
#[ignore = "native subprocess fixture; run only through the owning Windows job tests"]
fn owned_writer_fixture() {
    let Some(root) = fixture_root() else { return };
    // SAFETY: GetCurrentProcess returns this fixture's pseudo-handle for query.
    let creation = creation_time(unsafe { GetCurrentProcess() });
    std::fs::write(
        root.join("writer.json"),
        serde_json::to_vec(&serde_json::json!({
            "pid": std::process::id(), "creation_time": creation,
        }))
        .unwrap(),
    )
    .unwrap();
    let mut pulse = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("pulse"))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        pulse.write_all(b".").unwrap();
        pulse.flush().unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "native subprocess fixture; run only through the owning Windows job tests"]
#[allow(
    clippy::zombie_processes,
    reason = "Windows-only fixture deliberately exits its leader first; the outer test retains and verifies the descendant process handle and job termination"
)]
fn owned_parent_fixture() {
    let Some(root) = fixture_root() else { return };
    let mut writer = helper_command(WRITER, &root).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if std::env::var("METORIGIN_WINDOWS_JOB_PARENT_EXITS").as_deref() == Ok("1")
            && root.join("release-leader").exists()
        {
            return; // std Child drops handles, deliberately leaving the writer.
        }
        if writer.try_wait().unwrap().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    writer.kill().unwrap();
    writer.wait().unwrap();
}

#[test]
#[ignore = "native subprocess fixture; run only through the owning Windows job tests"]
fn owned_app_fixture() {
    let Some(root) = fixture_root() else { return };
    if std::env::var("METORIGIN_WINDOWS_JOB_OWNER_KIND").as_deref() == Ok("sync_probe") {
        let mut command = helper_command(PARENT, &root);
        command.env("METORIGIN_WINDOWS_JOB_PARENT_EXITS", "0");
        let _ = crate::probe_output_sync_with_timeout(&mut command, Duration::from_secs(60));
    } else {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _handle = runtime
            .block_on(crate::ProcessRunner::new().execute(spec(&root, false)))
            .unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }
}

#[tokio::test]
async fn cancellation_terminates_descendants_and_preserves_unrelated_process() {
    let root = tempfile::tempdir().unwrap();
    let unrelated_root = tempfile::tempdir().unwrap();
    let mut unrelated_child = OwnedFixtureChild(
        helper_command(WRITER, unrelated_root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let unrelated = CapturedFixture::capture(unrelated_root.path()).await;
    let scope = crate::ProcessScope::default();
    let runner = crate::ProcessRunner::new();
    let mut handle = scope
        .run(runner.execute(spec(root.path(), false)))
        .await
        .unwrap();
    let descendant = CapturedFixture::capture(root.path()).await;
    runner.cancel(&mut handle).await.unwrap();
    scope.finish().await.unwrap();
    descendant.assert_stopped(root.path()).await;
    // Repeated cleanup after the leader has been reaped must never target a PID.
    runner.cancel(&mut handle).await.unwrap();
    unrelated.assert_keeps_writing(unrelated_root.path()).await;
    drop(unrelated);
    unrelated_child.wait().unwrap();
}

#[tokio::test]
async fn timeout_reaps_descendants_before_emitting_completion() {
    let root = tempfile::tempdir().unwrap();
    let scope = crate::ProcessScope::default();
    let runner = crate::ProcessRunner::new();
    let mut handle = scope
        .run(runner.execute(spec(root.path(), false).with_timeout(Duration::from_secs(2))))
        .await
        .unwrap();
    let descendant = CapturedFixture::capture(root.path()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(
            handle.events.recv().await.unwrap(),
            crate::ProcessEvent::TimedOut { .. }
        ) {}
    })
    .await
    .expect("Windows timeout must complete without inherited-pipe hang");
    descendant.assert_stopped(root.path()).await;
    scope.finish().await.unwrap();
}

#[tokio::test]
async fn exited_leader_cannot_leave_descendant_pipes_hanging() {
    let root = tempfile::tempdir().unwrap();
    let scope = crate::ProcessScope::default();
    let runner = crate::ProcessRunner::new();
    let mut handle = scope
        .run(runner.execute(spec(root.path(), true)))
        .await
        .unwrap();
    let descendant = CapturedFixture::capture(root.path()).await;
    std::fs::write(root.path().join("release-leader"), b"exit").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let crate::ProcessEvent::Exited { code, .. } = handle.events.recv().await.unwrap() {
                assert_eq!(code, 0);
                break;
            }
        }
    })
    .await
    .expect("normal leader exit must stop remaining owned descendants before pipe EOF");
    descendant.assert_stopped(root.path()).await;
    scope.finish().await.unwrap();
}

#[tokio::test]
async fn forced_application_exit_kills_async_engines_and_sync_probes() {
    for kind in ["async", "sync_probe"] {
        let root = tempfile::tempdir().unwrap();
        let mut owner = OwnedFixtureChild(
            helper_command(OWNER, root.path())
                .env("METORIGIN_WINDOWS_JOB_OWNER_KIND", kind)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let descendant = CapturedFixture::capture(root.path()).await;
        // std Child retains the precise owner process handle throughout kill.
        owner.kill().unwrap();
        owner.wait().unwrap();
        descendant.assert_stopped(root.path()).await;
    }
}

#[tokio::test]
async fn failed_assignment_never_executes_the_suspended_child() {
    use std::os::windows::process::CommandExt;
    let root = tempfile::tempdir().unwrap();
    let job = Arc::new(WindowsJob::new().unwrap());
    let mut command = tokio::process::Command::from(helper_command(WRITER, root.path()));
    command.as_std_mut().creation_flags(OWNED_CREATION_FLAGS);
    command.kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let error = job
        .assign_and_resume_using(&child, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected assignment denial",
            ))
        })
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!root.path().join("writer.json").exists());
    assert!(!root.path().join("pulse").exists());
    child.start_kill().unwrap();
    tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .unwrap()
        .unwrap();
    job.terminate().await.unwrap();
}
