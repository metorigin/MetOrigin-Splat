//! Durable work still required after replacing an execution profile. Completed
//! project state or a cache hit cannot discharge this journal: the stage must
//! execute, validate its outputs, and persist completion before it advances.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use splat_domain::{
    AppError, AppResult, ErrorCategory, ExecutionProfile, PipelineStageId, ProjectId,
};

const VERSION: u32 = 1;
const MAX_BYTES: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingInvalidation {
    schema_version: u32,
    target_run_id: ProjectId,
    pub next_stage: PipelineStageId,
}

pub(super) fn path(project: &Path) -> PathBuf {
    project.join("runtime/pending-invalidation.json")
}

pub(super) fn load(project: &Path) -> AppResult<Option<PendingInvalidation>> {
    let file = match File::open(path(project)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(journal_error(&error.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| journal_error(&error.to_string()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(journal_error(
            "Pending invalidation exceeds the supported size limit.",
        ));
    }
    #[derive(Deserialize)]
    struct Envelope {
        schema_version: u32,
    }
    let envelope: Envelope =
        serde_json::from_slice(&bytes).map_err(|error| journal_error(&error.to_string()))?;
    if envelope.schema_version != VERSION {
        return Err(journal_error(
            "Pending invalidation was written by an unsupported application version.",
        ));
    }
    let journal =
        serde_json::from_slice(&bytes).map_err(|error| journal_error(&error.to_string()))?;
    Ok(Some(journal))
}

pub(super) fn begin(
    project: &Path,
    profile: &ExecutionProfile,
    first: PipelineStageId,
    previous: Option<&PendingInvalidation>,
) -> AppResult<PendingInvalidation> {
    let journal = PendingInvalidation {
        schema_version: VERSION,
        target_run_id: ProjectId::from_uuid(profile.run_id),
        next_stage: earlier(Some(first), previous.map(|pending| pending.next_stage))
            .expect("first stage is present"),
    };
    save(project, &journal)?;
    Ok(journal)
}

pub(super) fn earlier(
    left: Option<PipelineStageId>,
    right: Option<PipelineStageId>,
) -> Option<PipelineStageId> {
    match (left, right) {
        (Some(left), Some(right)) => Some(if index(left) <= index(right) {
            left
        } else {
            right
        }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub(super) fn requires_execution(
    pending: Option<&PendingInvalidation>,
    stage: PipelineStageId,
) -> bool {
    pending.is_some_and(|pending| index(stage) >= index(pending.next_stage))
}

pub(super) fn completed(
    project: &Path,
    pending: Option<PendingInvalidation>,
    stage: PipelineStageId,
) -> AppResult<Option<PendingInvalidation>> {
    let Some(mut pending) = pending else {
        return Ok(None);
    };
    // Partial library pipelines cannot discharge upstream stages they omitted.
    if pending.next_stage != stage {
        return Ok(Some(pending));
    }
    if let Some(next) = PipelineStageId::all().get(index(stage) + 1) {
        pending.next_stage = *next;
        save(project, &pending)?;
        return Ok(Some(pending));
    }
    // Never delete unknown/corrupt future evidence even if it changed mid-run.
    load(project)?;
    std::fs::remove_file(path(project)).map_err(|error| journal_error(&error.to_string()))?;
    sync_directory(&project.join("runtime"))?;
    Ok(None)
}

fn index(stage: PipelineStageId) -> usize {
    PipelineStageId::all()
        .iter()
        .position(|candidate| *candidate == stage)
        .expect("every pipeline stage has an execution order")
}

fn save(project: &Path, journal: &PendingInvalidation) -> AppResult<()> {
    load(project)?;
    let destination = path(project);
    let directory = destination.parent().expect("journal has a parent");
    std::fs::create_dir_all(directory).map_err(|error| journal_error(&error.to_string()))?;
    let temporary = directory.join(format!(".pending-invalidation-{}.tmp", ProjectId::new()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| journal_error(&error.to_string()))?;
    let bytes = serde_json::to_vec_pretty(journal)?;
    let result = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result.and_then(|()| std::fs::rename(&temporary, &destination)) {
        let _ = std::fs::remove_file(&temporary);
        return Err(journal_error(&error.to_string()));
    }
    sync_directory(directory)
}

fn sync_directory(directory: &Path) -> AppResult<()> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| journal_error(&error.to_string()))?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn journal_error(detail: &str) -> AppError {
    AppError::new("E-1405", ErrorCategory::Filesystem, "Pending Runtime Rebuild Unavailable",
        "The pending runtime rebuild could not be read or saved. Previous project data was preserved.")
        .with_technical(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ExecutionProfile {
        ExecutionProfile::from_json(include_bytes!(
            "../../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn schema_fixtures_agree_with_rust_journal_loading() {
        for (bytes, valid) in [
            (
                include_bytes!(
                    "../../../../schemas/examples/runtime-invalidation/pending.valid.json"
                )
                .as_slice(),
                true,
            ),
            (
                include_bytes!(
                    "../../../../schemas/examples/runtime-invalidation/future.invalid.json"
                )
                .as_slice(),
                false,
            ),
            (
                include_bytes!(
                    "../../../../schemas/examples/runtime-invalidation/unknown-stage.invalid.json"
                )
                .as_slice(),
                false,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("runtime")).unwrap();
            std::fs::write(path(root.path()), bytes).unwrap();
            assert_eq!(load(root.path()).is_ok(), valid);
        }
    }

    #[test]
    fn future_corrupt_and_oversized_journals_are_never_replaced() {
        for bytes in [
            b"{\"schema_version\":2,\"new_contract\":true}".to_vec(),
            b"broken".to_vec(),
            vec![b' '; 4097],
        ] {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("runtime")).unwrap();
            std::fs::write(path(root.path()), &bytes).unwrap();
            assert!(load(root.path()).is_err());
            assert!(begin(
                root.path(),
                &profile(),
                PipelineStageId::FrameExtraction,
                None
            )
            .is_err());
            assert_eq!(std::fs::read(path(root.path())).unwrap(), bytes);
        }
    }

    #[test]
    fn journal_advances_only_after_its_own_stage_and_clears_after_final_stage() {
        let root = tempfile::tempdir().unwrap();
        let pending = begin(root.path(), &profile(), PipelineStageId::Export, None).unwrap();
        let unchanged = completed(
            root.path(),
            Some(pending),
            PipelineStageId::TrainingPreparation,
        )
        .unwrap();
        assert_eq!(
            unchanged.as_ref().unwrap().next_stage,
            PipelineStageId::Export
        );
        let advanced = completed(root.path(), unchanged, PipelineStageId::Export).unwrap();
        assert_eq!(load(root.path()).unwrap(), advanced);
        assert_eq!(
            advanced.as_ref().unwrap().next_stage,
            PipelineStageId::PreviewGeneration
        );
        assert!(
            completed(root.path(), advanced, PipelineStageId::PreviewGeneration)
                .unwrap()
                .is_none()
        );
        assert!(load(root.path()).unwrap().is_none());
    }
}
