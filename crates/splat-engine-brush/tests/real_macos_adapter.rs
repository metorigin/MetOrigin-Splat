//! Opt-in contract check against the pinned macOS fork, independent of SfM.
//! The source dataset must come from the licensed fixture's CPU reconstruction.
#![cfg(target_os = "macos")]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use splat_domain::runtime::{CapabilityStatus, ResumeMode, RuntimePlatform};
use splat_domain::ExecutionProfile;
use splat_engine_brush::{
    probe_training_runtime, BrushAdapter, CheckpointScanner, ExportManager,
    ProfiledTrainingRequest, TrainingConfig, TrainingRuntimeEvidence,
};
use splat_process::ProcessRunner;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires METORIGIN_MACOS_BRUSH, METORIGIN_MACOS_DATASET, and fresh METORIGIN_MACOS_ADAPTER_OUTPUT"]
async fn real_macos_adapter_trains_in_unicode_paths() {
    let binary = required_path("METORIGIN_MACOS_BRUSH");
    let source = required_path("METORIGIN_MACOS_DATASET");
    let output = required_path("METORIGIN_MACOS_ADAPTER_OUTPUT");
    assert!(
        !output.exists(),
        "Use a fresh output directory; evidence is never overwritten"
    );
    std::fs::create_dir_all(&output).unwrap();
    let dataset = output.join("训练数据 中文 空格");
    let checkpoints = output.join("检查点 中文 空格");
    let source_before = inventory(&source);
    copy_directory(&source, &dataset);
    std::fs::create_dir(&checkpoints).unwrap();
    let runtime = probe_training_runtime(
        RuntimePlatform::Macos,
        &binary,
        &output.join("probe"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let TrainingRuntimeEvidence::Metal(runtime) = runtime else {
        panic!("Expected Metal compute evidence")
    };
    assert!(runtime.capabilities.supports("loader_thread_limit"));
    assert!(runtime.capabilities.supports("atomic_checkpoint"));
    // This fixture supplies structural placeholders for unrelated engines, which
    // are not invoked or claimed as validated by this Brush-only contract test.
    let mut profile = ExecutionProfile::from_json(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../schemas/examples/execution-profile/macos.valid.json"
    )))
    .unwrap();
    profile.engines.brush.version = runtime.capabilities.identity.engine_version.clone();
    profile.engines.brush.binary_sha256 = runtime.binary_sha256.clone();
    profile.engines.brush.source_commit = Some(runtime.capabilities.identity.source_commit.clone());
    profile.brush.probe_result = runtime.probe.training_probe();
    profile.brush.ply_warm_start = CapabilityStatus::Supported;
    profile.resume_mode = ResumeMode::PlyWarmStartOptimizerReset;
    let adapter = BrushAdapter::from_path(binary).unwrap();
    let config = TrainingConfig::from_builtin("fast").unwrap();
    let log = output.join("training.log");
    let command = adapter
        .build_train_command_for_profile(ProfiledTrainingRequest {
            config: &config,
            profile: &profile,
            verified_runtime: Some(&runtime),
            dataset_path: &dataset,
            checkpoint_path: &checkpoints,
            start_iteration: 0,
            log_path: &log,
        })
        .unwrap()
        .with_env("RUST_LOG", "info")
        .with_cwd(&output)
        .with_timeout(Duration::from_secs(300));
    let command_evidence = serde_json::json!({
        "program_sha256": runtime.binary_sha256,
        "args":command.args.iter().map(|v| v.to_string_lossy()).collect::<Vec<_>>(),
        "env":command.env.iter().map(|(k,v)| (k.to_string_lossy().into_owned(),v.to_string_lossy().into_owned())).collect::<std::collections::BTreeMap<_,_>>()
    });
    std::fs::write(
        output.join("command.json"),
        serde_json::to_vec_pretty(&command_evidence).unwrap(),
    )
    .unwrap();
    let process = ProcessRunner::new()
        .run_to_completion(command, CancellationToken::new(), None)
        .await
        .unwrap();
    assert!(process.is_success(), "Brush failed: {process:?}");
    let checkpoint = CheckpointScanner::find_latest(&checkpoints)
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.iteration, 300);
    let metadata = ExportManager::inspect_ply(&checkpoint.path).unwrap();
    assert_eq!(metadata.sh_degree, 0);
    assert!(metadata.vertex_count > 0);
    assert!(metadata.vertex_count <= u64::from(profile.effective_training.max_splats.unwrap()));
    let log_text = std::fs::read_to_string(&log).unwrap();
    assert!(
        log_text.contains("backend: Metal"),
        "actual training backend must be logged"
    );
    assert!(
        log_text.contains("Dataset loader actor threads: 4"),
        "explicit loader cap must be applied"
    );
    assert_eq!(
        source_before,
        inventory(&source),
        "source dataset was mutated"
    );
    assert_eq!(
        adapter.binary_sha256().unwrap(),
        runtime.binary_sha256,
        "engine drifted"
    );
    assert!(!std::fs::read_dir(&checkpoints).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".tmp")));
    let evidence = serde_json::json!({
        "schema_version":1, "scope":"Rust Brush adapter / splat-process only; unrelated engine identities in the schema fixture are unexecuted placeholders",
        "fixture":"James & Robson volcanic bomb, CC0, figshare DOI 10.6084/m9.figshare.9120020.v1, fixed IMG_1928..IMG_1967",
        "binary_sha256":runtime.binary_sha256, "capabilities":runtime.capabilities, "compute_probe":runtime.probe,
        "effective_training":profile.effective_training, "process":process,
        "checkpoint":{"filename":checkpoint.path.file_name().unwrap().to_string_lossy(), "sha256":file_hash(&checkpoint.path), "gaussians":metadata.vertex_count, "sh_degree":metadata.sh_degree},
        "source_dataset_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&source_before).unwrap()))
    });
    std::fs::write(
        output.join("evidence.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
}

fn required_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("Set {name}")));
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}

fn copy_directory(source: &Path, destination: &Path) {
    std::fs::create_dir(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        assert!(!entry.file_type().unwrap().is_symlink());
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_directory(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn inventory(root: &Path) -> Vec<(String, String)> {
    fn walk(root: &Path, dir: &Path, result: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            assert!(!entry.file_type().unwrap().is_symlink());
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), result);
            } else {
                result.push((
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    file_hash(&entry.path()),
                ));
            }
        }
    }
    let mut result = Vec::new();
    walk(root, root, &mut result);
    result.sort();
    result
}

fn file_hash(path: &Path) -> String {
    let mut file = std::fs::File::open(path).unwrap();
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    format!("{:x}", digest.finalize())
}
