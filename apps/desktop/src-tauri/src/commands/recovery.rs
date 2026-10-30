//! Admission and recovery for projects left active by an earlier application.
//! Process observation supplements the project lock for legacy orphan engines;
//! it never grants ownership or terminates a process.

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

use splat_domain::{Project, ProjectStatus};
use splat_pipeline::{CrashRecovery, LockGuard, ProjectLock};
use splat_project::ProjectManager;
use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};

use crate::state::AppState;

pub(super) fn owns_active_project(state: &AppState, directory: &Path) -> Result<bool, String> {
    let inner = state
        .0
        .lock()
        .map_err(|_| "处理流程状态暂时不可用，请重启应用后重试。".to_string())?;
    Ok(inner
        .active_pipeline
        .as_ref()
        .is_some_and(|active| resolved_path(&active.project_dir) == resolved_path(directory)))
}

pub(super) fn acquire_project(directory: &Path, operation: &str) -> Result<LockGuard, String> {
    acquire_project_with(directory, operation, ensure_no_orphan_engine)
}

pub(super) fn open_project_for_view(
    manager: &ProjectManager,
    state: &AppState,
    directory: &Path,
) -> Result<(Project, Option<LockGuard>), String> {
    if !directory.join("project.json").is_file() {
        return Err("项目文件不存在，请重新打开有效项目。".into());
    }
    if owns_active_project(state, directory)? {
        return manager
            .open_project(directory)
            .map(|project| (project, None))
            .map_err(|error| error.user_message_zh());
    }
    let guard = acquire_project(directory, "project_open")?;
    let project = recover_project(manager, directory, &guard)?;
    Ok((project, Some(guard)))
}

fn acquire_project_with(
    directory: &Path,
    operation: &str,
    inspect: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<LockGuard, String> {
    // Diagnostic LockStatus is deliberately not used as authorization. A live
    // app or kernel guard blocks before any restoration or project.json write.
    let guard = ProjectLock::try_lock(directory, operation).map_err(|error| {
        tracing::warn!(%error, "project admission lock refused");
        "项目仍被其他操作或应用占用，或锁信息无法安全验证。请等待相关进程结束后重试。".to_string()
    })?;
    inspect(directory)?;
    Ok(guard)
}

/// Caller retains this exact project guard until all subsequent writes finish.
pub(super) fn recover_project(
    manager: &ProjectManager,
    directory: &Path,
    guard: &LockGuard,
) -> Result<Project, String> {
    if !guard.covers_project(directory) {
        return Err("项目恢复锁与项目目录不一致，请重新打开项目。".into());
    }
    // Future/corrupt runtime evidence must survive recovery unchanged.
    splat_project::load_execution_profile(directory).map_err(|error| error.user_message_zh())?;
    splat_pipeline::stages::brush_training::recover_checkpoint_restore_with_lock(directory, guard)
        .map_err(|error| error.user_message_zh())?;
    let mut project = manager
        .open_project(directory)
        .map_err(|error| error.user_message_zh())?;
    if interrupted(&project) {
        let recovered = CrashRecovery::detect(&project.pipeline_state, directory);
        project.pipeline_state = recovered.state;
        project.pipeline_state.current_stage = None;
        project.pipeline_state.refresh_overall_progress();
        project.current_stage = None;
        project.status = ProjectStatus::Paused;
        project.touch();
        manager
            .save_project(&project, directory)
            .map_err(|error| error.user_message_zh())?;
        tracing::info!(message = %recovered.message, "recovered interrupted project for resume");
    }
    Ok(project)
}

fn interrupted(project: &Project) -> bool {
    matches!(
        project.status,
        ProjectStatus::Starting
            | ProjectStatus::Running
            | ProjectStatus::Pausing
            | ProjectStatus::Cancelling
            | ProjectStatus::Recovering
    ) || project.current_stage.is_some()
        || project.pipeline_state.current_stage.is_some()
        || project
            .pipeline_state
            .stages
            .values()
            .any(|stage| stage.status.is_active())
}

#[derive(Debug)]
struct ObservedProcess {
    pid: u32,
    name: OsString,
    executable: Option<PathBuf>,
    cwd: Option<PathBuf>,
    args: Vec<OsString>,
}

fn ensure_no_orphan_engine(directory: &Path) -> Result<(), String> {
    // Do not read environment variables: only ownership-relevant public process
    // fields are needed, and refreshes must include argv on every new snapshot.
    let refresh = ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_cwd(UpdateKind::Always);
    let system = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh));
    if system
        .process(sysinfo::Pid::from_u32(std::process::id()))
        .is_none()
    {
        return Err("无法检查遗留引擎进程，项目尚未恢复。请稍后重试或重启应用。".into());
    }
    for (pid, process) in system.processes() {
        if pid.as_u32() == std::process::id() {
            continue;
        }
        let observed = ObservedProcess {
            pid: pid.as_u32(),
            name: process.name().to_owned(),
            executable: process.exe().map(Path::to_owned),
            cwd: process.cwd().map(Path::to_owned),
            args: process.cmd().to_vec(),
        };
        check_process(directory, &observed)?;
    }
    Ok(())
}

fn check_process(directory: &Path, process: &ObservedProcess) -> Result<(), String> {
    let engine = is_engine_name(&process.name)
        || process
            .executable
            .as_deref()
            .and_then(Path::file_name)
            .is_some_and(is_engine_name)
        || process
            .args
            .first()
            .and_then(|arg| Path::new(arg).file_name())
            .is_some_and(is_engine_name);
    if !engine {
        return Ok(());
    }
    let root = resolved_path(directory);
    let uses_project = process
        .cwd
        .as_deref()
        .is_some_and(|cwd| resolved_path(cwd).starts_with(&root))
        || process.args.iter().skip(1).any(|arg| {
            let value = arg
                .to_str()
                .filter(|text| text.starts_with('-'))
                .and_then(|text| text.split_once('=').map(|(_, value)| OsStr::new(value)))
                .unwrap_or(arg.as_os_str());
            let path = Path::new(value);
            if path.is_absolute() {
                resolved_path(path).starts_with(&root)
            } else {
                process
                    .cwd
                    .as_ref()
                    .is_some_and(|cwd| resolved_path(&cwd.join(path)).starts_with(&root))
            }
        });
    if uses_project {
        return Err(format!(
            "仍有引擎进程（PID {}）使用此项目。请先结束该进程或等待其退出，再重新打开项目；已有检查点已保留。",
            process.pid
        ));
    }
    // An engine with unreadable argv cannot be proven unrelated, even if its
    // cwd is elsewhere. Relative argv likewise needs a readable cwd.
    if process.args.len() < 2 || process.cwd.is_none() {
        return Err(format!(
            "无法确认引擎进程（PID {}）是否仍使用此项目，暂未恢复。请等待该引擎退出后重试。",
            process.pid
        ));
    }
    Ok(())
}

fn is_engine_name(name: &OsStr) -> bool {
    matches!(
        name.to_string_lossy()
            .to_ascii_lowercase()
            .trim_end_matches(".exe"),
        "brush" | "brush-cli" | "brush_live" | "brush-live" | "colmap" | "ffmpeg" | "ffprobe"
    )
}

fn resolved_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    // An engine may be about to create an output that does not exist yet. Resolve
    // its existing parent so aliases and symlinked project locations still match.
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if parent != path && !parent.as_os_str().is_empty() {
            return normalize_path(&resolved_path(parent).join(name));
        }
    }
    normalize_path(path)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_domain::{PipelineStageId, StageStatus};

    struct Fixture {
        root: PathBuf,
        directory: PathBuf,
        manager: ProjectManager,
    }

    impl Fixture {
        fn new(status: ProjectStatus, stage_status: StageStatus) -> Self {
            let root =
                std::env::temp_dir().join(format!("splat-admission-{}", uuid::Uuid::now_v7()));
            let manager = ProjectManager::new(root.clone());
            let (mut project, directory) = manager.create_project("恢复项目 with spaces").unwrap();
            project.status = status;
            project.current_stage = Some("BrushTraining".into());
            project.pipeline_state.current_stage = Some(PipelineStageId::BrushTraining);
            project.pipeline_state.overall_progress = 0.9;
            let stage = project
                .pipeline_state
                .stages
                .get_mut(&PipelineStageId::BrushTraining)
                .unwrap();
            stage.status = stage_status;
            stage.progress = 0.5;
            manager.save_project(&project, &directory).unwrap();
            std::fs::create_dir_all(directory.join("training/checkpoints")).unwrap();
            std::fs::write(
                directory.join("training/checkpoints/checkpoint_0500.ply"),
                b"preserved checkpoint",
            )
            .unwrap();
            Self {
                root,
                directory,
                manager,
            }
        }

        fn bytes(&self) -> Vec<u8> {
            std::fs::read(self.directory.join("project.json")).unwrap()
        }

        fn assert_checkpoint(&self) {
            assert_eq!(
                std::fs::read(
                    self.directory
                        .join("training/checkpoints/checkpoint_0500.ply")
                )
                .unwrap(),
                b"preserved checkpoint"
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn every_interrupted_status_becomes_durable_paused_with_checkpoint_preserved() {
        for (status, stage) in [
            (ProjectStatus::Starting, StageStatus::Preparing),
            (ProjectStatus::Running, StageStatus::Running),
            (ProjectStatus::Pausing, StageStatus::Pausing),
            (ProjectStatus::Cancelling, StageStatus::Cancelling),
            (ProjectStatus::Recovering, StageStatus::Running),
            (ProjectStatus::Ready, StageStatus::Running),
        ] {
            let fixture = Fixture::new(status, stage);
            let guard = acquire_project_with(&fixture.directory, "test", |_| Ok(())).unwrap();
            let recovered = recover_project(&fixture.manager, &fixture.directory, &guard).unwrap();
            assert_eq!(recovered.status, ProjectStatus::Paused);
            assert!(recovered.current_stage.is_none());
            assert!(recovered.pipeline_state.current_stage.is_none());
            assert_eq!(
                recovered.pipeline_state.stages[&PipelineStageId::BrushTraining].status,
                StageStatus::Failed
            );
            assert_eq!(
                recovered.pipeline_state.overall_progress,
                recovered.pipeline_state.weighted_progress()
            );
            assert_eq!(
                fixture
                    .manager
                    .open_project(&fixture.directory)
                    .unwrap()
                    .status,
                ProjectStatus::Paused
            );
            fixture.assert_checkpoint();
            assert!(ProjectLock::try_lock(&fixture.directory, "competitor").is_err());
            // Reopening an already normalized project is idempotent.
            let first = fixture.bytes();
            recover_project(&fixture.manager, &fixture.directory, &guard).unwrap();
            assert_eq!(fixture.bytes(), first);
        }
    }

    #[test]
    fn starting_without_a_current_stage_is_recoverable() {
        let fixture = Fixture::new(ProjectStatus::Starting, StageStatus::Pending);
        let mut project = fixture.manager.open_project(&fixture.directory).unwrap();
        project.pipeline_state.current_stage = None;
        project.current_stage = None;
        fixture
            .manager
            .save_project(&project, &fixture.directory)
            .unwrap();
        let guard = acquire_project_with(&fixture.directory, "test", |_| Ok(())).unwrap();
        let recovered = recover_project(&fixture.manager, &fixture.directory, &guard).unwrap();
        assert_eq!(recovered.status, ProjectStatus::Paused);
        assert!(recovered.pipeline_state.current_stage.is_none());
    }

    #[test]
    fn busy_kernel_or_legacy_live_owner_blocks_before_observation_and_writes() {
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let bytes = fixture.bytes();
        let guard = ProjectLock::try_lock(&fixture.directory, "other-app").unwrap();
        std::fs::remove_file(fixture.directory.join(".lock")).unwrap();
        assert!(acquire_project_with(&fixture.directory, "test", |_| panic!(
            "must not inspect after busy guard"
        ))
        .is_err());
        assert_eq!(fixture.bytes(), bytes);
        drop(guard);
        let live_metadata = serde_json::to_vec(&splat_pipeline::LockInfo {
            pid: std::process::id(),
            started_at: chrono::Utc::now(),
            stage: "legacy".into(),
        })
        .unwrap();
        std::fs::write(fixture.directory.join(".lock"), &live_metadata).unwrap();
        assert!(acquire_project_with(&fixture.directory, "test", |_| panic!(
            "must not inspect live owner"
        ))
        .is_err());
        assert_eq!(
            std::fs::read(fixture.directory.join(".lock")).unwrap(),
            live_metadata
        );
        assert_eq!(fixture.bytes(), bytes);
        fixture.assert_checkpoint();
    }

    #[cfg(unix)]
    #[test]
    fn dead_legacy_owner_can_be_recovered_through_normal_open() {
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        std::fs::write(
            fixture.directory.join(".lock"),
            serde_json::to_vec(&splat_pipeline::LockInfo {
                pid,
                started_at: chrono::Utc::now(),
                stage: "brush".into(),
            })
            .unwrap(),
        )
        .unwrap();
        let (recovered, guard) =
            open_project_for_view(&fixture.manager, &AppState::new(), &fixture.directory).unwrap();
        assert!(guard.is_some());
        assert_eq!(recovered.status, ProjectStatus::Paused);
        fixture.assert_checkpoint();
    }

    #[cfg(unix)]
    #[test]
    fn live_engine_process_is_observed_and_never_terminated_by_recovery() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let before = fixture.bytes();
        let engine = fixture.root.join("brush-cli");
        std::fs::copy("/bin/sleep", &engine).unwrap();
        let mut child = ChildGuard(
            std::process::Command::new(engine)
                .arg("60")
                .current_dir(&fixture.directory)
                .spawn()
                .unwrap(),
        );
        let result = open_project_for_view(&fixture.manager, &AppState::new(), &fixture.directory);
        assert!(result.err().unwrap().contains(&child.0.id().to_string()));
        assert!(child.0.try_wait().unwrap().is_none());
        assert_eq!(fixture.bytes(), before);
        fixture.assert_checkpoint();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let (project, _guard) =
            open_project_for_view(&fixture.manager, &AppState::new(), &fixture.directory).unwrap();
        assert_eq!(project.status, ProjectStatus::Paused);
    }

    #[test]
    fn orphan_or_unreadable_engine_blocks_before_project_mutation() {
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let bytes = fixture.bytes();
        let mut process = ObservedProcess {
            pid: 123,
            name: "brush-cli".into(),
            executable: None,
            cwd: Some(fixture.root.clone()),
            args: vec![
                "brush-cli".into(),
                fixture.directory.join("training/dataset").into_os_string(),
            ],
        };
        assert!(
            acquire_project_with(&fixture.directory, "test", |dir| check_process(
                dir, &process
            ))
            .err()
            .unwrap()
            .contains("123")
        );
        assert_eq!(fixture.bytes(), bytes);
        process.args.clear();
        assert!(check_process(&fixture.directory, &process)
            .unwrap_err()
            .contains("无法确认"));
        fixture.assert_checkpoint();
    }

    #[test]
    fn process_paths_match_boundaries_aliases_and_not_unrelated_engines() {
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let mut process = ObservedProcess {
            pid: 123,
            name: "colmap".into(),
            executable: None,
            cwd: Some(fixture.root.clone()),
            args: vec![
                "colmap".into(),
                format!("{}-other/database.db", fixture.directory.display()).into(),
            ],
        };
        assert!(check_process(&fixture.directory, &process).is_ok());
        process.args[1] = format!(
            "--database_path={}/colmap/not-created.db",
            fixture.directory.display()
        )
        .into();
        assert!(check_process(&fixture.directory, &process).is_err());
        process.args[1] = fixture
            .directory
            .strip_prefix(&fixture.root)
            .unwrap()
            .join("training/dataset")
            .into_os_string();
        assert!(check_process(&fixture.directory, &process).is_err());
        process.name = "brush_live.exe".into();
        process.args[0] = "brush_live.exe".into();
        assert!(check_process(&fixture.directory, &process).is_err());
        #[cfg(unix)]
        {
            let alias = fixture.root.join("alias");
            std::os::unix::fs::symlink(&fixture.directory, &alias).unwrap();
            process.args[1] = alias.join("training/new-output").into_os_string();
            assert!(check_process(&fixture.directory, &process).is_err());
        }
        process.name = "editor".into();
        process.args[0] = "editor".into();
        assert!(check_process(&fixture.directory, &process).is_ok());
    }

    #[test]
    fn future_runtime_evidence_prevents_recovery_mutation() {
        let fixture = Fixture::new(ProjectStatus::Running, StageStatus::Running);
        let bytes = fixture.bytes();
        std::fs::create_dir_all(fixture.directory.join("runtime")).unwrap();
        let path = fixture.directory.join("runtime/execution-profile.json");
        std::fs::write(&path, b"{\"schema_version\":999}").unwrap();
        let guard = acquire_project_with(&fixture.directory, "test", |_| Ok(())).unwrap();
        assert!(recover_project(&fixture.manager, &fixture.directory, &guard).is_err());
        assert_eq!(fixture.bytes(), bytes);
        assert_eq!(std::fs::read(path).unwrap(), b"{\"schema_version\":999}");
        fixture.assert_checkpoint();
    }
}
