//! Preflight probes only a new, exclusively owned file; it never creates a
//! directory tree or changes permissions. Project creation still handles races.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Inspect,
    NotDirectory,
    Write,
    Cleanup,
}

#[derive(Debug)]
pub(super) struct DestinationError {
    failure: Failure,
    pub(super) path: PathBuf,
    pub(super) source: io::Error,
}

impl DestinationError {
    fn new(failure: Failure, path: &Path, source: io::Error) -> Self {
        Self {
            failure,
            path: path.to_owned(),
            source,
        }
    }

    pub(super) fn code(&self) -> &'static str {
        match self.failure {
            Failure::Inspect => "UI-PROJECT-DESTINATION-INSPECT",
            Failure::NotDirectory => "UI-PROJECT-DESTINATION-NOT-DIRECTORY",
            Failure::Write => "UI-PROJECT-DESTINATION-WRITE",
            Failure::Cleanup => "UI-PROJECT-DESTINATION-CLEANUP",
        }
    }

    pub(super) fn user_message(&self) -> String {
        let path = self.path.display();
        match self.failure {
            Failure::Inspect => {
                format!("无法检查项目目标目录：{path}。请确认目录存在且当前账户有访问权限。")
            }
            Failure::NotDirectory => format!("项目目标位置不是目录：{path}。请选择可写文件夹。"),
            Failure::Write => format!(
                "项目目标目录不可写：{path}。请更换目录，或检查当前账户权限与磁盘只读状态。"
            ),
            Failure::Cleanup => {
                format!("无法删除项目目录中的检查文件：{path}。请清理该文件并检查目录权限后重试。")
            }
        }
    }
}

fn existing_directory(path: &Path) -> Result<PathBuf, DestinationError> {
    let mut current = std::path::absolute(path)
        .map_err(|error| DestinationError::new(Failure::Inspect, path, error))?;
    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                // Preserve valid directory aliases. A dangling symlink is an
                // existing obstruction, not a missing directory to skip over.
                let metadata = if metadata.file_type().is_symlink() {
                    std::fs::metadata(&current)
                        .map_err(|error| DestinationError::new(Failure::Inspect, &current, error))?
                } else {
                    metadata
                };
                if !metadata.is_dir() {
                    return Err(DestinationError::new(
                        Failure::NotDirectory,
                        &current,
                        io::Error::from(io::ErrorKind::NotADirectory),
                    ));
                }
                return Ok(current);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !current.pop() {
                    return Err(DestinationError::new(Failure::Inspect, path, error));
                }
            }
            Err(error) => {
                let failure = if error.kind() == io::ErrorKind::NotADirectory {
                    Failure::NotDirectory
                } else {
                    Failure::Inspect
                };
                return Err(DestinationError::new(failure, &current, error));
            }
        }
    }
}

pub(super) fn check_project_destination(path: &Path) -> Result<PathBuf, DestinationError> {
    let directory = existing_directory(path)?;
    let probe = directory.join(format!(
        ".metorigin-write-probe-{}.tmp",
        uuid::Uuid::now_v7()
    ));
    probe_file(
        &probe,
        |file| {
            file.write_all(b"MetOrigin project destination write check\n")?;
            file.sync_all()
        },
        |path| std::fs::remove_file(path),
    )?;
    Ok(directory)
}

fn probe_file(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    remove: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), DestinationError> {
    // create_new prevents overwriting existing files and symlink targets. A
    // failed open gives us no ownership and therefore no cleanup permission.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            DestinationError::new(Failure::Write, path.parent().unwrap_or(path), error)
        })?;
    let written = write(&mut file);
    drop(file); // Required before deleting on Windows; attempt cleanup even after a write failure.
    remove(path).map_err(|error| DestinationError::new(Failure::Cleanup, path, error))?;
    written.map_err(|error| {
        DestinationError::new(Failure::Write, path.parent().unwrap_or(path), error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("metorigin-destination-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn existing_writable_destination_is_checked_without_residue() {
        let root = TestDirectory::new();
        std::fs::write(root.0.join("keep.txt"), b"user data").unwrap();
        assert_eq!(check_project_destination(&root.0).unwrap(), root.0);
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(root.0.join("keep.txt")).unwrap(),
            b"user data"
        );
    }

    #[test]
    fn missing_nested_destination_only_probes_the_nearest_existing_directory() {
        let root = TestDirectory::new();
        let destination = root.0.join("new/nested/project-root");
        assert_eq!(check_project_destination(&destination).unwrap(), root.0);
        assert!(!root.0.join("new").exists());
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn existing_file_and_paths_beneath_it_are_rejected_without_changes() {
        let root = TestDirectory::new();
        let file = root.0.join("file");
        std::fs::write(&file, b"retain").unwrap();
        for path in [&file, &file.join("child")] {
            assert_eq!(
                check_project_destination(path).unwrap_err().failure,
                Failure::NotDirectory
            );
        }
        assert_eq!(std::fs::read(&file).unwrap(), b"retain");
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
    }

    #[test]
    fn probe_collision_never_overwrites_or_removes_the_existing_file() {
        let root = TestDirectory::new();
        let path = root.0.join("existing-probe");
        std::fs::write(&path, b"retain").unwrap();
        let error = probe_file(
            &path,
            |_| panic!("must not write"),
            |_| panic!("must not delete"),
        )
        .unwrap_err();
        assert_eq!(error.failure, Failure::Write);
        assert_eq!(error.source.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(path).unwrap(), b"retain");
    }

    #[test]
    fn failed_write_still_removes_our_probe() {
        let root = TestDirectory::new();
        let path = root.0.join("probe");
        let error = probe_file(
            &path,
            |_| Err(io::Error::from(io::ErrorKind::WriteZero)),
            |path| std::fs::remove_file(path),
        )
        .unwrap_err();
        assert_eq!(error.failure, Failure::Write);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_failure_blocks_preflight_and_identifies_only_our_probe() {
        let root = TestDirectory::new();
        for write_fails in [false, true] {
            let path = root.0.join(format!("probe-{write_fails}"));
            let error = probe_file(
                &path,
                |file| {
                    if write_fails {
                        Err(io::Error::from(io::ErrorKind::WriteZero))
                    } else {
                        file.write_all(b"probe")
                    }
                },
                |_| Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            )
            .unwrap_err();
            assert_eq!(error.code(), "UI-PROJECT-DESTINATION-CLEANUP");
            assert_eq!(error.path, path);
            assert!(error.user_message().contains(&path.display().to_string()));
            assert!(path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_0555_destination_and_missing_child_are_rejected_without_probe_residue() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = TestDirectory::new();
        if std::fs::metadata(&root.0).unwrap().uid() == 0 {
            eprintln!("root can bypass mode 0555; effective permission-denial regression requires a non-root user");
            return;
        }
        std::fs::set_permissions(&root.0, std::fs::Permissions::from_mode(0o555)).unwrap();
        let results = [
            check_project_destination(&root.0),
            check_project_destination(&root.0.join("missing/child")),
        ];
        std::fs::set_permissions(&root.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        for result in results {
            let error = result.unwrap_err();
            assert_eq!(error.code(), "UI-PROJECT-DESTINATION-WRITE");
            assert_eq!(error.source.kind(), io::ErrorKind::PermissionDenied);
        }
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn directory_aliases_work_but_dangling_aliases_are_not_skipped() {
        use std::os::unix::fs::symlink;
        let root = TestDirectory::new();
        let valid = root.0.join("valid");
        std::fs::create_dir(&valid).unwrap();
        let alias = root.0.join("alias");
        symlink(&valid, &alias).unwrap();
        assert_eq!(check_project_destination(&alias).unwrap(), alias);
        assert_eq!(std::fs::read_dir(&valid).unwrap().count(), 0);
        let dangling = root.0.join("dangling");
        symlink(root.0.join("missing"), &dangling).unwrap();
        assert_eq!(
            check_project_destination(&dangling).unwrap_err().failure,
            Failure::Inspect
        );
        assert_eq!(
            check_project_destination(&dangling.join("child"))
                .unwrap_err()
                .failure,
            Failure::Inspect
        );
        assert!(!root.0.join("missing").exists());
    }
}
