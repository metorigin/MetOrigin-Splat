use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// File name for the project lock.
const LOCK_FILE: &str = ".lock";

/// Status of a project lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockStatus {
    /// No lock exists — project is free.
    Unlocked,
    /// Lock is held by a running process.
    Locked {
        pid: u32,
        started_at: DateTime<Utc>,
        stage: String,
    },
    /// Lock file exists but the owning process is dead.
    Stale { pid: u32, started_at: DateTime<Utc> },
}

/// Errors that can occur when acquiring a project lock.
#[derive(Debug)]
pub enum LockError {
    /// Lock is already held by another running process.
    AlreadyLocked(LockInfo),
    /// An I/O error occurred (permissions, disk full, etc.).
    Io(std::io::Error),
    /// Lock file has invalid format.
    Corrupted(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked(info) => {
                write!(
                    f,
                    "Project is locked by PID {} since {} (stage: {})",
                    info.pid, info.started_at, info.stage
                )
            }
            Self::Io(e) => write!(f, "Lock I/O error: {}", e),
            Self::Corrupted(msg) => write!(f, "Corrupted lock file: {}", msg),
        }
    }
}

impl std::error::Error for LockError {}

/// Content of the `.lock` file stored inside a project directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    /// Process ID that owns the lock.
    pub pid: u32,
    /// When the lock was acquired.
    pub started_at: DateTime<Utc>,
    /// Which pipeline stage is currently running.
    pub stage: String,
}

/// RAII guard that releases the lock on drop.
///
/// # Example
///
/// ```ignore
/// let guard = ProjectLock::try_lock(project_dir, "frame_extraction")?;
/// // ... do work ...
/// drop(guard); // lock file is automatically removed
/// ```
#[must_use = "Lock guard will be dropped immediately; hold it for the duration of the pipeline"]
pub struct LockGuard {
    lock_path: PathBuf,
    released: Arc<AtomicBool>,
}

impl LockGuard {
    /// Explicitly release the lock before drop.
    pub fn release(self) {
        self.released.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if !self.released.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&self.lock_path);
        }
    }
}

/// File-system based project lock to prevent concurrent pipeline execution.
///
/// Works by creating a `.lock` file in the project directory with metadata
/// about the owning process. The lock is automatically released when the
/// `LockGuard` is dropped.
pub struct ProjectLock;

impl ProjectLock {
    /// Try to acquire the project lock.
    ///
    /// Returns `Ok(LockGuard)` on success. The guard will automatically
    /// release the lock when dropped.
    ///
    /// # Errors
    ///
    /// Returns `LockError::AlreadyLocked` if another process holds the lock.
    /// Returns `LockError::Io` if filesystem operations fail.
    /// Returns `LockError::Corrupted` if the lock file is unparseable.
    ///
    /// If a stale lock (process no longer exists) is detected, it is
    /// automatically cleaned up and a new lock is created.
    pub fn try_lock(project_dir: &Path, stage: &str) -> Result<LockGuard, LockError> {
        let lock_path = project_dir.join(LOCK_FILE);

        // Check existing lock
        if lock_path.exists() {
            match Self::check(project_dir) {
                LockStatus::Locked { .. } => {
                    let content = Self::read_lock_info(&lock_path)
                        .ok_or_else(|| LockError::Corrupted("cannot parse lock".into()))?;
                    return Err(LockError::AlreadyLocked(content));
                }
                LockStatus::Stale { .. } => {
                    // Clean up stale lock
                    let _ = std::fs::remove_file(&lock_path);
                    tracing::warn!(
                        "Removed stale lock file from project '{}'",
                        project_dir.display()
                    );
                }
                LockStatus::Unlocked => {
                    // Lock file exists but empty — should not happen
                    let _ = std::fs::remove_file(&lock_path);
                }
            }
        }

        // Create new lock
        let info = LockInfo {
            pid: std::process::id(),
            started_at: Utc::now(),
            stage: stage.to_string(),
        };

        let json = serde_json::to_string(&info).map_err(|e| LockError::Corrupted(e.to_string()))?;

        std::fs::write(&lock_path, &json).map_err(LockError::Io)?;

        tracing::info!(
            "Lock acquired for project '{}' (pid={}, stage={})",
            project_dir.display(),
            info.pid,
            info.stage
        );

        Ok(LockGuard {
            lock_path,
            released: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Check the current lock status of a project.
    pub fn check(project_dir: &Path) -> LockStatus {
        let lock_path = project_dir.join(LOCK_FILE);

        if !lock_path.exists() {
            return LockStatus::Unlocked;
        }

        match Self::read_lock_info(&lock_path) {
            Some(info) => {
                if is_process_alive(info.pid) {
                    LockStatus::Locked {
                        pid: info.pid,
                        started_at: info.started_at,
                        stage: info.stage,
                    }
                } else {
                    LockStatus::Stale {
                        pid: info.pid,
                        started_at: info.started_at,
                    }
                }
            }
            None => LockStatus::Unlocked,
        }
    }

    /// Remove the lock file from a project directory.
    pub fn force_unlock(project_dir: &Path) -> Result<(), std::io::Error> {
        let lock_path = project_dir.join(LOCK_FILE);
        if lock_path.exists() {
            std::fs::remove_file(&lock_path)?;
            tracing::info!("Force-unlocked project '{}'", project_dir.display());
        }
        Ok(())
    }

    /// Read and parse the lock file contents.
    fn read_lock_info(lock_path: &Path) -> Option<LockInfo> {
        let content = std::fs::read_to_string(lock_path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

/// Check whether a process with the given PID is still alive.
///
/// On Unix, uses `kill -0`. On Windows, uses `tasklist /FI "PID eq <pid>"`.
fn is_process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
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
                stdout.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // kill(pid, 0) returns 0 if process exists, -1 if not
        let result = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output();
        match result {
            Ok(output) => output.status.success(),
            Err(_) => false,
        }
    }
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

        ProjectLock::force_unlock(&dir).unwrap();
        assert!(!dir.join(".lock").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_guard_must_use_attr() {
        // LockGuard has #[must_use] — it exists at compile time
        let _ = LockGuard {
            lock_path: PathBuf::from("/tmp/test.lock"),
            released: Arc::new(AtomicBool::new(false)),
        };
    }
}
