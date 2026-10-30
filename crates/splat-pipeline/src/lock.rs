use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const LOCK_FILE: &str = ".lock";
// Never unlink this file: every cooperating process locks the same inode.
const KERNEL_LOCK_FILE: &str = ".lock.guard";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockStatus {
    Unlocked,
    Locked {
        pid: u32,
        started_at: DateTime<Utc>,
        stage: String,
    },
    Stale {
        pid: u32,
        started_at: DateTime<Utc>,
    },
}

#[derive(Debug)]
pub enum LockError {
    AlreadyLocked(LockInfo),
    Busy,
    Io(std::io::Error),
    Corrupted(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked(info) => write!(
                f,
                "Project is locked by PID {} since {} (stage: {})",
                info.pid, info.started_at, info.stage
            ),
            Self::Busy => write!(
                f,
                "Project lock is held by another operation; retry after it finishes"
            ),
            Self::Io(e) => write!(f, "Lock I/O error: {e}"),
            Self::Corrupted(message) => write!(f, "Corrupted lock file: {message}"),
        }
    }
}
impl std::error::Error for LockError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    pub pid: u32,
    pub started_at: DateTime<Utc>,
    pub stage: String,
}

/// Holds a kernel lock until metadata cleanup succeeds or this guard is dropped.
/// The stable `.lock.guard` file survives release; `.lock` is owner metadata.
#[must_use = "Lock guard will be dropped immediately; hold it for the duration of the pipeline"]
pub struct LockGuard {
    lock_path: PathBuf,
    owner_json: Vec<u8>,
    kernel_lock: Option<File>,
}

impl LockGuard {
    /// Verify that a borrowed guard still owns this project's kernel lock.
    /// This lets nested recovery reuse ownership without acquiring a second lock.
    pub fn covers_project(&self, project_dir: &Path) -> bool {
        let Some(file) = self.kernel_lock.as_ref() else {
            return false;
        };
        let Some(parent) = self.lock_path.parent() else {
            return false;
        };
        let same_directory = match (parent.canonicalize(), project_dir.canonicalize()) {
            (Ok(owned), Ok(requested)) => owned == requested,
            _ => parent == project_dir,
        };
        if !same_directory {
            return false;
        }
        let Ok(current) = regular_metadata(&project_dir.join(KERNEL_LOCK_FILE)) else {
            return false;
        };
        let Ok(opened) = file.metadata() else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            opened.dev() == current.dev() && opened.ino() == current.ino()
        }
        #[cfg(not(unix))]
        {
            let _ = (opened, current);
            true
        }
    }

    pub fn try_release(&mut self) -> std::io::Result<()> {
        if self.kernel_lock.is_none() {
            return Ok(());
        }
        match regular_metadata(&self.lock_path) {
            Ok(_) => {
                if std::fs::read(&self.lock_path)? != self.owner_json {
                    return Err(std::io::Error::other(
                        "Lock metadata changed; refusing to remove another owner's file",
                    ));
                }
                std::fs::remove_file(&self.lock_path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // Closing the handle releases the kernel lock even after a crash.
        drop(self.kernel_lock.take());
        Ok(())
    }

    pub fn release(mut self) {
        let _ = self.try_release();
    }
}
impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.try_release();
    }
}

fn regular_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::other(
            "Project lock must be a regular file, never a symbolic link",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(std::io::Error::other(
                "Project lock must not have hard links",
            ));
        }
    }
    Ok(metadata)
}

fn open_kernel_lock(project_dir: &Path) -> std::io::Result<File> {
    let path = project_dir.join(KERNEL_LOCK_FILE);
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            regular_metadata(&path)?;
            // Existing guard bytes are never read or written. Validate again
            // after open so ordinary replacement/symlink races fail closed.
            OpenOptions::new().read(true).write(true).open(&path)?
        }
        Err(error) => return Err(error),
    };
    let metadata = regular_metadata(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata()?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err(std::io::Error::other("Project lock changed while opening"));
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(file)
}

pub struct ProjectLock;
impl ProjectLock {
    /// Acquire the kernel guard before inspecting/reclaiming owner metadata.
    /// `create_new` never follows a dangling symlink or overwrites an existing
    /// owner. Reclaim and release are serialized with all new acquisitions.
    pub fn try_lock(project_dir: &Path, stage: &str) -> Result<LockGuard, LockError> {
        let lock_path = project_dir.join(LOCK_FILE);
        let kernel_lock = open_kernel_lock(project_dir).map_err(LockError::Io)?;
        match kernel_lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(Self::read_lock_info(&lock_path)
                    .map(LockError::AlreadyLocked)
                    .unwrap_or(LockError::Busy));
            }
            Err(TryLockError::Error(error)) => return Err(LockError::Io(error)),
        }
        let info = LockInfo {
            pid: std::process::id(),
            started_at: Utc::now(),
            stage: stage.to_owned(),
        };
        let owner_json =
            serde_json::to_vec(&info).map_err(|error| LockError::Corrupted(error.to_string()))?;
        // The kernel lock prevents two stale reclaimers from unlinking a new
        // owner. Bound retries in case an older/non-cooperating writer changes it.
        for _ in 0..3 {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut file) => {
                    file.write_all(&owner_json)
                        .and_then(|()| file.sync_all())
                        .map_err(LockError::Io)?;
                    return Ok(LockGuard {
                        lock_path,
                        owner_json,
                        kernel_lock: Some(kernel_lock),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    regular_metadata(&lock_path).map_err(LockError::Io)?;
                    let previous = Self::read_lock_info(&lock_path).ok_or_else(|| {
                        LockError::Corrupted(
                            "Existing metadata is invalid; preserved for inspection".into(),
                        )
                    })?;
                    if previous.pid == 0 || is_process_alive(previous.pid) {
                        return Err(LockError::AlreadyLocked(previous));
                    }
                    std::fs::remove_file(&lock_path).map_err(LockError::Io)?;
                }
                Err(error) => return Err(LockError::Io(error)),
            }
        }
        Err(LockError::Busy)
    }

    pub fn check(project_dir: &Path) -> LockStatus {
        match Self::read_lock_info(&project_dir.join(LOCK_FILE)) {
            Some(info) if is_process_alive(info.pid) => LockStatus::Locked {
                pid: info.pid,
                started_at: info.started_at,
                stage: info.stage,
            },
            Some(info) => LockStatus::Stale {
                pid: info.pid,
                started_at: info.started_at,
            },
            None => LockStatus::Unlocked,
        }
    }

    /// Explicit metadata cleanup still cannot revoke a live kernel lock.
    pub fn force_unlock(project_dir: &Path) -> std::io::Result<()> {
        let kernel_lock = open_kernel_lock(project_dir)?;
        kernel_lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "Project has an active operation",
            ),
            TryLockError::Error(error) => error,
        })?;
        let lock_path = project_dir.join(LOCK_FILE);
        match regular_metadata(&lock_path) {
            Ok(_) => {
                if Self::read_lock_info(&lock_path).is_some_and(|info| is_process_alive(info.pid)) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "Legacy project owner is still active",
                    ));
                }
                std::fs::remove_file(lock_path)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn read_lock_info(path: &Path) -> Option<LockInfo> {
        regular_metadata(path).ok()?;
        let file = File::open(path).ok()?;
        if file.metadata().ok()?.len() > 16 * 1024 {
            return None;
        }
        serde_json::from_reader(file.take(16 * 1024)).ok()
    }
}

/// Check whether a process with the given PID is still alive.
///
/// On Unix, uses `kill -0`. On Windows, uses `tasklist /FI "PID eq <pid>"`.
fn is_process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 || pid == std::process::id() {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: use tasklist to check process existence
        let output = splat_process::background_command("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .output();
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                !o.status.success() || stdout.contains(&pid.to_string())
            }
            Err(_) => true,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // kill(pid, 0) returns 0 if process exists, -1 if not
        let result = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .env("LC_ALL", "C")
            .output();
        match result {
            Ok(output) => unix_probe_may_be_alive(output.status.success(), &output.stderr),
            Err(_) => true,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn unix_probe_may_be_alive(success: bool, stderr: &[u8]) -> bool {
    // Permission failures (EPERM), unavailable tools and unknown diagnostics
    // cannot establish that a legacy owner died. Only explicit ESRCH permits
    // reclamation; force a stable locale at the fixed /bin/kill invocation.
    success
        || !String::from_utf8_lossy(stderr)
            .to_ascii_lowercase()
            .contains("no such process")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lock_nonexistent_project() {
        let dir = std::env::temp_dir().join("splat-lock-nonexistent");
        let _ = std::fs::remove_dir_all(&dir);

        // A lock cannot be created outside an existing project directory.
        let guard = ProjectLock::try_lock(&dir, "test");
        assert!(matches!(guard, Err(LockError::Io(_))));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_success_and_release() {
        let dir = std::env::temp_dir().join("splat-lock-success");
        let _ = std::fs::create_dir_all(&dir);

        // Acquire lock
        let guard = ProjectLock::try_lock(&dir, "frame_extraction").unwrap();
        assert!(dir.join(".lock").exists());

        // Release lock
        guard.release();
        assert!(!dir.join(".lock").exists());

        // Can re-acquire
        let guard2 = ProjectLock::try_lock(&dir, "training").unwrap();
        assert!(dir.join(".lock").exists());
        guard2.release();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_double_lock_fails() {
        let dir = std::env::temp_dir().join("splat-lock-double");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);

        let _guard = ProjectLock::try_lock(&dir, "stage1").unwrap();

        // Second lock should fail
        let result = ProjectLock::try_lock(&dir, "stage2");
        assert!(result.is_err());
        match result {
            Err(LockError::AlreadyLocked(info)) => {
                assert_eq!(info.stage, "stage1");
            }
            _ => panic!("expected AlreadyLocked"),
        }

        // Clean up
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_drop_releases() {
        let dir = std::env::temp_dir().join("splat-lock-drop");
        let _ = std::fs::create_dir_all(&dir);

        {
            let _guard = ProjectLock::try_lock(&dir, "stage").unwrap();
            assert!(dir.join(".lock").exists());
        }
        // Guard dropped → lock released
        assert!(!dir.join(".lock").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_check_unlocked() {
        let dir = std::env::temp_dir().join("splat-lock-check");
        let _ = std::fs::create_dir_all(&dir);

        let status = ProjectLock::check(&dir);
        assert_eq!(status, LockStatus::Unlocked);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_check_locked() {
        let dir = std::env::temp_dir().join("splat-lock-check-locked");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);

        let _guard = ProjectLock::try_lock(&dir, "mapping").unwrap();
        let status = ProjectLock::check(&dir);

        match status {
            LockStatus::Locked { stage, .. } => {
                assert_eq!(stage, "mapping");
            }
            _ => panic!("expected Locked"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_force_unlock() {
        let dir = std::env::temp_dir().join("splat-lock-force");
        let _ = std::fs::create_dir_all(&dir);

        let _guard = ProjectLock::try_lock(&dir, "test").unwrap();
        assert!(dir.join(".lock").exists());

        assert_eq!(
            ProjectLock::force_unlock(&dir).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(dir.join(".lock").exists());
        drop(_guard);
        std::fs::write(
            dir.join(".lock"),
            "stale/corrupt metadata preserved until explicit cleanup",
        )
        .unwrap();
        ProjectLock::force_unlock(&dir).unwrap();
        assert!(!dir.join(".lock").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn borrowed_guard_only_covers_its_project_until_release() {
        let owned = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut guard = ProjectLock::try_lock(owned.path(), "recovery").unwrap();
        assert!(guard.covers_project(owned.path()));
        assert!(guard.covers_project(&owned.path().join(".")));
        assert!(!guard.covers_project(other.path()));
        guard.try_release().unwrap();
        assert!(!guard.covers_project(owned.path()));
    }

    #[cfg(unix)]
    #[test]
    fn borrowed_guard_rejects_a_replaced_coordination_inode() {
        let owned = tempfile::tempdir().unwrap();
        let guard = ProjectLock::try_lock(owned.path(), "recovery").unwrap();
        std::fs::remove_file(owned.path().join(KERNEL_LOCK_FILE)).unwrap();
        std::fs::write(owned.path().join(KERNEL_LOCK_FILE), b"").unwrap();
        assert!(!guard.covers_project(owned.path()));
    }

    #[test]
    fn legacy_lock_owner_process() {
        let Some(directory) = std::env::var_os("METORIGIN_LEGACY_LOCK_TEST_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let info = LockInfo {
            pid: std::process::id(),
            started_at: Utc::now(),
            stage: "legacy-training".into(),
        };
        std::fs::write(
            directory.join(LOCK_FILE),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("ready"), b"").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !directory.join("release").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn live_legacy_owner_without_kernel_guard_is_never_reclaimed() {
        let directory = tempfile::tempdir().unwrap();
        let mut legacy = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "lock::tests::legacy_lock_owner_process",
                "--nocapture",
            ])
            .env("METORIGIN_LEGACY_LOCK_TEST_DIR", directory.path())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !directory.path().join("ready").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(!directory.path().join(KERNEL_LOCK_FILE).exists());
        let before = std::fs::read(directory.path().join(LOCK_FILE)).unwrap();
        match ProjectLock::try_lock(directory.path(), "restore") {
            Err(LockError::AlreadyLocked(info)) => assert_eq!(info.pid, legacy.id()),
            _ => panic!("live legacy owner must block acquisition"),
        }
        assert_eq!(
            ProjectLock::force_unlock(directory.path())
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert_eq!(
            std::fs::read(directory.path().join(LOCK_FILE)).unwrap(),
            before
        );
        std::fs::write(directory.path().join("release"), b"").unwrap();
        assert!(legacy.wait().unwrap().success());
        ProjectLock::try_lock(directory.path(), "after-legacy-exit")
            .unwrap()
            .release();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn uncertain_or_permission_denied_process_probe_never_marks_legacy_owner_dead() {
        assert!(unix_probe_may_be_alive(
            false,
            b"kill: Operation not permitted"
        ));
        assert!(unix_probe_may_be_alive(false, b"unexpected probe error"));
        assert!(unix_probe_may_be_alive(false, b""));
        assert!(!unix_probe_may_be_alive(
            false,
            b"kill: (1234): No such process"
        ));
        assert!(unix_probe_may_be_alive(true, b""));
        assert!(is_process_alive(u32::MAX));
    }

    #[test]
    fn process_lock_contender() {
        let Some(directory) = std::env::var_os("METORIGIN_LOCK_TEST_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !directory.join("start").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "start barrier timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        match ProjectLock::try_lock(&directory, "contender") {
            Ok(_guard) => {
                std::fs::write(
                    directory.join(format!("winner.{}", std::process::id())),
                    b"",
                )
                .unwrap();
                while !directory.join("release").exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "release barrier timed out"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
            Err(LockError::AlreadyLocked(_) | LockError::Busy) => {
                std::fs::write(directory.join(format!("loser.{}", std::process::id())), b"")
                    .unwrap();
            }
            Err(error) => panic!("unexpected contender failure: {error}"),
        }
    }

    fn process_contention(stale: bool) {
        let directory = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        if stale {
            let mut dead = std::process::Command::new(&executable)
                .arg("--list")
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let pid = dead.id();
            assert!(dead.wait().unwrap().success());
            let info = LockInfo {
                pid,
                started_at: Utc::now(),
                stage: "dead-owner".into(),
            };
            std::fs::write(
                directory.path().join(LOCK_FILE),
                serde_json::to_vec(&info).unwrap(),
            )
            .unwrap();
        }
        let mut workers: Vec<_> = (0..8)
            .map(|_| {
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "lock::tests::process_lock_contender",
                        "--nocapture",
                    ])
                    .env("METORIGIN_LOCK_TEST_DIR", directory.path())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        std::fs::write(directory.path().join("start"), b"").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let winners = loop {
            let outcomes: Vec<_> = std::fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("winner.") || name.starts_with("loser."))
                .collect();
            if outcomes.len() == workers.len() {
                break outcomes
                    .into_iter()
                    .filter(|name| name.starts_with("winner."))
                    .collect::<Vec<_>>();
            }
            assert!(
                std::time::Instant::now() < deadline,
                "workers did not reach lock decision"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert_eq!(winners.len(), 1, "exactly one process may own a project");
        let owner = ProjectLock::read_lock_info(&directory.path().join(LOCK_FILE)).unwrap();
        assert_eq!(winners[0], format!("winner.{}", owner.pid));
        assert!(ProjectLock::try_lock(directory.path(), "parent").is_err());
        std::fs::write(directory.path().join("release"), b"").unwrap();
        for worker in &mut workers {
            assert!(worker.wait().unwrap().success());
        }
        ProjectLock::try_lock(directory.path(), "after-release")
            .unwrap()
            .release();
    }

    #[test]
    fn independent_processes_cannot_both_acquire_new_project() {
        process_contention(false);
    }

    #[test]
    fn simultaneous_stale_reclaimers_cannot_unlink_new_owner() {
        process_contention(true);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_owner_and_guard_symlinks_never_create_outside_files() {
        for filename in [LOCK_FILE, KERNEL_LOCK_FILE] {
            let directory = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let missing = outside.path().join("must-not-be-created");
            std::os::unix::fs::symlink(&missing, directory.path().join(filename)).unwrap();
            assert!(ProjectLock::try_lock(directory.path(), "restore").is_err());
            assert!(!missing.exists());
            assert!(std::fs::symlink_metadata(directory.path().join(filename))
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }

    #[test]
    fn corrupted_owner_metadata_is_preserved_without_implicit_unlock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(LOCK_FILE);
        std::fs::write(&path, "unrecognized metadata").unwrap();
        assert!(matches!(
            ProjectLock::try_lock(directory.path(), "training"),
            Err(LockError::Corrupted(_))
        ));
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "unrecognized metadata"
        );
    }

    #[test]
    fn changed_owner_metadata_is_not_deleted_on_guard_drop() {
        let directory = tempfile::tempdir().unwrap();
        let guard = ProjectLock::try_lock(directory.path(), "training").unwrap();
        std::fs::write(directory.path().join(LOCK_FILE), "replaced metadata").unwrap();
        drop(guard);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(LOCK_FILE)).unwrap(),
            "replaced metadata"
        );
    }

    #[test]
    fn test_lock_guard_must_use_attr() {
        // LockGuard has #[must_use] — it exists at compile time
        let _ = LockGuard {
            lock_path: PathBuf::from("/tmp/test.lock"),
            owner_json: Vec::new(),
            kernel_lock: None,
        };
    }
}
