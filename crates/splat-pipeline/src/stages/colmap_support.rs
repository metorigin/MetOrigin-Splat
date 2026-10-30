use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::project::{Project, ProjectSource};
use splat_domain::runtime::{ColmapExecution, RuntimePlatform};
use splat_engine_colmap::{ColmapAdapter, ColmapExecutionSettings};
use splat_process::ProcessResult;

use crate::stage::StageContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ColmapSourceKind {
    Images,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ColmapCacheFingerprint {
    pub strategy_version: u32,
    pub source_kind: String,
    pub frame_manifest_sha256: String,
    pub colmap_binary_sha256: String,
    pub reconstruction_long_edge: u32,
    /// Missing in legacy fingerprints. Only SfM execution inputs belong here;
    /// run identity and unrelated training settings must not invalidate SfM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ColmapExecutionFingerprint>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ColmapExecutionFingerprint {
    platform: RuntimePlatform,
    colmap: ColmapExecution,
    threads: u32,
}

pub(crate) fn cache_fingerprint(ctx: &StageContext) -> AppResult<ColmapCacheFingerprint> {
    let source_kind = source_kind(ctx)?;
    let project_bytes = std::fs::read(ctx.project_dir.join("project.json")).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Project",
            "Could not compute the COLMAP cache fingerprint.",
        )
        .with_technical(error.to_string())
    })?;
    let project: Project = serde_json::from_slice(&project_bytes).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "project.json is invalid while computing the COLMAP cache fingerprint.",
        )
        .with_technical(error.to_string())
    })?;
    let colmap = ctx.engine_paths.colmap.as_ref().ok_or_else(|| {
        AppError::new(
            "E-3001",
            ErrorCategory::Engine,
            "COLMAP Not Found",
            "The COLMAP binary is required for cache fingerprinting.",
        )
    })?;
    Ok(ColmapCacheFingerprint {
        strategy_version: 3,
        source_kind: match source_kind {
            ColmapSourceKind::Images => "images",
            ColmapSourceKind::Video => "video",
        }
        .into(),
        frame_manifest_sha256: sha256_file(&ctx.paths.frames_manifest)?,
        colmap_binary_sha256: verified_colmap_sha256(ctx, colmap)?,
        reconstruction_long_edge: project.settings.resolved_colmap_max_long_edge(),
        execution: execution_settings(ctx)?.map(|settings| ColmapExecutionFingerprint {
            platform: settings.platform(),
            colmap: settings.colmap().clone(),
            threads: settings.threads(),
        }),
    })
}

pub(crate) fn execution_settings(ctx: &StageContext) -> AppResult<Option<ColmapExecutionSettings>> {
    ctx.execution_profile
        .as_deref()
        .map(ColmapExecutionSettings::from_execution_profile)
        .transpose()
}

/// Legacy runs keep accepting their existing metadata. Explicit profiles bind
/// every completed matching/mapping result to the SfM inputs at execution time.
pub(crate) fn profile_fingerprint(ctx: &StageContext) -> AppResult<Option<ColmapCacheFingerprint>> {
    ctx.execution_profile
        .as_ref()
        .map(|_| cache_fingerprint(ctx))
        .transpose()
}

pub(crate) fn profile_fingerprint_matches(
    ctx: &StageContext,
    stored: Option<&ColmapCacheFingerprint>,
) -> bool {
    profile_fingerprint(ctx)
        .map(|expected| expected.as_ref() == stored)
        .unwrap_or(false)
}

pub(crate) fn fingerprint_path(ctx: &StageContext) -> PathBuf {
    ctx.paths.colmap_dir.join("fingerprint.json")
}

pub(crate) fn fingerprint_matches(ctx: &StageContext) -> bool {
    let expected = match cache_fingerprint(ctx) {
        Ok(value) => value,
        Err(_) => return false,
    };
    std::fs::read(fingerprint_path(ctx))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ColmapCacheFingerprint>(&bytes).ok())
        .map(|actual| actual == expected)
        .unwrap_or(false)
}

pub(crate) fn sha256_file(path: &Path) -> AppResult<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Cache Input",
            format!("Could not hash '{}'.", path.display()),
        )
        .with_technical(error.to_string())
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Hash Cache Input",
                error.to_string(),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verified_colmap_sha256(ctx: &StageContext, path: &Path) -> AppResult<String> {
    let hash = sha256_file(path)?;
    if let Some(profile) = &ctx.execution_profile {
        profile.validate()?;
        if !hash.eq_ignore_ascii_case(&profile.engines.colmap.binary_sha256) {
            return Err(AppError::new(
                "E-3008",
                ErrorCategory::Engine,
                "COLMAP Binary Changed",
                "The COLMAP executable no longer matches the frozen execution profile.",
            )
            .with_technical(format!(
                "expected={}, actual={hash}",
                profile.engines.colmap.binary_sha256
            ))
            .with_suggestions(vec!["Run preflight again with the selected engine pack."]));
        }
    }
    Ok(hash)
}

pub(crate) fn source_kind(ctx: &StageContext) -> AppResult<ColmapSourceKind> {
    let path = ctx.project_dir.join("project.json");
    let json = std::fs::read_to_string(&path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Project",
            "Could not determine the COLMAP strategy from project.json.",
        )
        .with_technical(error.to_string())
    })?;
    let project: Project = serde_json::from_str(&json).map_err(|error| {
        AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "Invalid Project Metadata",
            "project.json could not be parsed for COLMAP strategy selection.",
        )
        .with_technical(error.to_string())
    })?;
    match project.source {
        Some(ProjectSource::ImageFolder(_)) => Ok(ColmapSourceKind::Images),
        Some(ProjectSource::Video(_)) => Ok(ColmapSourceKind::Video),
        None => Err(AppError::new(
            "E-1101",
            ErrorCategory::Media,
            "Project Source Missing",
            "The project has no source type for COLMAP strategy selection.",
        )),
    }
}

pub(crate) fn adapter(ctx: &StageContext) -> AppResult<ColmapAdapter> {
    let path = ctx.engine_paths.colmap.clone().ok_or_else(|| {
        AppError::new(
            "E-3001",
            ErrorCategory::Engine,
            "COLMAP Not Found",
            "COLMAP is required but was not found in the configured engine directory, application resources, or PATH.",
        )
    })?;
    if let Some(profile) = &ctx.execution_profile {
        verified_colmap_sha256(ctx, &path)?;
        ColmapAdapter::from_path_with_profile(path, profile)
    } else {
        ColmapAdapter::from_path(path)
    }
}

pub(crate) fn image_dir(ctx: &StageContext) -> AppResult<PathBuf> {
    let processed_count = count_images(&ctx.paths.processed_dir);
    let (path, count) = if processed_count > 0 {
        (ctx.paths.processed_dir.clone(), processed_count)
    } else {
        let frames_count = count_images(&ctx.paths.frames_dir);
        (ctx.paths.frames_dir.clone(), frames_count)
    };
    if count == 0 {
        return Err(AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "No Images for COLMAP",
            "Neither processed/ nor frames/ contains supported images for reconstruction.",
        ));
    }
    Ok(path)
}

pub(crate) fn count_images(path: &Path) -> usize {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| {
                            matches!(
                                extension.to_ascii_lowercase().as_str(),
                                "jpg" | "jpeg" | "png"
                            )
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

pub(crate) fn ensure_success(result: &ProcessResult, operation: &str) -> AppResult<()> {
    if result.cancelled {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Cancelled"),
            format!("COLMAP {operation} was cancelled by the user."),
        ));
    }
    if result.timed_out {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Timed Out"),
            format!("COLMAP {operation} exceeded its safety timeout."),
        )
        .retryable(true));
    }
    if !result.is_success() {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Failed"),
            format!("COLMAP {operation} returned an error. Check the stage log for details."),
        )
        .with_technical(format!(
            "exit_code={:?}, log_path={:?}",
            result.exit_code, result.log_path
        ))
        .retryable(true));
    }
    Ok(())
}

pub(crate) fn write_json_atomic<T: Serialize>(value: &T, path: &Path) -> AppResult<()> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        AppError::new(
            "E-9001",
            ErrorCategory::Internal,
            "Failed to Serialize Stage Result",
            "A pipeline stage result could not be serialized.",
        )
        .with_technical(error.to_string())
    })?;
    let mut file = std::fs::File::create(&temporary).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write Stage Result",
            "Could not create a temporary stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    file.write_all(&bytes).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write Stage Result",
            "Could not write a stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    file.sync_all().map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Flush Stage Result",
            "Could not finish writing a stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Save Stage Result",
            "Could not move a stage result file into place.",
        )
        .with_technical(error.to_string())
    })
}

pub(crate) fn model_path(project_dir: &Path, stored_path: &Path) -> PathBuf {
    if stored_path.is_absolute() {
        stored_path.to_path_buf()
    } else {
        project_dir.join(stored_path)
    }
}

pub(crate) fn has_complete_model(path: &Path) -> bool {
    ["cameras", "images", "points3D"].iter().all(|name| {
        path.join(format!("{name}.bin")).is_file() || path.join(format!("{name}.txt")).is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stage::PipelineStage;
    use crate::stages::ColmapMappingStage;
    use splat_domain::pipeline::PipelineStageId;
    use splat_domain::project::ImageFolderSource;
    use splat_domain::runtime::{ColmapBackend, ExecutionProfile};
    use std::sync::Arc;

    fn context(root: &Path, profile_json: &[u8]) -> StageContext {
        let mut ctx = StageContext::new(PipelineStageId::ColmapMapping, root, None);
        std::fs::create_dir_all(&ctx.paths.frames_dir).unwrap();
        std::fs::create_dir_all(&ctx.paths.colmap_dir).unwrap();
        std::fs::write(&ctx.paths.frames_manifest, b"fixture manifest").unwrap();
        let mut project = Project::new("cache profile test");
        project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "images".into(),
            image_count: 3,
            copied_to_project: true,
        }));
        std::fs::write(
            root.join("project.json"),
            serde_json::to_vec(&project).unwrap(),
        )
        .unwrap();
        let binary = root.join("COLMAP 程序");
        std::fs::write(&binary, b"fixture binary").unwrap();
        let mut profile = ExecutionProfile::from_json(profile_json).unwrap();
        profile.engines.colmap.binary_sha256 = sha256_file(&binary).unwrap();
        ctx.engine_paths.colmap = Some(binary);
        ctx.execution_profile = Some(Arc::new(profile));
        ctx
    }

    fn mac_context(root: &Path) -> StageContext {
        context(
            root,
            include_bytes!("../../../../schemas/examples/execution-profile/macos.valid.json"),
        )
    }

    #[test]
    fn profile_fingerprint_invalidates_all_independent_colmap_backends_threads_and_binary() {
        let root = tempfile::tempdir().unwrap();
        let ctx = context(
            root.path(),
            include_bytes!(
                "../../../../schemas/examples/execution-profile/windows-legacy.valid.json"
            ),
        );
        let baseline = cache_fingerprint(&ctx).unwrap();
        for backend in 0..3 {
            let mut changed = ctx.clone();
            let colmap = &mut Arc::make_mut(changed.execution_profile.as_mut().unwrap()).colmap;
            match backend {
                0 => colmap.feature_backend = ColmapBackend::Cpu,
                1 => colmap.matching_backend = ColmapBackend::Cpu,
                _ => colmap.global_positioning_backend = ColmapBackend::Cpu,
            }
            assert_ne!(cache_fingerprint(&changed).unwrap(), baseline);
        }
        let mut changed = ctx.clone();
        Arc::make_mut(changed.execution_profile.as_mut().unwrap())
            .effective_training
            .threads += 1;
        assert_ne!(cache_fingerprint(&changed).unwrap(), baseline);
        let path = ctx.engine_paths.colmap.as_ref().unwrap();
        std::fs::write(path, b"changed binary").unwrap();
        assert_eq!(cache_fingerprint(&ctx).unwrap_err().code, "E-3008");
        Arc::make_mut(changed.execution_profile.as_mut().unwrap())
            .engines
            .colmap
            .binary_sha256 = sha256_file(path).unwrap();
        assert_ne!(cache_fingerprint(&changed).unwrap(), baseline);
        let encoded = serde_json::to_value(baseline).unwrap();
        assert_eq!(encoded["execution"]["colmap"]["cli_profile"], "colmap_4_1");
        assert_eq!(
            encoded["execution"]["colmap"]["database_schema_profile"],
            "colmap_4_1"
        );
        assert_eq!(encoded["execution"]["colmap"]["ba_backend"], "ceres_cpu");
    }

    #[test]
    fn new_run_identity_and_training_only_changes_keep_sfm_cache_valid() {
        let root = tempfile::tempdir().unwrap();
        let mut ctx = mac_context(root.path());
        let baseline = cache_fingerprint(&ctx).unwrap();
        let profile = Arc::make_mut(ctx.execution_profile.as_mut().unwrap());
        profile.run_id = "30303030-3030-4030-8030-303030303030".parse().unwrap();
        profile.effective_training.iterations += 100;
        profile.effective_training.resolution = Some(640);
        profile.effective_training.max_splats = Some(100_000);
        profile.brush.probe_result.status = splat_domain::runtime::CapabilityStatus::Unknown;
        profile.engines.brush.binary_sha256 = "1".repeat(64);
        assert_eq!(cache_fingerprint(&ctx).unwrap(), baseline);
        assert!(profile_fingerprint_matches(&ctx, Some(&baseline)));
    }

    #[test]
    fn legacy_fingerprint_roundtrips_but_cannot_satisfy_an_explicit_cpu_profile() {
        let root = tempfile::tempdir().unwrap();
        let ctx = mac_context(root.path());
        let mut legacy = ctx.clone();
        legacy.execution_profile = None;
        let fingerprint = cache_fingerprint(&legacy).unwrap();
        let encoded = serde_json::to_value(&fingerprint).unwrap();
        assert!(encoded.get("execution").is_none());
        assert_eq!(
            serde_json::from_value::<ColmapCacheFingerprint>(encoded).unwrap(),
            fingerprint
        );
        write_json_atomic(&fingerprint, &fingerprint_path(&ctx)).unwrap();
        assert!(fingerprint_matches(&legacy));
        assert!(!fingerprint_matches(&ctx));
        assert!(profile_fingerprint_matches(&legacy, None));
        assert!(!profile_fingerprint_matches(&ctx, None));
        assert!(!profile_fingerprint_matches(&ctx, Some(&fingerprint)));
    }

    #[test]
    fn mapping_cache_requires_its_own_profile_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let mut ctx = mac_context(root.path());
        let model = ctx.paths.colmap_model_dir();
        std::fs::create_dir_all(&model).unwrap();
        for name in ["cameras.bin", "images.bin", "points3D.bin"] {
            std::fs::write(model.join(name), b"cached model").unwrap();
        }
        let mut result =
            splat_engine_colmap::ColmapResult::new(3, 3, 150, PathBuf::from("colmap/sparse/0"));
        result.strategy_version = 3;
        splat_engine_colmap::write_colmap_result_atomic(&result, &ctx.paths.colmap_result).unwrap();
        let stage = ColmapMappingStage::new();
        assert!(!stage.check_cached(&ctx).unwrap());
        write_json_atomic(
            &cache_fingerprint(&ctx).unwrap(),
            &ctx.paths.colmap_dir.join("mapping-fingerprint.json"),
        )
        .unwrap();
        assert!(stage.check_cached(&ctx).unwrap());
        Arc::make_mut(ctx.execution_profile.as_mut().unwrap())
            .effective_training
            .threads += 1;
        // A freshly written feature fingerprint cannot bless the old mapping.
        write_json_atomic(&cache_fingerprint(&ctx).unwrap(), &fingerprint_path(&ctx)).unwrap();
        assert!(!stage.check_cached(&ctx).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn adapter_checks_binary_hash_before_running_help_and_propagates_cpu_settings() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let mut ctx = mac_context(root.path());
        let binary = ctx.engine_paths.colmap.clone().unwrap();
        std::fs::write(&binary, b"#!/bin/sh\nprintf ran > \"$0.ran\"\nprintf 'COLMAP 4.1.0 (Commit test without CUDA)\\n'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(adapter(&ctx).err().unwrap().code, "E-3008");
        assert!(!root.path().join("COLMAP 程序.ran").exists());
        Arc::make_mut(ctx.execution_profile.as_mut().unwrap())
            .engines
            .colmap
            .binary_sha256 = sha256_file(&binary).unwrap();
        let adapter = adapter(&ctx).unwrap();
        let settings = adapter.execution_settings().unwrap();
        assert_eq!(settings.platform(), RuntimePlatform::Macos);
        assert_eq!(settings.threads(), 4);
        assert!(!settings.feature_uses_gpu());
        assert!(root.path().join("COLMAP 程序.ran").exists());
    }
}
