//! On-demand model snapshots, separate from recoverable training checkpoints.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PROTOCOL: u32 = 1;
pub const DIRECTORY: &str = "training/live-preview";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub protocol: u32,
    pub session_id: String,
    pub available: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub protocol: u32,
    pub session_id: String,
    pub revision: u64,
    pub iteration: u32,
    pub splat_count: u32,
    pub relative_path: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub session_id: String,
    pub after_revision: u64,
    pub mode: String,
    pub expires_at_ms: u64,
}

/// Marks the session stopped even when the engine fails to launch or is cancelled.
pub struct LiveSession {
    pub session: Session,
    pub directory: PathBuf,
    root: PathBuf,
}

impl LiveSession {
    pub fn start(project_dir: &Path, available: bool) -> std::io::Result<Self> {
        let project_dir = project_dir.canonicalize()?;
        let root = project_dir.join(DIRECTORY);
        // Do not follow an existing training/cache junction out of the project.
        let training = project_dir.join("training");
        std::fs::create_dir_all(&training)?;
        if !training.canonicalize()?.starts_with(&project_dir) {
            return Err(std::io::Error::other("Training directory escapes project"));
        }
        std::fs::create_dir_all(&root)?;
        if !root.canonicalize()?.starts_with(&project_dir) {
            return Err(std::io::Error::other(
                "Live preview directory escapes project",
            ));
        }
        let session = Session {
            protocol: PROTOCOL,
            session_id: uuid::Uuid::now_v7().to_string(),
            available,
            running: true,
        };
        let directory = root.join(&session.session_id);
        std::fs::create_dir(&directory)?;
        write_json_atomic(&root.join("session.json"), &session)?;
        Ok(Self {
            session,
            directory,
            root,
        })
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.session.running = false;
        let _ = write_json_atomic(&self.root.join("session.json"), &self.session);
    }
}

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    std::fs::write(&temporary, serde_json::to_vec(value)?)?;
    let result = std::fs::rename(&temporary, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_are_isolated_and_close_on_drop() {
        let project = tempfile::tempdir().unwrap();
        let first_id = {
            let session = LiveSession::start(project.path(), true).unwrap();
            assert!(session.directory.is_dir());
            session.session.session_id.clone()
        };
        let stopped: Session = serde_json::from_slice(
            &std::fs::read(project.path().join(DIRECTORY).join("session.json")).unwrap(),
        )
        .unwrap();
        assert!(!stopped.running);
        let next = LiveSession::start(project.path(), true).unwrap();
        assert_ne!(first_id, next.session.session_id);
        assert!(!next.directory.join("latest.json").exists());
    }
}
