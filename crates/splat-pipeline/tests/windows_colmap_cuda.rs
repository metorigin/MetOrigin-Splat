//! Real Windows CUDA gate. Inputs must be the immutable public James40 fixture.
//! Run with METORIGIN_TEST_COLMAP, METORIGIN_TEST_JAMES_IMAGES and a fresh
//! METORIGIN_TEST_COLMAP_OUTPUT, then `cargo test -p splat-pipeline --test
//! windows_colmap_cuda -- --ignored --nocapture`.
#![cfg(windows)]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use splat_domain::runtime::{ColmapBackend, ExecutionProfile, RuntimePlatform};
use splat_engine_colmap::{
    inspect_database, inspect_match_graph, CameraModel, ColmapAdapter, ColmapExecutionSettings,
    FeatureExtractionOptions, MapperKind, MatchingStrategy,
};
use splat_process::{background_command, probe_output_sync, CommandSpec, ProcessRunner};
use tokio_util::sync::CancellationToken;

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")))
}

fn sha256(path: &Path) -> String {
    let mut hash = Sha256::new();
    let mut input = std::fs::File::open(path).unwrap();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = input.read(&mut buffer).unwrap();
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    format!("{:x}", hash.finalize())
}

fn verify_inputs(images: &Path, fixture: &Value) {
    for item in fixture["images"].as_array().unwrap() {
        let path = images.join(item["path"].as_str().unwrap());
        assert_eq!(sha256(&path), item["sha256"].as_str().unwrap());
    }
}

async fn execute(output: &Path, name: &str, spec: CommandSpec, evidence: &mut Value) -> String {
    let spec = spec.with_timeout(Duration::from_secs(60 * 30));
    let arguments = spec
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let captured = ProcessRunner::new()
        .run_to_completion_capture(spec, CancellationToken::new(), 16 * 1024 * 1024)
        .await;
    if let Err(error) = &captured {
        evidence["status"] = json!("failed");
        evidence["stages"][name] = json!({"argv": arguments, "error": error.to_string()});
        std::fs::write(
            output.join("evidence.json"),
            serde_json::to_vec_pretty(evidence).unwrap(),
        )
        .unwrap();
    }
    let captured = captured.unwrap();
    evidence["stages"][name] = json!({"argv": arguments, "process": captured.process});
    if !captured.process.is_success() {
        evidence["status"] = json!("failed");
    }
    std::fs::write(
        output.join("evidence.json"),
        serde_json::to_vec_pretty(evidence).unwrap(),
    )
    .unwrap();
    assert!(
        captured.process.is_success(),
        "{name} failed; inspect the retained stage log"
    );
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&captured.stdout),
        String::from_utf8_lossy(&captured.stderr)
    )
}

#[tokio::test]
#[ignore = "requires native Windows, pinned COLMAP 4.1 CUDA and public James40 inputs"]
async fn windows_cuda_reconstructs_fixed_photos_and_prepares_brush_dataset() {
    let executable = required_path("METORIGIN_TEST_COLMAP");
    let images = required_path("METORIGIN_TEST_JAMES_IMAGES");
    let output = required_path("METORIGIN_TEST_COLMAP_OUTPUT");
    assert!(!output.exists(), "never overwrite an earlier experiment");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packaging/macos-arm64/fixtures/james-sample-40.json"
    ))
    .unwrap();
    verify_inputs(&images, &fixture);
    let mut baseline = ExecutionProfile::from_json(include_bytes!(
        "../../../schemas/examples/execution-profile/macos.valid.json"
    ))
    .unwrap()
    .colmap;
    baseline.feature_backend = ColmapBackend::Cuda;
    baseline.matching_backend = ColmapBackend::Cuda;
    // The official 4.1 CUDA archive has CUDA SIFT, but its Ceres build has no
    // CUDA/cuDSS support. Freeze GP to CPU instead of accepting silent fallback.
    baseline.global_positioning_backend = ColmapBackend::Cpu;
    let settings =
        ColmapExecutionSettings::new(RuntimePlatform::Windows, baseline.clone(), 4).unwrap();
    let adapter = ColmapAdapter::from_path_with_settings(executable.clone(), settings).unwrap();
    assert_eq!(adapter.version(), "4.1.0");
    // This is environment observation, separate from the kernel/data assertions.
    let gpu = probe_output_sync(background_command("nvidia-smi").args([
        "--query-gpu=index,name,uuid,driver_version,memory.total",
        "--format=csv,noheader,nounits",
    ]))
    .unwrap();
    assert!(gpu.status.success());
    std::fs::create_dir_all(output.join("logs")).unwrap();
    std::fs::create_dir_all(output.join("sparse")).unwrap();
    let database = output.join("database.db");
    let mut evidence = json!({
        "schema_version": 1,
        "status": "running",
        "fixture_id": fixture["id"],
        "fixture_manifest_sha256": sha256(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packaging/macos-arm64/fixtures/james-sample-40.json")),
        "engine_version": adapter.version(),
        "binary_sha256": sha256(&executable),
        "gpu_observation": String::from_utf8_lossy(&gpu.stdout),
        "host_os": std::env::consts::OS,
        "host_architecture": std::env::consts::ARCH,
        "colmap": baseline,
        "threads": 4,
        "stages": {}
    });
    execute(
        &output,
        "database",
        adapter
            .database_creator()
            .build_command(&database, &output.join("logs/database.log")),
        &mut evidence,
    )
    .await;
    let mut feature = adapter.build_feature_command(
        &database,
        &images,
        &FeatureExtractionOptions {
            single_camera: true,
            camera_model: CameraModel::SimpleRadial,
            ..FeatureExtractionOptions::default()
        },
        &output.join("logs/features.log"),
    );
    feature
        .args
        .extend(["--FeatureExtraction.max_image_size".into(), "1600".into()]);
    let feature_log = execute(&output, "features", feature, &mut evidence).await;
    // A successful CUDA initialization alone does not prove kernel execution:
    // require all fixture images and nonzero extracted feature payloads too.
    let features = inspect_database(&database).unwrap();
    assert_eq!(features.images, 40);
    assert!(features.keypoints > 1000);
    assert!(feature_log.contains("CUDA") || feature_log.contains("GPU"));
    let matching = execute(
        &output,
        "matching",
        adapter.build_matching_command(
            &database,
            &MatchingStrategy::Exhaustive,
            &output.join("logs/matching.log"),
        ),
        &mut evidence,
    )
    .await;
    let graph = inspect_match_graph(&database).unwrap();
    assert!(graph.verified_edges > 0);
    assert_eq!(graph.largest_component_images, 40);
    assert!(matching.contains("CUDA") || matching.contains("GPU"));
    let mapping = execute(
        &output,
        "mapping",
        adapter.build_mapping_command_with_kind(
            MapperKind::Global,
            &database,
            &images,
            &output.join("sparse"),
            &output.join("logs/mapping.log"),
        ),
        &mut evidence,
    )
    .await;
    assert!(
        !mapping.contains("Falling back"),
        "unexpected backend fallback"
    );
    let reconstruction = adapter
        .mapper()
        .analyze_result(&output.join("sparse"), 40)
        .unwrap();
    assert_eq!(reconstruction.registered_images, 40);
    assert!(reconstruction.point_count >= 10_000);
    assert!(reconstruction
        .mean_reprojection_error
        .is_some_and(|error| error < 1.0));
    execute(
        &output,
        "undistortion",
        adapter.build_image_undistorter_command(
            &images,
            &output.join("sparse/0"),
            &output.join("dataset"),
            960,
            &output.join("logs/undistortion.log"),
        ),
        &mut evidence,
    )
    .await;
    verify_inputs(&images, &fixture);
    evidence["source_hashes_unchanged"] = json!(true);
    evidence["reconstruction"] = serde_json::to_value(reconstruction).unwrap();
    evidence["match_graph"] = serde_json::to_value(graph).unwrap();
    evidence["status"] = json!("passed");
    std::fs::write(
        output.join("evidence.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
}
