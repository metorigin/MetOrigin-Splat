//! Freeze measured engine identity and explicit platform resource settings before
//! the pipeline starts. Shared requested preset files remain unchanged.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use splat_domain::runtime::*;
use splat_domain::PipelineStageId;
use splat_domain::{AppError, AppResult, EnginePaths, ErrorCategory, ExecutionProfile};
use splat_engine_brush::runtime::BrushCapabilities;
use splat_engine_brush::{TrainingConfig, VerifiedBrushRuntime};

const GIB: u64 = 1024 * 1024 * 1024;

/// Earliest affected stage; changing only the run UUID or current probe result
/// does not invalidate computed data. Stage fingerprints additionally bind inputs.
pub(crate) fn profile_invalidation_stage(
    previous: Option<&ExecutionProfile>,
    current: &ExecutionProfile,
) -> Option<PipelineStageId> {
    let Some(previous) = previous else {
        return Some(PipelineStageId::ColmapFeatureExtraction);
    };
    if previous.engines.ffmpeg != current.engines.ffmpeg
        || previous.engines.ffprobe != current.engines.ffprobe
    {
        return Some(PipelineStageId::FrameExtraction);
    }
    if previous.platform != current.platform
        || previous.architecture != current.architecture
        || previous.engines.colmap != current.engines.colmap
        || previous.colmap != current.colmap
        || previous.effective_training.threads != current.effective_training.threads
    {
        return Some(PipelineStageId::ColmapFeatureExtraction);
    }
    if previous.engines.brush != current.engines.brush
        || previous.brush.cli_profile != current.brush.cli_profile
        || previous.brush.backend != current.brush.backend
        || previous.effective_training != current.effective_training
        || (current.platform == RuntimePlatform::Windows
            && current.brush.cli_profile == BrushCliProfile::Metorigin1
            && previous.brush.probe_result.device_id != current.brush.probe_result.device_id)
    {
        return Some(PipelineStageId::TrainingPreparation);
    }
    None
}

pub struct MacosProfileRequest {
    pub os_version: String,
    pub physical_memory_bytes: u64,
    pub available_threads: u32,
    pub preset: String,
    pub requested_resolution: u32,
    pub engine_paths: EnginePaths,
    pub engine_pack_id: Option<String>,
}

/// Initial conservative M1 limits. These are policy limits, not measured peak
/// usage or OS-enforced allocations. M3 acceptance requires 16/32 GB real runs.
pub fn macos_training_limits(
    preset: &str,
    requested_resolution: u32,
    physical_memory_bytes: u64,
    available_threads: u32,
) -> AppResult<(MemoryBudget, EffectiveTraining)> {
    if physical_memory_bytes < 8 * GIB || available_threads == 0 || requested_resolution == 0 {
        return Err(runtime_error("Physical memory, CPU count or requested resolution is unavailable or below the experimental minimum."));
    }
    let requested = TrainingConfig::from_builtin(preset)?;
    let (budget, cache, splats, resolution, max_steps, max_sh, threads) =
        if physical_memory_bytes >= 32 * GIB {
            (16 * GIB, GIB, 1_500_000, 1920, 7000, 1, 6)
        } else if physical_memory_bytes >= 16 * GIB {
            (8 * GIB, GIB / 2, 500_000, 1280, 7000, 1, 4)
        } else {
            (3 * GIB, GIB / 4, 300_000, 960, 3000, 0, 2)
        };
    Ok((
        MemoryBudget {
            kind: MemoryKind::Unified,
            physical_memory_bytes: Some(physical_memory_bytes),
            training_budget_bytes: Some(budget),
            available_working_set_bytes: None,
        },
        EffectiveTraining {
            iterations: requested.iterations.min(max_steps),
            sh_degree: requested.sh_degree.min(max_sh),
            resolution: Some(requested_resolution.min(resolution)),
            image_cache_budget_bytes: Some(cache),
            max_splats: Some(splats),
            threads: available_threads.min(threads),
            lod_levels: Some(0),
        },
    ))
}

pub async fn freeze_macos_execution_profile(
    request: MacosProfileRequest,
    brush: &VerifiedBrushRuntime,
) -> AppResult<ExecutionProfile> {
    if brush.capabilities.target != "aarch64-apple-darwin" {
        return Err(runtime_error(
            "macOS requires the arm64 Darwin Brush build.",
        ));
    }
    if !brush.capabilities.supports("loader_thread_limit") {
        return Err(runtime_error(
            "The installed Brush does not support an explicit image-loader thread limit.",
        ));
    }
    let (memory, effective_training) = macos_training_limits(
        &request.preset,
        request.requested_resolution,
        request.physical_memory_bytes,
        request.available_threads,
    )?;
    let paths = request.engine_paths;
    let expected_brush_hash = brush.binary_sha256.clone();
    let colmap_threads = effective_training.threads;
    let identities = tokio::task::spawn_blocking(move || {
        read_engine_identities(
            paths,
            expected_brush_hash,
            RuntimePlatform::Macos,
            macos_colmap_execution(),
            colmap_threads,
        )
    })
    .await
    .map_err(|_| runtime_error("Engine identity collection did not finish."))??;
    let warm_start = brush.capabilities.supports("ply_warm_start")
        && brush.capabilities.resume_mode == ResumeMode::PlyWarmStartOptimizerReset;
    let (live_preview, live_protocol) = negotiate_live_preview(&brush.capabilities);
    let identity = &brush.capabilities.identity;
    let profile = ExecutionProfile {
        schema_version: EXECUTION_PROFILE_SCHEMA_VERSION,
        run_id: *splat_domain::ProjectId::new().as_uuid(),
        platform: RuntimePlatform::Macos,
        architecture: Architecture::Arm64,
        os_version: request.os_version,
        engine_pack_id: request.engine_pack_id,
        engines: RuntimeEngines {
            ffmpeg: identities.0,
            ffprobe: identities.1,
            colmap: identities.2,
            brush: EngineIdentity {
                version: identity.engine_version.clone(),
                source_commit: Some(identity.source_commit.clone()),
                binary_sha256: brush.binary_sha256.clone(),
            },
        },
        colmap: macos_colmap_execution(),
        brush: BrushExecution {
            cli_profile: BrushCliProfile::Metorigin1,
            backend: BrushBackend::Metal,
            probe_result: brush.probe.training_probe(),
            live_preview,
            ply_warm_start: if warm_start {
                CapabilityStatus::Supported
            } else {
                CapabilityStatus::Unsupported
            },
        },
        memory,
        effective_training,
        live_protocol,
        resume_mode: if warm_start {
            ResumeMode::PlyWarmStartOptimizerReset
        } else {
            ResumeMode::Disabled
        },
    };
    profile.validate_for_execution()?;
    Ok(profile)
}

/// Explicit execution resource settings, independent of requested preset quality.
/// The recorded planning budget is not an enforced VRAM quota or measured usage;
/// an absent adapter budget remains unknown. These settings do not establish that
/// a scene will fit, and must never silently reduce its iterations, SH or resolution.
#[derive(Debug, Clone)]
pub struct WindowsTrainingPolicy {
    /// Planning reference retained by the v1 profile contract, not a GPU limit.
    pub training_budget_bytes: u64,
    pub image_cache_budget_bytes: u64,
    pub max_splats: u32,
    pub max_threads: u32,
}

impl WindowsTrainingPolicy {
    pub fn candidate() -> Self {
        Self {
            training_budget_bytes: 4 * GIB,
            image_cache_budget_bytes: GIB / 4,
            max_splats: 300_000,
            max_threads: 2,
        }
    }
}

pub struct WindowsProfileRequest {
    pub os_version: String,
    pub physical_memory_bytes: u64,
    pub available_threads: u32,
    /// Budget of the WGPU-selected adapter, not a separately enumerated NVIDIA GPU.
    pub available_adapter_budget_bytes: Option<u64>,
    pub policy: WindowsTrainingPolicy,
    pub preset: String,
    pub requested_resolution: u32,
    pub engine_paths: EnginePaths,
    pub engine_pack_id: Option<String>,
}

pub fn windows_training_limits(
    preset: &str,
    resolution: u32,
    physical_memory: u64,
    available_threads: u32,
    adapter_budget: Option<u64>,
    policy: &WindowsTrainingPolicy,
) -> AppResult<(MemoryBudget, EffectiveTraining)> {
    if physical_memory < 8 * GIB
        || available_threads == 0
        || resolution == 0
        || policy.training_budget_bytes == 0
        || policy.image_cache_budget_bytes == 0
        || policy.max_splats == 0
        || policy.max_threads == 0
        || policy.image_cache_budget_bytes > physical_memory / 4
        || policy.image_cache_budget_bytes > policy.training_budget_bytes
        || adapter_budget.is_some_and(|budget| budget < policy.training_budget_bytes)
    {
        return Err(runtime_error("Windows candidate resource policy is unavailable or exceeds the observed adapter/RAM budget."));
    }
    let requested = TrainingConfig::from_builtin(preset)?;
    Ok((
        MemoryBudget {
            kind: MemoryKind::Dedicated,
            physical_memory_bytes: Some(physical_memory),
            training_budget_bytes: Some(policy.training_budget_bytes),
            available_working_set_bytes: adapter_budget,
        },
        EffectiveTraining {
            iterations: requested.iterations,
            sh_degree: requested.sh_degree,
            resolution: Some(resolution),
            image_cache_budget_bytes: Some(policy.image_cache_budget_bytes),
            max_splats: Some(policy.max_splats),
            threads: available_threads.min(policy.max_threads),
            lod_levels: Some(0),
        },
    ))
}

pub async fn freeze_windows_execution_profile(
    request: WindowsProfileRequest,
    brush: &VerifiedBrushRuntime,
) -> AppResult<ExecutionProfile> {
    // Re-parse supplied evidence at the boundary; public structs cannot bypass
    // actual compute/target validation merely by constructing a value in memory.
    let caps = BrushCapabilities::from_json(
        &serde_json::to_vec(&brush.capabilities)
            .map_err(|_| runtime_error("Invalid Brush capabilities."))?,
    )?;
    let probe = splat_engine_brush::runtime::BrushComputeProbe::from_json(
        &serde_json::to_vec(&brush.probe).map_err(|_| runtime_error("Invalid Brush probe."))?,
        &caps,
    )?;
    if caps.target != "x86_64-pc-windows-msvc" || !caps.supports("loader_thread_limit") {
        return Err(runtime_error(
            "Windows requires the paired Brush build with loader-thread limits.",
        ));
    }
    let backend = probe
        .backend
        .ok_or_else(|| runtime_error("Windows backend is unknown."))?;
    let (memory, effective_training) = windows_training_limits(
        &request.preset,
        request.requested_resolution,
        request.physical_memory_bytes,
        request.available_threads,
        request.available_adapter_budget_bytes,
        &request.policy,
    )?;
    let colmap = windows_colmap_execution();
    let paths = request.engine_paths;
    let expected_brush_hash = brush.binary_sha256.clone();
    let settings = colmap.clone();
    let threads = effective_training.threads;
    let identities = tokio::task::spawn_blocking(move || {
        read_engine_identities(
            paths,
            expected_brush_hash,
            RuntimePlatform::Windows,
            settings,
            threads,
        )
    })
    .await
    .map_err(|_| runtime_error("Engine identity collection did not finish."))??;
    let warm_start = caps.supports("ply_warm_start")
        && caps.resume_mode == ResumeMode::PlyWarmStartOptimizerReset;
    let (live_preview, live_protocol) = negotiate_live_preview(&caps);
    let profile = ExecutionProfile {
        schema_version: EXECUTION_PROFILE_SCHEMA_VERSION,
        run_id: *splat_domain::ProjectId::new().as_uuid(),
        platform: RuntimePlatform::Windows,
        architecture: Architecture::X86_64,
        os_version: request.os_version,
        engine_pack_id: request.engine_pack_id,
        engines: RuntimeEngines {
            ffmpeg: identities.0,
            ffprobe: identities.1,
            colmap: identities.2,
            brush: EngineIdentity {
                version: caps.identity.engine_version,
                source_commit: Some(caps.identity.source_commit),
                binary_sha256: brush.binary_sha256.clone(),
            },
        },
        colmap,
        brush: BrushExecution {
            cli_profile: BrushCliProfile::Metorigin1,
            backend,
            probe_result: probe.training_probe(),
            live_preview,
            ply_warm_start: if warm_start {
                CapabilityStatus::Supported
            } else {
                CapabilityStatus::Unsupported
            },
        },
        memory,
        effective_training,
        live_protocol,
        resume_mode: if warm_start {
            ResumeMode::PlyWarmStartOptimizerReset
        } else {
            ResumeMode::Disabled
        },
    };
    profile.validate_for_execution()?;
    Ok(profile)
}

fn windows_colmap_execution() -> ColmapExecution {
    ColmapExecution {
        cli_profile: ColmapCliProfile::Colmap41,
        database_schema_profile: ColmapDatabaseProfile::Colmap41,
        feature_backend: ColmapBackend::Cuda,
        matching_backend: ColmapBackend::Cuda,
        global_positioning_backend: ColmapBackend::Cpu,
        ba_backend: BundleAdjustmentBackend::CeresCpu,
    }
}

fn negotiate_live_preview(capabilities: &BrushCapabilities) -> (CapabilityStatus, LiveProtocol) {
    if capabilities.supports("live_preview")
        && capabilities.live_protocol == LiveProtocol::PlyRequestAckV1
    {
        (CapabilityStatus::Supported, LiveProtocol::PlyRequestAckV1)
    } else {
        (CapabilityStatus::Unsupported, LiveProtocol::Disabled)
    }
}

fn read_engine_identities(
    paths: EnginePaths,
    brush_hash: String,
    platform: RuntimePlatform,
    colmap_settings: ColmapExecution,
    colmap_threads: u32,
) -> AppResult<(EngineIdentity, EngineIdentity, EngineIdentity)> {
    let ffmpeg = required(paths.ffmpeg, "FFmpeg")?;
    let ffprobe = required(paths.ffprobe, "FFprobe")?;
    let colmap = required(paths.colmap, "COLMAP")?;
    let brush = required(paths.brush, "Brush")?;
    let before = [
        hash_file(&ffmpeg)?,
        hash_file(&ffprobe)?,
        hash_file(&colmap)?,
    ];
    let ffmpeg_adapter =
        splat_engine_ffmpeg::FfmpegAdapter::from_paths(ffmpeg.clone(), ffprobe.clone())?;
    let versions = [
        ffmpeg_adapter.version().to_string(),
        ffmpeg_adapter.ffprobe_version()?,
        splat_engine_colmap::ColmapAdapter::from_path_with_settings(
            colmap.clone(),
            splat_engine_colmap::ColmapExecutionSettings::new(
                platform,
                colmap_settings,
                colmap_threads,
            )?,
        )?
        .engine_info()
        .version
        .ok_or_else(|| runtime_error("COLMAP version is unknown."))?,
    ];
    if !media_version_supported(platform, &versions[0])
        || !media_version_supported(platform, &versions[1])
        || versions[2] != "4.1.0"
    {
        return Err(runtime_error(if platform == RuntimePlatform::Macos {
            "macOS requires FFmpeg/FFprobe 8.1.2 and COLMAP 4.1.0."
        } else {
            "Windows requires FFmpeg/FFprobe 8.1.2 and COLMAP 4.1.0."
        }));
    }
    let after = [
        hash_file(&ffmpeg)?,
        hash_file(&ffprobe)?,
        hash_file(&colmap)?,
    ];
    if before != after || hash_file(&brush)? != brush_hash {
        return Err(runtime_error(
            "An engine executable changed during preflight.",
        ));
    }
    let make = |index: usize| EngineIdentity {
        version: versions[index].clone(),
        source_commit: None,
        binary_sha256: after[index].clone(),
    };
    Ok((make(0), make(1), make(2)))
}

fn media_version_supported(platform: RuntimePlatform, version: &str) -> bool {
    match platform {
        RuntimePlatform::Macos => version == "8.1.2",
        // The SHA-locked Windows archive reports its vendor suffix as part of
        // the version token. Preserve that full identity in the run record.
        RuntimePlatform::Windows => {
            matches!(version, "8.1.2" | "8.1.2-essentials_build-www.gyan.dev")
        }
    }
}

fn macos_colmap_execution() -> ColmapExecution {
    ColmapExecution {
        cli_profile: ColmapCliProfile::Colmap41,
        database_schema_profile: ColmapDatabaseProfile::Colmap41,
        feature_backend: ColmapBackend::Cpu,
        matching_backend: ColmapBackend::Cpu,
        global_positioning_backend: ColmapBackend::Cpu,
        ba_backend: BundleAdjustmentBackend::CeresCpu,
    }
}

fn required(path: Option<PathBuf>, engine: &str) -> AppResult<PathBuf> {
    path.ok_or_else(|| {
        runtime_error(&format!(
            "{engine} is missing from the resolved engine paths."
        ))
    })
}

pub(crate) fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path).map_err(|error| runtime_error(&error.to_string()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| runtime_error(&error.to_string()))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn runtime_error(detail: &str) -> AppError {
    AppError::new(
        "E-1403",
        ErrorCategory::Environment,
        "运行配置不可执行",
        "无法确认本次运行的引擎版本或资源限制，请检查引擎设置。",
    )
    .with_technical(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mac_wrapper_retains_the_arm64_target_guard_after_windows_extension() {
        let identity = splat_engine_brush::runtime::BrushMachineIdentity {
            schema_version: 1,
            engine: "brush".into(),
            engine_version: "1.0.0+metorigin-windows.1".into(),
            source_commit: "1388f74c6fe0236f68ee4915564bf00e9d2e3747".into(),
            build_id: "metorigin-windows.1".into(),
        };
        let runtime = VerifiedBrushRuntime {
            capabilities: BrushCapabilities {
                identity: identity.clone(),
                cli_profile: BrushCliProfile::Metorigin1,
                target: "x86_64-pc-windows-msvc".into(),
                supported_features: vec!["loader_thread_limit".into()],
                live_protocol: LiveProtocol::Disabled,
                resume_mode: ResumeMode::Disabled,
            },
            probe: splat_engine_brush::runtime::BrushComputeProbe {
                identity,
                probe_kind: ProbeKind::ComputeSmoke,
                status: CapabilityStatus::Supported,
                backend: Some(BrushBackend::Metal),
                device_name: Some("fixture".into()),
                device_type: Some("IntegratedGpu".into()),
                device_id: None,
                compute: None,
            },
            binary_sha256: "f".repeat(64),
        };
        let error = freeze_macos_execution_profile(
            MacosProfileRequest {
                os_version: "15.0".into(),
                physical_memory_bytes: 16 * GIB,
                available_threads: 4,
                preset: "fast".into(),
                requested_resolution: 960,
                engine_paths: EnginePaths::default(),
                engine_pack_id: None,
            },
            &runtime,
        )
        .await
        .unwrap_err();
        assert!(error
            .technical_message
            .as_deref()
            .unwrap()
            .contains("arm64 Darwin"));
    }

    #[test]
    fn live_preview_requires_both_feature_and_known_protocol() {
        let mut capabilities = BrushCapabilities::from_json(
            br#"{
                "schema_version": 1, "engine": "brush",
                "engine_version": "1.0.0+metorigin-macos.4",
                "source_commit": "1388f74c6fe0236f68ee4915564bf00e9d2e3747",
                "build_id": "metorigin-macos.4", "cli_profile": "metorigin_1",
                "target": "aarch64-apple-darwin",
                "supported_features": ["capabilities_json", "compute_probe", "ply_checkpoint", "live_preview"],
                "live_protocol": "ply_request_ack_v1", "resume_mode": "disabled"
            }"#,
        )
        .unwrap();
        assert_eq!(
            negotiate_live_preview(&capabilities),
            (CapabilityStatus::Supported, LiveProtocol::PlyRequestAckV1)
        );
        capabilities.live_protocol = LiveProtocol::Disabled;
        assert_eq!(
            negotiate_live_preview(&capabilities),
            (CapabilityStatus::Unsupported, LiveProtocol::Disabled)
        );
        capabilities.live_protocol = LiveProtocol::PlyRequestAckV1;
        capabilities
            .supported_features
            .retain(|value| value != "live_preview");
        assert_eq!(
            negotiate_live_preview(&capabilities),
            (CapabilityStatus::Unsupported, LiveProtocol::Disabled)
        );
    }

    #[test]
    fn resource_limits_preserve_small_requests_and_bound_large_ones() {
        let (memory, training) = macos_training_limits("quality", 3840, 16 * GIB, 12).unwrap();
        assert_eq!(training.resolution, Some(1280));
        assert_eq!(training.image_cache_budget_bytes, Some(GIB / 2));
        assert_eq!(training.max_splats, Some(500_000));
        assert_eq!(training.threads, 4);
        assert_eq!(training.lod_levels, Some(0));
        assert_eq!(training.iterations, 7000);
        assert_eq!(training.sh_degree, 1);
        assert_eq!(memory.available_working_set_bytes, None);
        let (_, small) = macos_training_limits("fast", 960, 32 * GIB, 2).unwrap();
        assert_eq!(small.resolution, Some(960));
        assert_eq!(small.iterations, 3000);
        assert_eq!(small.sh_degree, 0);
        assert_eq!(small.threads, 2);
    }

    #[test]
    fn unknown_resources_are_not_treated_as_an_unlimited_budget() {
        assert!(macos_training_limits("fast", 1280, 0, 8).is_err());
        assert!(macos_training_limits("fast", 1280, 16 * GIB, 0).is_err());
        assert!(macos_training_limits("fast", 0, 16 * GIB, 8).is_err());
    }

    #[test]
    fn profile_changes_invalidate_only_affected_stages() {
        let original = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        let mut next = original.clone();
        next.run_id = *splat_domain::ProjectId::new().as_uuid();
        next.brush.probe_result.device_name = Some("Another observed device".into());
        assert_eq!(profile_invalidation_stage(Some(&original), &next), None);
        next.effective_training.max_splats = Some(400_000);
        assert_eq!(
            profile_invalidation_stage(Some(&original), &next),
            Some(PipelineStageId::TrainingPreparation)
        );
        next.effective_training.threads += 1;
        assert_eq!(
            profile_invalidation_stage(Some(&original), &next),
            Some(PipelineStageId::ColmapFeatureExtraction)
        );
        next.engines.ffmpeg.binary_sha256 = "f".repeat(64);
        assert_eq!(
            profile_invalidation_stage(Some(&original), &next),
            Some(PipelineStageId::FrameExtraction)
        );
        assert_eq!(
            profile_invalidation_stage(None, &next),
            Some(PipelineStageId::ColmapFeatureExtraction)
        );
    }
}

#[cfg(test)]
mod windows_tests {
    use super::*;
    #[test]
    fn locked_windows_vendor_version_preserves_the_mac_exact_version_rule() {
        assert!(media_version_supported(
            RuntimePlatform::Windows,
            "8.1.2-essentials_build-www.gyan.dev"
        ));
        assert!(media_version_supported(RuntimePlatform::Windows, "8.1.2"));
        assert!(media_version_supported(RuntimePlatform::Macos, "8.1.2"));
        assert!(!media_version_supported(
            RuntimePlatform::Macos,
            "8.1.2-essentials_build-www.gyan.dev"
        ));
        for version in ["8.1.20", "8.1.2-rc1", "8.1.2-unknown", "8.2.0", "9.0.0"] {
            assert!(!media_version_supported(RuntimePlatform::Windows, version));
        }
    }

    #[test]
    fn windows_preserves_each_requested_builtin_preset_quality() {
        let policy = WindowsTrainingPolicy::candidate();
        for (preset, iterations, sh_degree, resolution) in [
            ("fast", 3000, 0, 1280),
            ("balanced", 7000, 1, 1920),
            ("quality", 30000, 2, 2560),
        ] {
            let (memory, training) =
                windows_training_limits(preset, resolution, 16 * GIB, 12, None, &policy).unwrap();
            assert_eq!(training.iterations, iterations, "{preset}");
            assert_eq!(training.sh_degree, sh_degree, "{preset}");
            assert_eq!(training.resolution, Some(resolution), "{preset}");
            assert_eq!(training.image_cache_budget_bytes, Some(GIB / 4));
            assert_eq!(training.max_splats, Some(300_000));
            assert_eq!(training.threads, 2);
            assert_eq!(training.lod_levels, Some(0));
            assert_eq!(memory.available_working_set_bytes, None);
        }
    }

    #[test]
    fn windows_requested_preset_quality_reaches_production_brush_argv() {
        let policy = WindowsTrainingPolicy::candidate();
        let paths = std::env::temp_dir().join("metorigin-argv-contract");
        for (preset, iterations, sh_degree, resolution) in [
            ("fast", "3000", "0", 1280),
            ("balanced", "7000", "1", 1920),
            ("quality", "30000", "2", 2560),
        ] {
            let (_, effective) =
                windows_training_limits(preset, resolution, 16 * GIB, 12, None, &policy).unwrap();
            let args = TrainingConfig::from_builtin(preset)
                .unwrap()
                .to_cli_args_for_profile(
                    BrushCliProfile::Metorigin1,
                    &effective,
                    &paths.join("dataset"),
                    &paths.join("checkpoints"),
                    0,
                )
                .unwrap();
            let args: Vec<_> = args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            for (flag, expected) in [
                ("--total-train-iters", iterations.to_string()),
                ("--sh-degree", sh_degree.to_string()),
                ("--max-resolution", resolution.to_string()),
                ("--max-scene-batch-cache-size", (GIB / 4).to_string() + "B"),
                ("--max-splats", "300000".to_string()),
                ("--num-loader-threads", "2".to_string()),
                ("--lod-levels", "0".to_string()),
            ] {
                let matches: Vec<_> = args.windows(2).filter(|pair| pair[0] == flag).collect();
                assert_eq!(matches.len(), 1, "{preset}: {flag}");
                assert_eq!(matches[0][1], expected, "{preset}: {flag}");
            }
            assert!(!args.iter().any(|arg| arg == "--total-steps"));
        }
    }

    #[test]
    fn windows_resource_settings_do_not_infer_available_vram_or_reduce_quality() {
        let policy = WindowsTrainingPolicy::candidate();
        let (memory, training) =
            windows_training_limits("quality", 3840, 16 * GIB, 12, None, &policy).unwrap();
        assert_eq!(memory.available_working_set_bytes, None);
        assert_eq!(memory.kind, MemoryKind::Dedicated);
        assert_eq!(memory.training_budget_bytes, Some(4 * GIB));
        assert_eq!(training.resolution, Some(3840));
        assert_eq!(training.iterations, 30000);
        assert_eq!(training.sh_degree, 2);
        assert_eq!(training.threads, 2);
        let (observed, same) =
            windows_training_limits("quality", 3840, 8 * GIB, 12, Some(6 * GIB), &policy).unwrap();
        assert_eq!(observed.available_working_set_bytes, Some(6 * GIB));
        assert_eq!(same, training);
        let (_, explicit_smoke_resolution) =
            windows_training_limits("fast", 960, 16 * GIB, 1, None, &policy).unwrap();
        assert_eq!(explicit_smoke_resolution.resolution, Some(960));
        assert_eq!(explicit_smoke_resolution.threads, 1);
    }

    #[test]
    fn windows_invalid_resource_settings_are_rejected_instead_of_reducing_quality() {
        let policy = WindowsTrainingPolicy::candidate();
        assert!(windows_training_limits("fast", 960, 16 * GIB, 8, Some(3 * GIB), &policy).is_err());
        assert!(windows_training_limits("fast", 960, 0, 8, None, &policy).is_err());
        assert!(windows_training_limits("fast", 960, 16 * GIB, 0, None, &policy).is_err());
        assert!(windows_training_limits("quality", 0, 16 * GIB, 8, None, &policy).is_err());
        assert!(windows_training_limits("unknown", 960, 16 * GIB, 8, None, &policy).is_err());
        for invalid in [
            WindowsTrainingPolicy {
                image_cache_budget_bytes: 0,
                ..policy.clone()
            },
            WindowsTrainingPolicy {
                training_budget_bytes: 0,
                ..policy.clone()
            },
            WindowsTrainingPolicy {
                max_splats: 0,
                ..policy.clone()
            },
            WindowsTrainingPolicy {
                max_threads: 0,
                ..policy.clone()
            },
            WindowsTrainingPolicy {
                image_cache_budget_bytes: 5 * GIB,
                ..policy.clone()
            },
        ] {
            assert!(windows_training_limits("quality", 2560, 16 * GIB, 8, None, &invalid).is_err());
        }
    }

    #[test]
    fn existing_windows_profiles_stay_valid_and_quality_changes_invalidate_training() {
        let previous = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/windows1-dx12.valid.json"
        ))
        .unwrap();
        previous.validate_for_execution().unwrap();
        let original = previous.clone();
        let mut next = previous.clone();
        let (_, requested) = windows_training_limits(
            "quality",
            2560,
            16 * GIB,
            8,
            None,
            &WindowsTrainingPolicy::candidate(),
        )
        .unwrap();
        next.effective_training = requested;
        next.validate_for_execution().unwrap();
        // This older fixture also used four threads; changing that independent
        // resource setting retains the existing earlier COLMAP invalidation.
        assert_eq!(
            profile_invalidation_stage(Some(&previous), &next),
            Some(PipelineStageId::ColmapFeatureExtraction)
        );
        next.effective_training.threads = previous.effective_training.threads;
        assert_eq!(
            profile_invalidation_stage(Some(&previous), &next),
            Some(PipelineStageId::TrainingPreparation)
        );
        assert_eq!(previous, original);
    }
    #[test]
    fn windows_adapter_change_invalidates_training_without_changing_mac_policy() {
        let original = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/windows1-dx12.valid.json"
        ))
        .unwrap();
        let mut next = original.clone();
        next.brush.probe_result.device_id = Some("other".into());
        assert_eq!(
            profile_invalidation_stage(Some(&original), &next),
            Some(PipelineStageId::TrainingPreparation)
        );
    }
}
