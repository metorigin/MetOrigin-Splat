//! Explicit checkpoint selection keeps the compatible training fingerprint but
//! revokes its completion proof. A durable intent makes interrupted selection
//! retryable without silently starting a new training run.
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use splat_domain::{
    AppError, AppResult, ErrorCategory, PipelineStageId, ProjectId, ProjectStatus, StageStatus,
};
use splat_engine_brush::{CheckpointScanner, ExportManager};
use splat_project::ProjectManager;

use super::{io_error, state};
use crate::{LockGuard, ProjectLock};

const JOURNAL: &str = "training/checkpoint-restore.json";
const DOWNSTREAM_ARTIFACTS: [&str; 4] = [
    "training/result.json",
    "training/validation.json",
    "output/scene.ply",
    "output/manifest.json",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreIntent {
    schema_version: u32,
    archive_id: String,
    iteration: u32,
    target_iterations: u32,
    checkpoint: String,
    checkpoint_sha256: String,
    fingerprint: String,
}

fn error(detail: &str) -> AppError {
    AppError::new(
        "E-4005",
        ErrorCategory::Engine,
        "Checkpoint Restore Requires Attention",
        "The checkpoint could not be safely selected. Previous results have been preserved.",
    )
    .with_technical(detail)
}

/// Select a verified checkpoint in an idle project. Existing later checkpoints
/// are archived; no source media or completed model is deleted.
pub fn restore_checkpoint(project_dir: &Path, iteration: u32) -> AppResult<()> {
    validate_directories(project_dir)?;
    let mut lock = ProjectLock::try_lock(project_dir, "checkpoint_restore")
        .map_err(|e| error(&e.to_string()))?;
    recover_locked(project_dir)?;
    // Reject future/corrupt authoritative files before writing the intent.
    let project = manager(project_dir).open_project(project_dir)?;
    let profile = splat_project::load_execution_profile(project_dir)?;
    let previous = state::load_project(project_dir)?
        .ok_or_else(|| error("Checkpoint has no valid training provenance; retrain instead of assuming compatibility."))?;
    if !valid_hash(&previous.fingerprint) {
        return Err(error("Invalid training fingerprint."));
    }
    let target_iterations = previous
        .completed
        .as_ref()
        .map(|value| value.iterations)
        .or_else(|| {
            profile
                .as_ref()
                .map(|profile| profile.effective_training.iterations)
        })
        .map(Ok)
        .unwrap_or_else(|| {
            splat_engine_brush::TrainingConfig::from_builtin(&project.settings.preset)
                .map(|config| config.iterations)
        })?;
    if iteration >= target_iterations {
        return Err(error("Restore must select a checkpoint before the recorded training target; a final checkpoint remains a completed result."));
    }
    let checkpoints = CheckpointScanner::scan(&project_dir.join("training/checkpoints"))?;
    if checkpoints
        .iter()
        .filter(|item| item.iteration == iteration)
        .count()
        != 1
    {
        return Err(error(
            "Selected checkpoint is missing or has ambiguous duplicate iterations.",
        ));
    }
    let checkpoint = checkpoints
        .into_iter()
        .find(|item| item.iteration == iteration && iteration > 0)
        .ok_or_else(|| error("Selected checkpoint is missing or invalid."))?;
    let filename = checkpoint
        .path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| error("Invalid checkpoint filename."))?
        .to_owned();
    reject_symlink(&checkpoint.path)?;
    let intent = RestoreIntent {
        schema_version: 1,
        archive_id: ProjectId::new().to_string(),
        iteration,
        target_iterations,
        checkpoint: filename,
        checkpoint_sha256: state::hash_file(&checkpoint.path)?,
        fingerprint: previous.fingerprint,
    };
    state::write_json_atomic(&intent, &project_dir.join(JOURNAL))?;
    recover_locked(project_dir)?;
    lock.try_release().map_err(io_error)
}

/// Complete a durable restore intent before reopening or starting the project.
/// A failed recovery leaves the intent and preserved artifacts for retry.
pub fn recover_checkpoint_restore(project_dir: &Path) -> AppResult<()> {
    reject_symlink(&project_dir.join(JOURNAL))?;
    if !project_dir.join(JOURNAL).try_exists().map_err(io_error)? {
        return Ok(());
    }
    validate_directories(project_dir)?;
    let mut lock = ProjectLock::try_lock(project_dir, "checkpoint_restore_recovery")
        .map_err(|e| error(&e.to_string()))?;
    recover_checkpoint_restore_with_lock(project_dir, &lock)?;
    lock.try_release().map_err(io_error)
}

/// Recover while an application entry point already holds the project lock.
/// Reusing the guard keeps recovery and the caller's subsequent state writes
/// inside the same exclusive operation, without reacquiring a non-reentrant lock.
pub fn recover_checkpoint_restore_with_lock(
    project_dir: &Path,
    guard: &LockGuard,
) -> AppResult<()> {
    if !guard.covers_project(project_dir) {
        return Err(error(
            "Checkpoint recovery requires an active lock for this project.",
        ));
    }
    validate_directories(project_dir)?;
    recover_locked(project_dir)
}

fn manager(project_dir: &Path) -> ProjectManager {
    ProjectManager::new(project_dir.parent().unwrap_or(project_dir).to_owned())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn reject_symlink(path: &Path) -> AppResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(error("Checkpoint restore does not follow symbolic links."))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn validate_directories(project_dir: &Path) -> AppResult<()> {
    reject_symlink(project_dir)?;
    for relative in [
        ".lock",
        "project.json",
        "training",
        "training/checkpoints",
        "training/training-fingerprint.json",
        "output",
        JOURNAL,
        "runtime",
        "runtime/checkpoint-restores",
    ] {
        reject_symlink(&project_dir.join(relative))?;
    }
    for relative in DOWNSTREAM_ARTIFACTS {
        reject_symlink(&project_dir.join(relative))?;
    }
    Ok(())
}

fn archive_file(project_dir: &Path, source: &Path, destination: &Path) -> AppResult<()> {
    reject_symlink(source)?;
    if !source.try_exists().map_err(io_error)? {
        return Ok(()); // Already archived by an interrupted restore.
    }
    if !source.is_file() {
        return Err(error("A derived restore artifact is not a regular file."));
    }
    reject_symlink(destination)?;
    if destination.try_exists().map_err(io_error)? {
        return Err(error("Checkpoint archive destination already exists."));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| error("Checkpoint archive has no parent."))?;
    let mut directory = parent;
    while directory != project_dir {
        reject_symlink(directory)?;
        directory = directory
            .parent()
            .ok_or_else(|| error("Checkpoint archive escaped the project."))?;
    }
    std::fs::create_dir_all(parent).map_err(io_error)?;
    // Persist every newly created archive ancestor before removing source names.
    let mut directory = parent;
    while directory != project_dir {
        state::sync_parent(directory)?;
        directory = directory
            .parent()
            .ok_or_else(|| error("Checkpoint archive escaped the project."))?;
    }
    std::fs::rename(source, destination).map_err(io_error)?;
    state::sync_parent(source)?;
    state::sync_parent(destination)
}

fn recover_locked(project_dir: &Path) -> AppResult<()> {
    let path = project_dir.join(JOURNAL);
    if !path.try_exists().map_err(io_error)? {
        return Ok(());
    }
    let file = std::fs::File::open(&path).map_err(io_error)?;
    let intent: RestoreIntent = serde_json::from_reader(file.take(16 * 1024))
        .map_err(|e| error(&format!("Invalid checkpoint restore intent: {e}")))?;
    if intent.schema_version != 1
        || intent.iteration == 0
        || intent.iteration >= intent.target_iterations
        || intent.archive_id.len() != 36
        || !intent
            .archive_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || intent.checkpoint.is_empty()
        || intent.checkpoint.contains(['/', '\\'])
        || !intent.checkpoint.ends_with(".ply")
        || !valid_hash(&intent.checkpoint_sha256)
        || !valid_hash(&intent.fingerprint)
    {
        return Err(error("Unsupported or unsafe checkpoint restore intent."));
    }
    let manager = manager(project_dir);
    let mut project = manager.open_project(project_dir)?;
    splat_project::load_execution_profile(project_dir)?;
    let mut previous = state::load_project(project_dir)?
        .ok_or_else(|| error("Training provenance is unavailable during checkpoint restore."))?;
    if previous.fingerprint != intent.fingerprint {
        return Err(error(
            "Training provenance changed during checkpoint restore.",
        ));
    }
    let directory = project_dir.join("training/checkpoints");
    let selected = directory.join(&intent.checkpoint);
    reject_symlink(&selected)?;
    let selected_candidates: Vec<_> = CheckpointScanner::scan(&directory)?
        .into_iter()
        .filter(|item| item.iteration == intent.iteration)
        .collect();
    if selected_candidates.len() != 1 || selected_candidates[0].path != selected {
        return Err(error(
            "Selected checkpoint name and iteration do not match.",
        ));
    }
    ExportManager::inspect_ply(&selected)?;
    if state::hash_file(&selected)? != intent.checkpoint_sha256 {
        return Err(error("Selected checkpoint changed during restore."));
    }
    let archive = project_dir
        .join("runtime/checkpoint-restores")
        .join(&intent.archive_id);
    reject_symlink(&archive)?;
    for checkpoint in CheckpointScanner::scan(&directory)?
        .into_iter()
        .filter(|item| item.iteration > intent.iteration)
    {
        let name = checkpoint
            .path
            .file_name()
            .ok_or_else(|| error("Invalid checkpoint filename."))?;
        let destination = archive.join(name);
        archive_file(project_dir, &checkpoint.path, &destination)?;
    }
    // Pending stage status alone does not invalidate stage-specific file caches.
    // Keep the old published result recoverable in the same archive, while
    // removing every downstream cache from the active project namespace.
    for relative in DOWNSTREAM_ARTIFACTS {
        archive_file(
            project_dir,
            &project_dir.join(relative),
            &archive.join(relative),
        )?;
    }
    // Keep the exact original fingerprint: normal stage preflight must still
    // reject an incompatible engine/configuration before authorizing warm start.
    previous.completed = None;
    state::write_json_atomic(
        &previous,
        &project_dir.join("training/training-fingerprint.json"),
    )?;
    let mut downstream = false;
    for stage in PipelineStageId::all() {
        downstream |= *stage == PipelineStageId::BrushTraining;
        if downstream {
            if let Some(value) = project.pipeline_state.stages.get_mut(stage) {
                value.status = if *stage == PipelineStageId::BrushTraining {
                    StageStatus::Paused
                } else {
                    StageStatus::Pending
                };
                value.progress = 0.0;
                value.started_at = None;
                value.ended_at = None;
                value.error = None;
            }
        }
    }
    project.pipeline_state.current_stage = None;
    project.pipeline_state.refresh_overall_progress();
    project.current_stage = None;
    project.status = ProjectStatus::Paused;
    project.touch();
    manager.save_project(&project, project_dir)?;
    std::fs::remove_file(&path).map_err(io_error)?;
    state::sync_parent(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let mut project = splat_domain::project::Project::new("恢复测试");
        project.status = ProjectStatus::Completed;
        for value in project.pipeline_state.stages.values_mut() {
            value.status = StageStatus::Completed;
            value.progress = 1.0;
        }
        project.pipeline_state.refresh_overall_progress();
        manager(root.path())
            .save_project(&project, root.path())
            .unwrap();
        let directory = root.path().join("training/checkpoints");
        std::fs::create_dir_all(&directory).unwrap();
        for iteration in [500, 1000] {
            std::fs::write(
                directory.join(format!("checkpoint_{iteration}.ply")),
                include_bytes!("../../../../../test-fixtures/gaussian/minimal-sh0-ascii.ply"),
            )
            .unwrap();
        }
        let value = serde_json::json!({"schema_version":1,"fingerprint":"a".repeat(64),"completed":{
            "checkpoint":"checkpoint_1000.ply","checkpoint_sha256":"b".repeat(64),"result_sha256":"c".repeat(64),"iterations":1000}});
        state::write_json_atomic(
            &value,
            &root.path().join("training/training-fingerprint.json"),
        )
        .unwrap();
        let ply = include_bytes!("../../../../../test-fixtures/gaussian/minimal-sh0-ascii.ply");
        std::fs::create_dir_all(root.path().join("output")).unwrap();
        std::fs::write(root.path().join("output/scene.ply"), ply).unwrap();
        state::write_json_atomic(
            &serde_json::json!({"old_result":true}),
            &root.path().join("training/result.json"),
        )
        .unwrap();
        state::write_json_atomic(&serde_json::json!({"passed":true,"checkpoint_path":"training/checkpoints/checkpoint_1000.ply","size_bytes":ply.len(),"vertex_count":1}), &root.path().join("training/validation.json")).unwrap();
        state::write_json_atomic(
            &serde_json::json!({"ply":{"size_bytes":ply.len(),"vertex_count":1}}),
            &root.path().join("output/manifest.json"),
        )
        .unwrap();
        root
    }

    #[test]
    fn completed_run_selection_revokes_completion_and_preserves_fingerprint() {
        let root = fixture();
        let previous_artifacts: Vec<_> = DOWNSTREAM_ARTIFACTS
            .iter()
            .map(|name| (*name, std::fs::read(root.path().join(name)).unwrap()))
            .collect();
        restore_checkpoint(root.path(), 500).unwrap();
        let saved = state::load_project(root.path()).unwrap().unwrap();
        assert!(saved.completed.is_none());
        assert_eq!(saved.fingerprint, "a".repeat(64));
        assert_eq!(
            CheckpointScanner::scan(&root.path().join("training/checkpoints")).unwrap()[0]
                .iteration,
            500
        );
        assert!(!root
            .path()
            .join("training/checkpoints/checkpoint_1000.ply")
            .exists());
        let archived = walkdir::WalkDir::new(root.path().join("runtime/checkpoint-restores"))
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() == "checkpoint_1000.ply")
            .count();
        assert_eq!(archived, 1);
        let archive = std::fs::read_dir(root.path().join("runtime/checkpoint-restores"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        for (name, bytes) in previous_artifacts {
            assert!(
                !root.path().join(name).exists(),
                "old cache remains: {name}"
            );
            assert_eq!(std::fs::read(archive.join(name)).unwrap(), bytes);
        }
        let project = manager(root.path()).open_project(root.path()).unwrap();
        assert_eq!(project.status, ProjectStatus::Paused);
        assert!(project.pipeline_state.overall_progress < 1.0);
        assert_eq!(
            project.pipeline_state.stages[&PipelineStageId::BrushTraining].status,
            StageStatus::Paused
        );
        assert!(!root.path().join(JOURNAL).exists());
    }

    #[tokio::test]
    async fn restored_training_cannot_reuse_old_export_or_preview_caches() {
        use crate::stage::{PipelineStage, StageContext};
        use crate::stages::{ExportStage, ModelValidationStage, PreviewGenerationStage};
        let root = fixture();
        let stages: Vec<Box<dyn PipelineStage>> = vec![
            Box::new(ModelValidationStage::new()),
            Box::new(ExportStage::new()),
            Box::new(PreviewGenerationStage::new()),
        ];
        for stage in &stages {
            let ctx = StageContext::new(stage.id(), root.path(), None);
            assert!(
                stage.check_cached(&ctx).unwrap(),
                "fixture must reproduce the old cache hit"
            );
        }
        let old_output = std::fs::read(root.path().join("output/scene.ply")).unwrap();
        restore_checkpoint(root.path(), 500).unwrap();
        // A later successful warm-start produces a different final checkpoint.
        let new_output = String::from_utf8(old_output.clone())
            .unwrap()
            .replace(
                "end_header\n",
                "comment regenerated-checkpoint\nend_header\n",
            )
            .into_bytes();
        std::fs::write(
            root.path().join("training/checkpoints/checkpoint_1000.ply"),
            &new_output,
        )
        .unwrap();
        state::write_json_atomic(
            &serde_json::json!({"total_iterations":1000,"resumed_from_iteration":500}),
            &root.path().join("training/result.json"),
        )
        .unwrap();
        for stage in stages {
            let ctx = StageContext::new(stage.id(), root.path(), None);
            assert!(
                !stage.check_cached(&ctx).unwrap(),
                "restored stage must regenerate: {:?}",
                stage.id()
            );
            stage
                .execute(&ctx, tokio::sync::broadcast::channel(8).0)
                .await
                .unwrap();
            stage.validate_outputs(&ctx).unwrap();
        }
        assert_ne!(new_output, old_output);
        assert_eq!(
            std::fs::read(root.path().join("output/scene.ply")).unwrap(),
            new_output
        );
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join("output/manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["training"]["resumed_from_iteration"], 500);
    }

    #[test]
    fn interrupted_downstream_archival_preserves_existing_destination_and_retries() {
        let root = fixture();
        let pending = intent(root.path());
        state::write_json_atomic(&pending, &root.path().join(JOURNAL)).unwrap();
        let archive = root
            .path()
            .join("runtime/checkpoint-restores")
            .join(&pending.archive_id);
        std::fs::create_dir_all(archive.join("output")).unwrap();
        let conflict = archive.join("output/scene.ply");
        std::fs::write(&conflict, b"unrelated preserved bytes").unwrap();
        let original = std::fs::read(root.path().join("output/scene.ply")).unwrap();
        assert!(recover_checkpoint_restore(root.path()).is_err());
        assert_eq!(
            std::fs::read(&conflict).unwrap(),
            b"unrelated preserved bytes"
        );
        assert_eq!(
            std::fs::read(root.path().join("output/scene.ply")).unwrap(),
            original
        );
        assert!(root.path().join(JOURNAL).exists());
        std::fs::rename(&conflict, archive.join("preserved-conflict.ply")).unwrap();
        recover_checkpoint_restore(root.path()).unwrap();
        assert_eq!(std::fs::read(conflict).unwrap(), original);
        for relative in DOWNSTREAM_ARTIFACTS {
            assert!(!root.path().join(relative).exists());
            assert!(archive.join(relative).exists());
        }
        assert!(!root.path().join(JOURNAL).exists());
    }

    fn intent(root: &Path) -> RestoreIntent {
        RestoreIntent {
            schema_version: 1,
            archive_id: ProjectId::new().to_string(),
            iteration: 500,
            target_iterations: 1000,
            checkpoint: "checkpoint_500.ply".into(),
            checkpoint_sha256: state::hash_file(
                &root.join("training/checkpoints/checkpoint_500.ply"),
            )
            .unwrap(),
            fingerprint: "a".repeat(64),
        }
    }

    #[test]
    fn interrupted_archive_is_completed_on_reopen_and_is_idempotent() {
        let root = fixture();
        let intent = intent(root.path());
        state::write_json_atomic(&intent, &root.path().join(JOURNAL)).unwrap();
        let archive = root
            .path()
            .join("runtime/checkpoint-restores")
            .join(&intent.archive_id);
        std::fs::create_dir_all(&archive).unwrap();
        std::fs::rename(
            root.path().join("training/checkpoints/checkpoint_1000.ply"),
            archive.join("checkpoint_1000.ply"),
        )
        .unwrap();
        recover_checkpoint_restore(root.path()).unwrap();
        recover_checkpoint_restore(root.path()).unwrap();
        assert!(state::load_project(root.path())
            .unwrap()
            .unwrap()
            .completed
            .is_none());
        assert_eq!(
            manager(root.path())
                .open_project(root.path())
                .unwrap()
                .status,
            ProjectStatus::Paused
        );
    }

    #[test]
    fn guarded_recovery_requires_the_matching_active_project_lock() {
        let root = fixture();
        let other = fixture();
        let pending = intent(root.path());
        state::write_json_atomic(&pending, &root.path().join(JOURNAL)).unwrap();
        let mut guard = ProjectLock::try_lock(other.path(), "open").unwrap();
        assert!(recover_checkpoint_restore_with_lock(root.path(), &guard).is_err());
        assert!(root.path().join(JOURNAL).exists());
        guard.try_release().unwrap();
        let mut guard = ProjectLock::try_lock(root.path(), "open").unwrap();
        recover_checkpoint_restore_with_lock(root.path(), &guard).unwrap();
        assert!(!root.path().join(JOURNAL).exists());
        assert!(root.path().join(".lock").exists());
        guard.try_release().unwrap();
        assert!(recover_checkpoint_restore_with_lock(root.path(), &guard).is_err());
    }

    #[test]
    fn future_metadata_is_rejected_before_moving_any_checkpoint() {
        let root = fixture();
        let metadata = root.path().join("training/training-fingerprint.json");
        let original = std::fs::read_to_string(&metadata)
            .unwrap()
            .replace("\"schema_version\": 1", "\"schema_version\": 2");
        std::fs::write(&metadata, &original).unwrap();
        assert!(restore_checkpoint(root.path(), 500).is_err());
        assert_eq!(std::fs::read_to_string(metadata).unwrap(), original);
        assert!(root
            .path()
            .join("training/checkpoints/checkpoint_1000.ply")
            .exists());
        assert!(!root.path().join(JOURNAL).exists());
    }

    #[test]
    fn altered_checkpoint_and_future_intent_preserve_pending_recovery() {
        for future in [false, true] {
            let root = fixture();
            let mut intent = intent(root.path());
            if future {
                intent.schema_version = 2;
            } else {
                intent.checkpoint_sha256 = "d".repeat(64);
            }
            state::write_json_atomic(&intent, &root.path().join(JOURNAL)).unwrap();
            assert!(recover_checkpoint_restore(root.path()).is_err());
            assert!(root.path().join(JOURNAL).exists());
            assert!(root
                .path()
                .join("training/checkpoints/checkpoint_1000.ply")
                .exists());
            assert!(state::load_project(root.path())
                .unwrap()
                .unwrap()
                .completed
                .is_some());
        }
    }

    #[test]
    fn active_project_lock_blocks_restore_without_mutation() {
        let root = fixture();
        let _lock = ProjectLock::try_lock(root.path(), "training").unwrap();
        assert!(restore_checkpoint(root.path(), 500).is_err());
        assert!(!root.path().join(JOURNAL).exists());
        assert!(state::load_project(root.path())
            .unwrap()
            .unwrap()
            .completed
            .is_some());
    }

    #[test]
    fn final_or_duplicate_checkpoint_selection_is_rejected_without_intent() {
        let root = fixture();
        assert!(restore_checkpoint(root.path(), 1000).is_err());
        std::fs::copy(
            root.path().join("training/checkpoints/checkpoint_500.ply"),
            root.path()
                .join("training/checkpoints/checkpoint_00500.ply"),
        )
        .unwrap();
        assert!(restore_checkpoint(root.path(), 500).is_err());
        assert!(!root.path().join(JOURNAL).exists());
        assert!(state::load_project(root.path())
            .unwrap()
            .unwrap()
            .completed
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn dangling_restore_links_are_rejected_without_moving_checkpoints() {
        use std::os::unix::fs::symlink;
        for location in ["journal", "archive_destination", "lock"] {
            let root = fixture();
            let pending = intent(root.path());
            let link = match location {
                "journal" => root.path().join(JOURNAL),
                "lock" => root.path().join(".lock"),
                _ => {
                    state::write_json_atomic(&pending, &root.path().join(JOURNAL)).unwrap();
                    let directory = root
                        .path()
                        .join("runtime/checkpoint-restores")
                        .join(&pending.archive_id);
                    std::fs::create_dir_all(&directory).unwrap();
                    directory.join("checkpoint_1000.ply")
                }
            };
            let absent = root.path().join("must-not-create");
            symlink(&absent, &link).unwrap();
            let result = if location == "lock" {
                restore_checkpoint(root.path(), 500)
            } else {
                recover_checkpoint_restore(root.path())
            };
            assert!(result.is_err(), "{location}");
            assert!(std::fs::symlink_metadata(link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!absent.exists());
            assert!(root
                .path()
                .join("training/checkpoints/checkpoint_1000.ply")
                .exists());
            assert!(state::load_project(root.path())
                .unwrap()
                .unwrap()
                .completed
                .is_some());
        }
    }
}
