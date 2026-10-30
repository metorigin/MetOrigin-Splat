use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use splat_domain::error::{AppError, AppResult, ErrorCategory};

use crate::export::ExportManager;

/// A training checkpoint from Brush.
///
/// Represents a saved model state at a specific training iteration,
/// which can be used for recovery or export.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Checkpoint {
    /// Training iteration number
    pub iteration: u32,
    /// Path to the checkpoint file
    pub path: PathBuf,
    /// Size of the checkpoint file in bytes
    pub size_bytes: u64,
    /// When the checkpoint was created
    pub created_at: DateTime<Utc>,
}

/// Scans training output directories for checkpoint files.
///
/// Brush v0.3.0 and v1.x checkpoints are exported PLY snapshots named
/// `checkpoint_{iter}.ply`. They contain geometry but not optimizer state.
pub struct CheckpointScanner;

impl CheckpointScanner {
    /// Scan a directory for all checkpoint files.
    ///
    /// Returns an empty vector if the directory doesn't exist or no
    /// checkpoints are found.
    pub fn scan(training_dir: &Path) -> AppResult<Vec<Checkpoint>> {
        let mut valid = Vec::new();
        for checkpoint in Self::candidates(training_dir)? {
            if Self::is_complete(&checkpoint)? {
                valid.push(checkpoint);
            }
        }
        Ok(valid)
    }

    fn candidates(training_dir: &Path) -> AppResult<Vec<Checkpoint>> {
        let mut checkpoints = Vec::new();
        let reader = match std::fs::read_dir(training_dir) {
            Ok(reader) => reader,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(checkpoints),
            Err(error) => return Err(scan_io_error(error)),
        };
        for entry in reader {
            let entry = entry.map_err(scan_io_error)?;
            let path = entry.path();
            if let Some(iteration) = parse_checkpoint_filename(&path) {
                let meta = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(scan_io_error(error)),
                };
                if !meta.is_file() {
                    continue;
                }
                let size = meta.len();
                let created = meta
                    .created()
                    .ok()
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(Utc::now);

                checkpoints.push(Checkpoint {
                    iteration,
                    path,
                    size_bytes: size,
                    created_at: created,
                });
            }
        }

        // Sort by iteration number ascending
        checkpoints.sort_by_key(|a| a.iteration);

        Ok(checkpoints)
    }

    fn is_complete(checkpoint: &Checkpoint) -> AppResult<bool> {
        match ExportManager::validate_ply(&checkpoint.path) {
            Ok(()) => Ok(true),
            Err(error) if error.category == ErrorCategory::Engine => {
                // Writers may still be publishing a new file. Preserve it and
                // the last valid older checkpoint; never delete user artifacts.
                tracing::debug!(iteration = checkpoint.iteration, code = %error.code,
                    "Ignoring incomplete or invalid Brush checkpoint");
                Ok(false)
            }
            Err(error) => {
                // A file can disappear between directory enumeration and open.
                // Other I/O errors (in particular permission denial) must remain
                // actionable rather than pretending that recovery data is absent.
                if !checkpoint.path.try_exists().map_err(scan_io_error)? {
                    Ok(false)
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Find the highest iteration whose complete Gaussian payload is valid.
    pub fn find_latest(training_dir: &Path) -> AppResult<Option<Checkpoint>> {
        // Polling during training must not re-read every historical large PLY.
        for checkpoint in Self::candidates(training_dir)?.into_iter().rev() {
            if Self::is_complete(&checkpoint)? {
                return Ok(Some(checkpoint));
            }
        }
        Ok(None)
    }

    /// Check whether there are any resumable checkpoints.
    pub fn has_resumable(training_dir: &Path) -> bool {
        match Self::find_latest(training_dir) {
            Ok(checkpoint) => checkpoint.is_some(),
            Err(error) => {
                tracing::warn!(code = %error.code, "Could not inspect Brush recovery checkpoints");
                false
            }
        }
    }

    /// Get the latest complete iteration; Brush itself handles the next step.
    /// Returns 0 if no checkpoint exists (start from scratch).
    pub fn resume_iteration(training_dir: &Path) -> AppResult<u32> {
        let latest = Self::find_latest(training_dir)?;
        Ok(latest.map(|c| c.iteration).unwrap_or(0))
    }
}

fn scan_io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Read Training Checkpoints",
        "The checkpoint directory could not be inspected. Check its availability and permissions.",
    )
    .with_technical(error.to_string())
}

/// Parse the iteration number from a checkpoint file name.
///
/// Supports the verified Brush v0.3.0 `checkpoint_000500.ply` pattern.
fn parse_checkpoint_filename(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;
    let ext = path.extension()?.to_str()?;
    if !ext.eq_ignore_ascii_case("ply") {
        return None;
    }
    stem.strip_prefix("checkpoint_")?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_checkpoint(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(
            &path,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
            )),
        )
        .unwrap();
        path
    }

    #[test]
    fn test_parse_checkpoint_ply() {
        let path = Path::new("checkpoint_007000.ply");
        assert_eq!(parse_checkpoint_filename(path), Some(7000));
    }

    #[test]
    fn test_parse_skips_unverified_ply() {
        let path = Path::new("point_cloud.ply");
        assert!(parse_checkpoint_filename(path).is_none());
    }

    #[test]
    fn test_parse_skips_txt() {
        let path = Path::new("readme.txt");
        assert!(parse_checkpoint_filename(path).is_none());
    }

    #[test]
    fn test_scan_empty_directory() {
        let dir = std::env::temp_dir().join("splat-brush-cp-empty");
        let _ = std::fs::create_dir_all(&dir);
        let cps = CheckpointScanner::scan(&dir).unwrap();
        assert!(cps.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_nonexistent_directory() {
        let cps = CheckpointScanner::scan(Path::new("/nonexistent/checkpoints")).unwrap();
        assert!(cps.is_empty());
    }

    #[test]
    fn test_scan_finds_checkpoints() {
        let dir = std::env::temp_dir().join("splat-brush-cp-find");
        let _ = std::fs::create_dir_all(&dir);

        create_checkpoint(&dir, "checkpoint_001000.ply");
        create_checkpoint(&dir, "checkpoint_003000.ply");
        create_checkpoint(&dir, "checkpoint_007000.ply");
        create_checkpoint(&dir, "readme.txt"); // should be ignored

        let cps = CheckpointScanner::scan(&dir).unwrap();
        assert_eq!(cps.len(), 3);
        assert_eq!(cps[0].iteration, 1000);
        assert_eq!(cps[1].iteration, 3000);
        assert_eq!(cps[2].iteration, 7000);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_latest() {
        let dir = std::env::temp_dir().join("splat-brush-cp-latest");
        let _ = std::fs::create_dir_all(&dir);

        create_checkpoint(&dir, "checkpoint_001000.ply");
        create_checkpoint(&dir, "checkpoint_007000.ply");
        create_checkpoint(&dir, "checkpoint_003000.ply");

        let latest = CheckpointScanner::find_latest(&dir).unwrap().unwrap();
        assert_eq!(latest.iteration, 7000);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_has_resumable() {
        let dir = std::env::temp_dir().join("splat-brush-cp-resume");
        let _ = std::fs::create_dir_all(&dir);

        assert!(!CheckpointScanner::has_resumable(&dir));

        create_checkpoint(&dir, "checkpoint_001000.ply");
        assert!(CheckpointScanner::has_resumable(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resume_iteration() {
        let dir = std::env::temp_dir().join("splat-brush-cp-ri");
        let _ = std::fs::create_dir_all(&dir);

        // No checkpoints → resume from 0
        assert_eq!(CheckpointScanner::resume_iteration(&dir).unwrap(), 0);

        create_checkpoint(&dir, "checkpoint_005000.ply");
        // Has checkpoint 5000 → resume from 5000 (not 5001, since Brush handles it)
        assert_eq!(CheckpointScanner::resume_iteration(&dir).unwrap(), 5000);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_newest_checkpoint_falls_back_without_deleting_either_file() {
        let directory = tempfile::tempdir().unwrap();
        let old = create_checkpoint(directory.path(), "checkpoint_000100.ply");
        let new = directory.path().join("checkpoint_000200.ply");
        std::fs::write(
            &new,
            b"ply\nformat binary_little_endian 1.0\nelement vertex 20\n",
        )
        .unwrap();
        let selected = CheckpointScanner::find_latest(directory.path())
            .unwrap()
            .unwrap();
        assert_eq!(selected.iteration, 100);
        assert_eq!(CheckpointScanner::scan(directory.path()).unwrap().len(), 1);
        assert!(old.exists() && new.exists());
        assert_eq!(
            std::fs::read(&new).unwrap(),
            b"ply\nformat binary_little_endian 1.0\nelement vertex 20\n"
        );
        create_checkpoint(directory.path(), "checkpoint_000200.ply");
        assert_eq!(
            CheckpointScanner::resume_iteration(directory.path()).unwrap(),
            200
        );
    }

    #[test]
    fn a_directory_full_of_corrupt_files_is_not_resumable() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("checkpoint_000300.ply"),
            b"not a model",
        )
        .unwrap();
        assert!(!CheckpointScanner::has_resumable(directory.path()));
        assert!(CheckpointScanner::find_latest(directory.path())
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn directory_io_errors_are_not_hidden_as_missing_checkpoints() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-directory");
        std::fs::write(&file, b"keep").unwrap();
        let error = CheckpointScanner::scan(&file).unwrap_err();
        assert_eq!(error.category, ErrorCategory::Filesystem);
        assert_eq!(error.code, "E-1201");
        assert_eq!(std::fs::read(file).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_checkpoint_is_actionable_instead_of_silent_fallback() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        create_checkpoint(directory.path(), "checkpoint_000100.ply");
        let new = create_checkpoint(directory.path(), "checkpoint_000200.ply");
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&new).is_err() {
            assert_eq!(
                CheckpointScanner::find_latest(directory.path())
                    .unwrap_err()
                    .category,
                ErrorCategory::Filesystem
            );
        }
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(new.exists());
    }
}
