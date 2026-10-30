//! Runtime evidence is independent of project v1 and is never inferred on load.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use splat_domain::{AppError, AppResult, ErrorCategory, ExecutionProfile};

const MAX_PROFILE_BYTES: usize = 64 * 1024;

pub fn execution_profile_path(project_dir: &Path) -> PathBuf {
    project_dir.join("runtime/execution-profile.json")
}

/// A missing profile is a supported legacy project. Corrupt or future evidence
/// is returned as an error without changing either file or project.json.
pub fn load_execution_profile(project_dir: &Path) -> AppResult<Option<ExecutionProfile>> {
    let path = execution_profile_path(project_dir);
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("read", error)),
    };
    let mut bytes = Vec::new();
    file.take((MAX_PROFILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("read", error))?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(AppError::new(
            "E-1402",
            ErrorCategory::User,
            "Execution Profile Too Large",
            "The execution profile exceeds the supported size limit.",
        ));
    }
    ExecutionProfile::from_json(&bytes).map(Some)
}

/// Publish a validated snapshot using a unique same-directory temporary file.
/// The caller holds the project run lock. Failed writes leave prior evidence intact.
pub fn save_execution_profile(project_dir: &Path, profile: &ExecutionProfile) -> AppResult<()> {
    profile.validate()?;
    // Do not overwrite unknown future schemas or corrupt diagnostic evidence.
    load_execution_profile(project_dir)?;
    let bytes = serde_json::to_vec_pretty(profile).map_err(|error| {
        AppError::new(
            "E-1402",
            ErrorCategory::User,
            "Invalid Execution Profile",
            "The execution profile could not be serialized.",
        )
        .with_technical(error.to_string())
    })?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(AppError::new(
            "E-1402",
            ErrorCategory::User,
            "Execution Profile Too Large",
            "The execution profile exceeds the supported size limit.",
        ));
    }
    let path = execution_profile_path(project_dir);
    let directory = path.parent().expect("execution profile has a parent");
    std::fs::create_dir_all(directory).map_err(|error| io_error("create directory", error))?;
    let temporary = directory.join(format!(".execution-profile-{}.tmp", uuid::Uuid::now_v7()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| io_error("create", error))?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| std::fs::rename(&temporary, &path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(temporary);
        return Err(io_error("save", error));
    }
    Ok(())
}

fn io_error(operation: &str, error: std::io::Error) -> AppError {
    AppError::new(
        "E-1404",
        ErrorCategory::Filesystem,
        "Execution Profile Unavailable",
        "The execution profile could not be read or saved. Project data was preserved.",
    )
    .with_technical(format!("{operation}: {error}"))
    .retryable(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ExecutionProfile {
        ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn missing_legacy_profile_does_not_modify_project() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("project.json"), b"legacy project bytes").unwrap();
        assert!(load_execution_profile(root.path()).unwrap().is_none());
        assert!(!root.path().join("runtime").exists());
        assert_eq!(
            std::fs::read(root.path().join("project.json")).unwrap(),
            b"legacy project bytes"
        );
    }

    #[test]
    fn roundtrip_and_replacement_preserve_project_v1() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project.json");
        std::fs::write(&project, b"project v1 bytes").unwrap();
        let mut profile = fixture();
        save_execution_profile(root.path(), &profile).unwrap();
        assert_eq!(
            load_execution_profile(root.path()).unwrap(),
            Some(profile.clone())
        );
        profile.run_id = uuid::Uuid::now_v7();
        save_execution_profile(root.path(), &profile).unwrap();
        assert_eq!(load_execution_profile(root.path()).unwrap(), Some(profile));
        assert_eq!(std::fs::read(project).unwrap(), b"project v1 bytes");
        assert_eq!(
            std::fs::read_dir(root.path().join("runtime"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn future_and_corrupt_profiles_are_preserved() {
        for bytes in [b"{\"schema_version\":2}".as_slice(), b"truncated json"] {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("runtime")).unwrap();
            let path = execution_profile_path(root.path());
            std::fs::write(&path, bytes).unwrap();
            assert!(load_execution_profile(root.path()).is_err());
            assert!(save_execution_profile(root.path(), &fixture()).is_err());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn invalid_new_profile_cannot_replace_existing_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut profile = fixture();
        save_execution_profile(root.path(), &profile).unwrap();
        let before = std::fs::read(execution_profile_path(root.path())).unwrap();
        profile.effective_training.threads = 0;
        assert!(save_execution_profile(root.path(), &profile).is_err());
        assert_eq!(
            std::fs::read(execution_profile_path(root.path())).unwrap(),
            before
        );
    }

    #[test]
    fn oversized_profile_is_rejected_with_bounded_read() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("runtime")).unwrap();
        std::fs::write(
            execution_profile_path(root.path()),
            vec![b' '; MAX_PROFILE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            load_execution_profile(root.path()).unwrap_err().code,
            "E-1402"
        );
    }
}
