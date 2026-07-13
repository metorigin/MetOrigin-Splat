use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use splat_domain::error::AppResult;

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
/// # Checkpoint File Naming (⚠️ Verify with actual Brush)
///
/// Brush checkpoints may follow these naming patterns:
/// - `ckpt_{iteration}.pth`  (e.g. ckpt_7000.pth)
/// - `checkpoint_{iteration}.pt` (e.g. checkpoint_7000.pt)
/// - `{iteration}.pt` (e.g. 7000.pt)
///
/// These patterns are configurable and should be verified against the
/// pinned Brush version's actual output format.
pub struct CheckpointScanner;

impl CheckpointScanner {
    /// Scan a directory for all checkpoint files.
    ///
    /// Returns an empty vector if the directory doesn't exist or no
    /// checkpoints are found.
    pub fn scan(training_dir: &Path) -> AppResult<Vec<Checkpoint>> {
        if !training_dir.exists() {
            return Ok(Vec::new());
        }

        let mut checkpoints = Vec::new();

        let reader = std::fs::read_dir(training_dir).map_err(|e| {
            splat_domain::error::AppError::new(
                "E-1201",
                splat_domain::error::ErrorCategory::Filesystem,
                "Failed to Read Training Directory",
                format!(
                    "Could not read training directory '{}': {}",
                    training_dir.display(),
                    e
                ),
            )
        })?;

        for entry in reader.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            if let Some(iteration) = parse_checkpoint_filename(&path) {
                let meta = match std::fs::metadata(&path) {
                    Ok(m) => m,
                    _ => continue,
                };

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

    /// Find the latest (highest iteration) checkpoint.
    pub fn find_latest(training_dir: &Path) -> AppResult<Option<Checkpoint>> {
        let cps = Self::scan(training_dir)?;
        Ok(cps.into_iter().last())
    }

    /// Check whether there are any resumable checkpoints.
    pub fn has_resumable(training_dir: &Path) -> bool {
        Self::scan(training_dir)
            .ok()
            .map(|c| !c.is_empty())
            .unwrap_or(false)
    }

    /// Get the iteration number to resume from (latest + 1).
    /// Returns 0 if no checkpoint exists (start from scratch).
    pub fn resume_iteration(training_dir: &Path) -> AppResult<u32> {
        let latest = Self::find_latest(training_dir)?;
        Ok(latest.map(|c| c.iteration).unwrap_or(0))
    }
}

/// Parse the iteration number from a checkpoint file name.
///
/// ⚠️ Naming patterns must be verified against the actual Brush version.
///
/// Supports these patterns:
/// - `ckpt_7000.pth` → 7000
/// - `ckpt_7000.pt` → 7000
/// - `checkpoint_7000.pth` → 7000
/// - `checkpoint_7000.pt` → 7000
/// - `7000.pth` → 7000
/// - `7000.pt` → 7000
/// - `point_cloud.ply` → skipped (not a checkpoint)
fn parse_checkpoint_filename(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;

    // Check recognized extensions
    let ext = path.extension()?.to_str()?;
    if ext != "pth" && ext != "pt" && ext != "ckpt" {
        return None;
    }

    // Try "ckpt_{N}" pattern
    if let Some(num_str) = stem.strip_prefix("ckpt_") {
        if let Ok(n) = num_str.parse::<u32>() {
            return Some(n);
        }
    }

    // Try "checkpoint_{N}" pattern
    if let Some(num_str) = stem.strip_prefix("checkpoint_") {
        if let Ok(n) = num_str.parse::<u32>() {
            return Some(n);
        }
    }

    // Try plain number pattern
    if let Ok(n) = stem.parse::<u32>() {
        return Some(n);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_checkpoint(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"fake checkpoint data").unwrap();
        path
    }

    #[test]
    fn test_parse_ckpt_pth() {
        let path = Path::new("ckpt_7000.pth");
        assert_eq!(parse_checkpoint_filename(path), Some(7000));
    }

    #[test]
    fn test_parse_ckpt_pt() {
        let path = Path::new("ckpt_3000.pt");
        assert_eq!(parse_checkpoint_filename(path), Some(3000));
    }

    #[test]
    fn test_parse_checkpoint_pth() {
        let path = Path::new("checkpoint_1000.pth");
        assert_eq!(parse_checkpoint_filename(path), Some(1000));
    }

    #[test]
    fn test_parse_plain_number() {
        let path = Path::new("5000.pth");
        assert_eq!(parse_checkpoint_filename(path), Some(5000));
    }

    #[test]
    fn test_parse_skips_ply() {
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

        create_checkpoint(&dir, "ckpt_1000.pth");
        create_checkpoint(&dir, "ckpt_3000.pth");
        create_checkpoint(&dir, "ckpt_7000.pth");
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

        create_checkpoint(&dir, "ckpt_1000.pth");
        create_checkpoint(&dir, "ckpt_7000.pth");
        create_checkpoint(&dir, "ckpt_3000.pth");

        let latest = CheckpointScanner::find_latest(&dir).unwrap().unwrap();
        assert_eq!(latest.iteration, 7000);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_has_resumable() {
        let dir = std::env::temp_dir().join("splat-brush-cp-resume");
        let _ = std::fs::create_dir_all(&dir);

        assert!(!CheckpointScanner::has_resumable(&dir));

        create_checkpoint(&dir, "ckpt_1000.pth");
        assert!(CheckpointScanner::has_resumable(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resume_iteration() {
        let dir = std::env::temp_dir().join("splat-brush-cp-ri");
        let _ = std::fs::create_dir_all(&dir);

        // No checkpoints → resume from 0
        assert_eq!(CheckpointScanner::resume_iteration(&dir).unwrap(), 0);

        create_checkpoint(&dir, "ckpt_5000.pth");
        // Has checkpoint 5000 → resume from 5000 (not 5001, since Brush handles it)
        assert_eq!(CheckpointScanner::resume_iteration(&dir).unwrap(), 5000);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
