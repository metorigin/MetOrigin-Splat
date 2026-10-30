//! Versioned training provenance and interruption-safe archival of derived data.
//! A checkpoint filename alone never establishes a successful completed run.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use splat_domain::{AppError, AppResult, ErrorCategory, ProjectId};
use splat_engine_brush::{ExportManager, TrainingConfig};

use crate::stage::StageContext;

const VERSION: u32 = 1;
const STATE_FILE: &str = "training-fingerprint.json";
const JOURNAL_FILE: &str = "archive-journal.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TrainingState {
    schema_version: u32,
    pub fingerprint: String,
    pub completed: Option<Completion>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Completion {
    checkpoint: String,
    checkpoint_sha256: String,
    result_sha256: String,
    pub(super) iterations: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveJournal {
    schema_version: u32,
    archive_id: String,
    entries: Vec<ArchiveEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ArchiveEntry {
    Checkpoints,
    Result,
    Fingerprint,
    Init,
    InitTemporary,
}

impl ArchiveEntry {
    fn source(self, ctx: &StageContext) -> PathBuf {
        match self {
            Self::Checkpoints => ctx.paths.training_checkpoints.clone(),
            Self::Result => ctx.paths.training_result.clone(),
            Self::Fingerprint => state_path(ctx),
            Self::Init => ctx.paths.training_dataset.join("init.ply"),
            Self::InitTemporary => ctx.paths.training_dataset.join("init.ply.tmp"),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Checkpoints => "checkpoints",
            Self::Result => "result.json",
            Self::Fingerprint => STATE_FILE,
            Self::Init => "init.ply",
            Self::InitTemporary => "init.ply.tmp",
        }
    }
}

pub(super) fn state_path(ctx: &StageContext) -> PathBuf {
    ctx.paths.training_dir.join(STATE_FILE)
}
fn journal_path(ctx: &StageContext) -> PathBuf {
    ctx.paths.training_dir.join(JOURNAL_FILE)
}

pub(super) fn fingerprint(
    ctx: &StageContext,
    config: &TrainingConfig,
    engine_version: &str,
    binary_sha256: &str,
    live_binary_sha256: Option<&str>,
) -> AppResult<String> {
    let profile = ctx.execution_profile.as_ref().map(|p| {
        serde_json::json!({
            "platform": p.platform, "architecture": p.architecture,
            "brush_identity": p.engines.brush, "cli": p.brush.cli_profile,
            "backend": p.brush.backend, "effective_training": p.effective_training,
            "live_protocol": p.live_protocol, "resume_mode": p.resume_mode,
        })
    });
    let value = serde_json::json!({
        "schema_version": VERSION,
        "algorithm": "brush-managed-dataset-v1",
        "dataset_sha256": dataset_hash(&ctx.paths.training_dataset)?,
        "engine_version": engine_version, "binary_sha256": binary_sha256,
        "live_binary_sha256": live_binary_sha256, "profile": profile,
        "training": { "iterations":config.iterations,"sh_degree":config.sh_degree,
            "quality":config.quality,"antialiasing":config.antialiasing,"densify":config.densify,
            "checkpoint_interval":config.checkpoint_interval,"render_interval":config.render_interval }
    });
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?)))
}

fn dataset_hash(root: &Path) -> AppResult<String> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| state_error(&e.to_string()))?;
        if entry.file_type().is_symlink() {
            return Err(state_error(
                "Managed training data must not contain symbolic links.",
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| state_error(&e.to_string()))?;
        if relative == Path::new("init.ply") || relative == Path::new("init.ply.tmp") {
            continue;
        }
        let name = relative
            .to_str()
            .ok_or_else(|| state_error("Training paths must be valid Unicode."))?
            .replace('\\', "/");
        files.push((name, hash_file(entry.path())?));
    }
    files.sort();
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&files)?)))
}

pub(super) fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path).map_err(super::io_error)?;
    let before = file.metadata().map_err(super::io_error)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let length = file.read(&mut buffer).map_err(super::io_error)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    let after = std::fs::metadata(path).map_err(super::io_error)?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(state_error(
            "A training input changed while it was being hashed.",
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn load(ctx: &StageContext) -> AppResult<Option<TrainingState>> {
    load_project(&ctx.project_dir)
}

pub(super) fn load_project(project_dir: &Path) -> AppResult<Option<TrainingState>> {
    let path = project_dir.join("training").join(STATE_FILE);
    if !exists(&path)? {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(super::io_error)?;
    // Invalid legacy/partial metadata is archived, never used to authorize resume.
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    if value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .is_some_and(|v| v > u64::from(VERSION))
    {
        return Err(state_error(
            "Training metadata was created by a newer application; update before continuing.",
        ));
    }
    let Ok(state) = serde_json::from_value::<TrainingState>(value) else {
        return Ok(None);
    };
    if state.schema_version != VERSION {
        return Ok(None);
    }
    Ok(Some(state))
}

pub(super) fn completed_matches(
    ctx: &StageContext,
    fingerprint: &str,
    iterations: u32,
) -> AppResult<bool> {
    if exists(&journal_path(ctx))? {
        return Ok(false);
    }
    let Some(state) = load(ctx)? else {
        return Ok(false);
    };
    if state.fingerprint != fingerprint {
        return Ok(false);
    }
    let Some(completed) = state.completed else {
        return Ok(false);
    };
    if completed.iterations != iterations || !simple_name(&completed.checkpoint) {
        return Ok(false);
    }
    let checkpoint = ctx.paths.training_checkpoints.join(&completed.checkpoint);
    if !exists(&checkpoint)? || !exists(&ctx.paths.training_result)? {
        return Ok(false);
    }
    match ExportManager::inspect_ply(&checkpoint) {
        Err(error) if error.category == ErrorCategory::Engine => return Ok(false),
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    Ok(hash_file(&checkpoint)? == completed.checkpoint_sha256
        && hash_file(&ctx.paths.training_result)? == completed.result_sha256)
}

pub(super) fn start(ctx: &StageContext, fingerprint: String) -> AppResult<()> {
    write_json_atomic(
        &TrainingState {
            schema_version: VERSION,
            fingerprint,
            completed: None,
        },
        &state_path(ctx),
    )
}

pub(super) fn complete(
    ctx: &StageContext,
    fingerprint: String,
    checkpoint: &Path,
    iterations: u32,
) -> AppResult<()> {
    let checkpoint_name = checkpoint
        .file_name()
        .and_then(|v| v.to_str())
        .filter(|v| simple_name(v))
        .ok_or_else(|| state_error("Invalid checkpoint filename."))?
        .to_owned();
    write_json_atomic(
        &TrainingState {
            schema_version: VERSION,
            fingerprint,
            completed: Some(Completion {
                checkpoint: checkpoint_name,
                checkpoint_sha256: hash_file(checkpoint)?,
                result_sha256: hash_file(&ctx.paths.training_result)?,
                iterations,
            }),
        },
        &state_path(ctx),
    )
}

pub(super) fn archive(ctx: &StageContext) -> AppResult<()> {
    recover_archive(ctx)?;
    let mut entries = Vec::new();
    for entry in [
        ArchiveEntry::Checkpoints,
        ArchiveEntry::Result,
        ArchiveEntry::Fingerprint,
        ArchiveEntry::Init,
        ArchiveEntry::InitTemporary,
    ] {
        if exists(&entry.source(ctx))? {
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Ok(());
    }
    let journal = ArchiveJournal {
        schema_version: VERSION,
        archive_id: ProjectId::new().to_string(),
        entries,
    };
    // Persist the full move set before touching any previous training artifact.
    write_json_atomic(&journal, &journal_path(ctx))?;
    recover_archive(ctx)
}

pub(super) fn recover_archive(ctx: &StageContext) -> AppResult<()> {
    let path = journal_path(ctx);
    if !exists(&path)? {
        return Ok(());
    }
    let journal: ArchiveJournal =
        serde_json::from_slice(&std::fs::read(&path).map_err(super::io_error)?)
            .map_err(|e| state_error(&format!("Training archive journal is invalid: {e}")))?;
    if journal.schema_version != VERSION
        || journal.archive_id.len() != 36
        || !journal
            .archive_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return Err(state_error(
            "Unsupported training archive journal; previous data was preserved.",
        ));
    }
    let destination = ctx
        .project_dir
        .join("runtime/previous-training")
        .join(&journal.archive_id);
    std::fs::create_dir_all(&destination).map_err(super::io_error)?;
    for entry in &journal.entries {
        let source = entry.source(ctx);
        let target = destination.join(entry.name());
        match (exists(&source)?, exists(&target)?) {
            (true, false) => {
                std::fs::rename(&source, &target).map_err(super::io_error)?;
                sync_parent(&source)?;
                sync_parent(&target)?;
            }
            (false, true) => {} // interrupted after this move, continue safely
            _ => return Err(state_error(
                "Archive source/destination are ambiguous; all files were preserved for recovery.",
            )),
        }
    }
    write_json_atomic(&journal, &destination.join("archive.json"))?;
    std::fs::remove_file(&path).map_err(super::io_error)?;
    sync_parent(&path)
}

fn simple_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}
fn exists(path: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(super::io_error(e)),
    }
}

pub(super) fn write_json_atomic<T: Serialize>(value: &T, path: &Path) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| state_error("Invalid metadata path."))?;
    std::fs::create_dir_all(parent).map_err(super::io_error)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temporary).map_err(super::io_error)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)
        .map_err(super::io_error)?;
    file.sync_all().map_err(super::io_error)?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(super::io_error)?;
    sync_parent(path)
}

pub(super) fn sync_parent(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(super::io_error)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn state_error(detail: &str) -> AppError {
    AppError::new(
        "E-4005",
        ErrorCategory::Engine,
        "Training Provenance Requires Attention",
        "Training data could not be safely reused. Previous results have been preserved.",
    )
    .with_technical(detail)
}

#[cfg(test)]
mod tests;
