use super::*;
use crate::runtime::{BrushCapabilities, BrushComputeProbe};
use serde_json::json;
use splat_domain::runtime::{CapabilityStatus, EffectiveTraining};

struct Fixture {
    directory: tempfile::TempDir,
    adapter: BrushAdapter,
    config: TrainingConfig,
    profile: ExecutionProfile,
    runtime: VerifiedBrushRuntime,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("Brush CLI 引擎");
        std::fs::write(&binary, b"test binary identity").unwrap();
        std::fs::create_dir(directory.path().join("dataset 中文 空格")).unwrap();
        let mut profile = ExecutionProfile::from_json(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schemas/examples/execution-profile/macos.valid.json"
        )))
        .unwrap();
        let mut identity = json!({
            "schema_version":1,"engine":"brush","engine_version":"1.0.0+metorigin-macos.3",
            "build_id":"metorigin-macos.3","source_commit":"1388f74c6fe0236f68ee4915564bf00e9d2e3747"
        });
        let mut capabilities = identity.clone();
        capabilities.as_object_mut().unwrap().extend(json!({
            "cli_profile":"metorigin_1", "target":"aarch64-apple-darwin",
            "supported_features":["capabilities_json","compute_probe","ply_checkpoint","ply_warm_start","loader_thread_limit"],
            "live_protocol":"disabled", "resume_mode":"ply_warm_start_optimizer_reset"
        }).as_object().unwrap().clone());
        let capabilities =
            BrushCapabilities::from_json(&serde_json::to_vec(&capabilities).unwrap()).unwrap();
        identity.as_object_mut().unwrap().extend(
            json!({
                "probe_kind":"compute_smoke","status":"supported","backend":"metal",
                "device_name":"Fixture GPU","device_type":"IntegratedGpu",
                "compute":{"gaussian_count":8,"width":32,"height":32,"forward_finite":true,
                    "gradient_finite":true,"loss":0.1,"gradient_l1":0.03}
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let probe =
            BrushComputeProbe::from_json(&serde_json::to_vec(&identity).unwrap(), &capabilities)
                .unwrap();
        let runtime = VerifiedBrushRuntime {
            capabilities,
            probe,
            binary_sha256: crate::runtime::hash_binary(&binary).unwrap(),
        };
        profile.engines.brush.binary_sha256 = runtime.binary_sha256.clone();
        profile.engines.brush.version = runtime.capabilities.identity.engine_version.clone();
        profile.brush.probe_result = runtime.probe.training_probe();
        Self {
            directory,
            adapter: BrushAdapter {
                brush_path: binary,
                brush_version: "brush-cli 1.0.0+metorigin-macos.3".into(),
            },
            config: TrainingConfig::from_builtin("fast").unwrap(),
            profile,
            runtime,
        }
    }

    fn dataset(&self) -> PathBuf {
        self.directory.path().join("dataset 中文 空格")
    }

    fn command(&self, start_iteration: u32) -> AppResult<CommandSpec> {
        self.adapter
            .build_train_command_for_profile(ProfiledTrainingRequest {
                config: &self.config,
                profile: &self.profile,
                verified_runtime: Some(&self.runtime),
                dataset_path: &self.dataset(),
                checkpoint_path: &self.directory.path().join("checkpoints 中文 空格"),
                start_iteration,
                log_path: &self.directory.path().join("training.log"),
            })
    }

    fn enable_resume(&mut self) {
        self.profile.resume_mode = ResumeMode::PlyWarmStartOptimizerReset;
        self.profile.brush.ply_warm_start = CapabilityStatus::Supported;
    }
}

fn argument<'a>(command: &'a CommandSpec, flag: &str) -> &'a std::ffi::OsStr {
    let index = command.args.iter().position(|arg| arg == flag).unwrap();
    &command.args[index + 1]
}

#[test]
fn mac_command_uses_effective_limits_and_preserves_path_tokens() {
    let fixture = Fixture::new();
    let command = fixture.command(0).unwrap();
    assert_eq!(command.args[0], fixture.dataset().as_os_str());
    for (flag, expected) in [
        ("--total-train-iters", "300"),
        ("--sh-degree", "0"),
        ("--max-resolution", "960"),
        ("--max-splats", "300000"),
        ("--max-scene-batch-cache-size", "536870912B"),
        ("--num-loader-threads", "4"),
        ("--lod-levels", "0"),
        ("--units-per-meter", "1"),
        ("--export-every", "100"),
        ("--export-name", "checkpoint_{iter}.ply"),
    ] {
        assert_eq!(argument(&command, flag), expected);
    }
    assert_eq!(
        argument(&command, "--export-path"),
        fixture
            .directory
            .path()
            .join("checkpoints 中文 空格")
            .as_os_str()
    );
    assert!(!command
        .args
        .iter()
        .any(|arg| arg == "--total-steps" || arg == "--max-frames"));
    assert_eq!(
        command
            .env
            .get(std::ffi::OsStr::new("TOKIO_WORKER_THREADS"))
            .unwrap(),
        "4"
    );
    assert_eq!(
        command
            .env
            .get(std::ffi::OsStr::new("RAYON_NUM_THREADS"))
            .unwrap(),
        "4"
    );
    assert_eq!(
        fixture.config.iterations, 3000,
        "requested presets must remain unchanged"
    );
}

#[test]
fn windows_profile_preserves_the_entire_legacy_command() {
    let mut fixture = Fixture::new();
    fixture.adapter.brush_version = "brush_app 0.3.0+metorigin-live.1".into();
    fixture.profile = ExecutionProfile::from_json(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../schemas/examples/execution-profile/windows-legacy.valid.json"
    )))
    .unwrap();
    fixture.profile.engines.brush.binary_sha256 = fixture.adapter.binary_sha256().unwrap();
    let dataset = Path::new("dataset with spaces");
    let checkpoints = Path::new("checkpoints with spaces");
    let effective = fixture
        .config
        .with_effective_training(&fixture.profile.effective_training)
        .unwrap();
    let checked = fixture
        .adapter
        .build_train_command_for_profile(ProfiledTrainingRequest {
            config: &fixture.config,
            profile: &fixture.profile,
            verified_runtime: None,
            dataset_path: dataset,
            checkpoint_path: checkpoints,
            start_iteration: 100,
            log_path: Path::new("training.log"),
        })
        .unwrap();
    let legacy = fixture.adapter.build_train_command(
        &effective,
        dataset,
        checkpoints,
        100,
        Path::new("training.log"),
    );
    assert_eq!(checked.args, legacy.args);
    assert_eq!(checked.env, legacy.env);
    assert_eq!(checked.cwd, legacy.cwd);
}

#[test]
fn version_selection_rejects_unknown_cli_families() {
    for version in [
        "brush-cli 1.1.0",
        "brush-cli 1.0.0-rc1",
        "brush 0.4.0",
        "unknown",
    ] {
        assert!(cli_profile_from_version(version).is_err());
    }
    assert_eq!(
        cli_profile_from_version("brush_app 0.3.0+metorigin-live.1").unwrap(),
        BrushCliProfile::Legacy03
    );
}

#[test]
fn changed_binary_or_missing_loader_capability_is_not_silently_accepted() {
    let fixture = Fixture::new();
    std::fs::write(&fixture.adapter.brush_path, b"different engine").unwrap();
    assert_eq!(fixture.command(0).unwrap_err().code, "E-1403");
    let mut fixture = Fixture::new();
    fixture
        .runtime
        .capabilities
        .supported_features
        .retain(|feature| feature != "loader_thread_limit");
    assert_eq!(fixture.command(0).unwrap_err().code, "E-1403");
}

#[test]
fn evidence_for_another_device_or_binary_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.runtime.probe.device_name = Some("Other GPU".into());
    assert!(fixture.command(0).is_err());
    let mut fixture = Fixture::new();
    fixture.runtime.binary_sha256 = "0".repeat(64);
    assert!(fixture.command(0).is_err());
}

#[test]
fn unmanaged_dataset_configuration_and_ply_are_preserved_but_rejected() {
    for relative in [
        "args.txt",
        "images/args.txt",
        "unrelated.ply",
        "sparse/init.ply",
    ] {
        let fixture = Fixture::new();
        let path = fixture.dataset().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"unmanaged").unwrap();
        assert!(fixture.command(0).is_err(), "accepted {relative}");
        assert_eq!(std::fs::read(&path).unwrap(), b"unmanaged");
    }
}

#[test]
fn warm_start_requires_capability_complete_init_and_a_sufficient_budget() {
    let mut fixture = Fixture::new();
    let path = fixture.dataset().join("init.ply");
    let one = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
    ));
    std::fs::write(&path, one).unwrap();
    assert!(fixture.command(0).is_err());
    assert!(fixture.command(100).is_err());
    fixture.enable_resume();
    let command = fixture.command(100).unwrap();
    assert_eq!(argument(&command, "--start-iter"), "100");
    let two = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/gaussian/minimal-sh0-ascii-two.ply"
    ));
    std::fs::write(&path, two).unwrap();
    fixture.profile.effective_training.max_splats = Some(1);
    assert_eq!(fixture.command(100).unwrap_err().code, "E-1402");
    assert_eq!(std::fs::read(&path).unwrap(), two);
    std::fs::write(&path, b"ply\n").unwrap();
    assert_eq!(fixture.command(100).unwrap_err().code, "E-4006");
}

#[test]
fn config_rejects_relative_mac_paths_nonzero_lod_and_unapplied_legacy_budgets() {
    let fixture = Fixture::new();
    let mut effective: EffectiveTraining = fixture.profile.effective_training.clone();
    let output = fixture.directory.path().join("checkpoints");
    assert!(fixture
        .config
        .to_cli_args_for_profile(
            BrushCliProfile::Metorigin1,
            &effective,
            Path::new("relative"),
            &output,
            0
        )
        .is_err());
    effective.lod_levels = Some(1);
    assert!(fixture
        .config
        .to_cli_args_for_profile(
            BrushCliProfile::Metorigin1,
            &effective,
            &fixture.dataset(),
            &output,
            0
        )
        .is_err());
    assert!(fixture
        .config
        .to_cli_args_for_profile(
            BrushCliProfile::Legacy03,
            &effective,
            &fixture.dataset(),
            &output,
            0
        )
        .is_err());
    assert!(fixture.command(300).is_err());
}

#[test]
fn mac_live_requires_matching_protocol_feature_and_verified_profile() {
    let mut fixture = Fixture::new();
    fixture.profile.live_protocol = LiveProtocol::PlyRequestAckV1;
    assert!(
        fixture.command(0).is_err(),
        "unknown profile support must not enable live"
    );
    fixture.profile.brush.live_preview = CapabilityStatus::Supported;
    assert!(
        fixture.command(0).is_err(),
        "disabled engine capability must not enable live"
    );
    fixture.runtime.capabilities.live_protocol = LiveProtocol::PlyRequestAckV1;
    assert!(
        fixture.command(0).is_err(),
        "feature list must also confirm live"
    );
    fixture
        .runtime
        .capabilities
        .supported_features
        .push("live_preview".into());
    assert_eq!(
        fixture.command(0).unwrap().program,
        fixture.adapter.brush_path()
    );
    fixture.profile.live_protocol = LiveProtocol::Disabled;
    assert!(
        fixture.command(0).is_ok(),
        "capable engines may run without live enabled"
    );
}

#[test]
fn windows1_command_binds_the_exact_probe_backend_device_and_main_cli() {
    let mut fixture = Fixture::new();
    fixture.profile = ExecutionProfile::from_json(include_bytes!(
        "../../../../schemas/examples/execution-profile/windows1-dx12.valid.json"
    ))
    .unwrap();
    fixture.runtime.capabilities.target = "x86_64-pc-windows-msvc".into();
    fixture.runtime.capabilities.identity.engine_version = "1.0.0+metorigin-windows.1".into();
    fixture.runtime.capabilities.identity.build_id = "metorigin-windows.1".into();
    fixture
        .runtime
        .capabilities
        .supported_features
        .push("backend_device_selection".into());
    fixture
        .runtime
        .capabilities
        .supported_features
        .push("live_preview".into());
    fixture.runtime.capabilities.live_protocol = LiveProtocol::PlyRequestAckV1;
    fixture.runtime.probe.identity = fixture.runtime.capabilities.identity.clone();
    fixture.runtime.probe.backend = Some(splat_domain::runtime::BrushBackend::Dx12);
    fixture.runtime.probe.device_type = Some("DiscreteGpu".into());
    fixture.runtime.probe.device_id = Some("dx12:000010de:00001234:46697874757265".into());
    fixture.profile.brush.probe_result = fixture.runtime.probe.training_probe();
    fixture.profile.engines.brush.binary_sha256 = fixture.runtime.binary_sha256.clone();
    fixture.adapter.brush_version = "brush-cli 1.0.0+metorigin-windows.1".into();
    let command = fixture.command(0).unwrap();
    assert_eq!(argument(&command, "--graphics-backend"), "dx12");
    assert_eq!(
        argument(&command, "--graphics-device"),
        "dx12:000010de:00001234:46697874757265"
    );
    assert!(command.args.iter().any(|arg| arg == "--total-train-iters"));
    assert!(!command.args.iter().any(|arg| arg == "--total-steps"));
    assert_eq!(command.program, fixture.adapter.brush_path());
    fixture.runtime.capabilities.target = "aarch64-apple-darwin".into();
    assert!(fixture.command(0).is_err());
}
