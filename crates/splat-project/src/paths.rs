use std::path::{Path, PathBuf};

/// Standard subdirectory names within a `.splat-project` directory.
pub const DIR_SOURCE: &str = "source";
pub const DIR_FRAMES: &str = "frames";
pub const DIR_PROCESSED: &str = "processed";
pub const DIR_COLMAP: &str = "colmap";
pub const DIR_TRAINING: &str = "training";
pub const DIR_OUTPUT: &str = "output";
pub const DIR_CACHE: &str = "cache";
pub const DIR_LOGS: &str = "logs";
pub const FILE_PROJECT_JSON: &str = "project.json";
pub const FILE_FRAMES_MANIFEST: &str = "frames.json";
pub const FILE_OUTPUT_MANIFEST: &str = "manifest.json";

/// Return the `project.json` path for a project directory.
pub fn project_json_path(project_dir: &Path) -> PathBuf {
    project_dir.join(FILE_PROJECT_JSON)
}

/// Return the source media directory path.
pub fn source_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_SOURCE)
}

/// Return the extracted frames directory path.
pub fn frames_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_FRAMES)
}

/// Return the preprocessed images directory path.
pub fn processed_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_PROCESSED)
}

/// Return the COLMAP working directory path.
pub fn colmap_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_COLMAP)
}

/// Return the training artifacts directory path.
pub fn training_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_TRAINING)
}

/// Return the output directory path.
pub fn output_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_OUTPUT)
}

/// Return the cache directory path.
pub fn cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_CACHE)
}

/// Return the logs directory path.
pub fn logs_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_LOGS)
}

/// Return the frames manifest path.
pub fn frames_manifest_path(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_FRAMES).join(FILE_FRAMES_MANIFEST)
}

/// Return the output manifest path.
pub fn output_manifest_path(project_dir: &Path) -> PathBuf {
    project_dir.join(DIR_OUTPUT).join(FILE_OUTPUT_MANIFEST)
}

/// Create all required project subdirectories.
pub fn create_project_directories(project_dir: &Path) -> std::io::Result<()> {
    for dir in &[
        source_dir(project_dir),
        frames_dir(project_dir),
        processed_dir(project_dir),
        colmap_dir(project_dir),
        training_dir(project_dir),
        output_dir(project_dir),
        cache_dir(project_dir),
        logs_dir(project_dir),
    ] {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths_relative_to_project() {
        let project_dir = Path::new("/projects/test.splat-project");

        assert!(project_json_path(project_dir).ends_with("project.json"));
        assert!(source_dir(project_dir).ends_with("source"));
        assert!(frames_dir(project_dir).ends_with("frames"));
        assert!(colmap_dir(project_dir).ends_with("colmap"));
        assert!(training_dir(project_dir).ends_with("training"));
        assert!(output_dir(project_dir).ends_with("output"));
        assert!(cache_dir(project_dir).ends_with("cache"));
        assert!(logs_dir(project_dir).ends_with("logs"));
    }

    #[test]
    fn test_all_directories_unique() {
        let project_dir = Path::new("/test");
        let paths = vec![
            source_dir(project_dir),
            frames_dir(project_dir),
            processed_dir(project_dir),
            colmap_dir(project_dir),
            training_dir(project_dir),
            output_dir(project_dir),
            cache_dir(project_dir),
            logs_dir(project_dir),
        ];
        let mut unique = paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            paths.len(),
            unique.len(),
            "all directory paths must be unique"
        );
    }
}
