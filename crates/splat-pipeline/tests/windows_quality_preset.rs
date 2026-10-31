//! Opt-in full requested quality acceptance, separate from bounded smoke runs.
//! Uses a fresh target workspace and the fixed public TUM desk AVI. No UI,
//! cancellation, restore, or user project is involved.
#![cfg(all(target_os = "windows", target_arch = "x86_64"))]

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use splat_domain::project::{ProjectSource, VideoSource};
use splat_domain::runtime::{BrushBackend, RuntimePlatform};
use splat_domain::{EnginePaths, StageStatus};
use splat_engine_brush::{
    probe_training_runtime, CheckpointScanner, ExportManager, TrainingRuntimeEvidence,
};
use splat_engine_colmap::{read_colmap_result, validate_model_image_dimensions};
use splat_pipeline::runtime::{
    freeze_windows_execution_profile, WindowsProfileRequest, WindowsTrainingPolicy,
};
use splat_pipeline::{BrushTrainingResult, PipelineConfig, PipelineOrchestrator};
use splat_project::ProjectManager;
use tokio_util::sync::CancellationToken;

const TUM_SHA256: &str = "3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854";

#[tokio::test]
#[ignore = "requires fixed TUM AVI, paired native engines, absent GPU overrides and a fresh METORIGIN_TEST_QUALITY_PROJECT_ROOT under target; runs all30000 quality steps"]
async fn windows_requested_quality_full_pipeline_without_overrides() {
    assert!(std::env::var_os("METORIGIN_BRUSH_BACKEND").is_none());
    assert!(std::env::var_os("METORIGIN_BRUSH_DEVICE_ID").is_none());
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let selected = required("METORIGIN_TEST_QUALITY_PROJECT_ROOT");
    let selected = if selected.is_absolute() {
        selected
    } else {
        repository.join(selected)
    };
    let root = selected
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
        .join(selected.file_name().unwrap());
    assert!(root.starts_with(repository.join("target").canonicalize().unwrap()));
    assert!(
        !root.exists(),
        "quality acceptance must never reuse or overwrite a workspace"
    );
    std::fs::create_dir(&root).unwrap();
    let receipt = root.join("quality-acceptance-evidence.json");
    let video = required("METORIGIN_TEST_VIDEO").canonicalize().unwrap();
    assert_eq!(sha256(&video), TUM_SHA256);
    let paths = EnginePaths {
        ffmpeg: Some(required("METORIGIN_TEST_FFMPEG").canonicalize().unwrap()),
        ffprobe: Some(required("METORIGIN_TEST_FFPROBE").canonicalize().unwrap()),
        colmap: Some(required("METORIGIN_TEST_COLMAP").canonicalize().unwrap()),
        brush: Some(required("METORIGIN_TEST_BRUSH").canonicalize().unwrap()),
    };
    let engines_before = engine_hashes(&paths);
    let sources_before = source_hashes(&repository);
    let manager = ProjectManager::new(root.clone());
    let (mut project, project_dir) = manager
        .create_project("Windows 完整质量预设 中文 空格")
        .unwrap();
    let filename = video.file_name().unwrap();
    let copied_video = project_dir.join("source").join(filename);
    std::fs::copy(&video, &copied_video).unwrap();
    project.source = Some(ProjectSource::Video(VideoSource {
        filename: filename.to_string_lossy().into_owned(),
        copied_to_project: true,
    }));
    // Match ordinary quality project creation. No smoke resolution/frame/step
    // override, and no subsequent mutation of the frozen effective settings.
    project.settings.preset = "quality".into();
    project.settings.max_frames = 1200;
    project.settings.max_long_edge = 2560;
    project.settings.colmap_max_long_edge = 4096;
    project.settings.frame_fps = None;
    manager.save_project(&project, &project_dir).unwrap();
    let started = std::time::Instant::now();
    let mut evidence = json!({
        "schema_version":1,"status":"running","project":project_dir,
        "scope":"Full requested quality production pipeline; fixed640x480 TUM input; no UI, cancellation, restore or user project",
        "test_harness_quality_overrides":false,"backend_environment_present":false,"device_environment_present":false,
        "source_video":video,"source_video_sha256_before":TUM_SHA256,
        "engine_paths":paths,"engine_hashes_before":engines_before,"source_hashes_before":sources_before,
        "test_binary_sha256":sha256(&std::env::current_exe().unwrap()),
        "requested":{"preset":"quality","iterations":30000,"sh_degree":2,"resolution":2560}
    });
    write_evidence(&receipt, &evidence);
    let runtime = probe_training_runtime(
        RuntimePlatform::Windows,
        paths.brush.as_deref().unwrap(),
        &root.join("preflight-logs"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let TrainingRuntimeEvidence::WindowsWgpu(brush) = runtime else {
        panic!("Windows1 compute evidence required")
    };
    assert_eq!(brush.probe.backend, Some(BrushBackend::Dx12));
    evidence["probe"] = json!(brush.probe);
    let profile = freeze_windows_execution_profile(
        WindowsProfileRequest {
            os_version: windows_version(),
            physical_memory_bytes: std::env::var("METORIGIN_TEST_SYSTEM_MEMORY_BYTES")
                .unwrap()
                .parse()
                .unwrap(),
            available_threads: std::thread::available_parallelism().unwrap().get() as u32,
            available_adapter_budget_bytes: None,
            policy: WindowsTrainingPolicy::candidate(),
            preset: "quality".into(),
            requested_resolution: 2560,
            engine_paths: paths.clone(),
            engine_pack_id: None,
        },
        &brush,
    )
    .await
    .unwrap();
    assert_eq!(profile.effective_training.iterations, 30000);
    assert_eq!(profile.effective_training.sh_degree, 2);
    assert_eq!(profile.effective_training.resolution, Some(2560));
    assert_eq!(profile.memory.available_working_set_bytes, None);
    evidence["profile"] = json!(profile);
    write_evidence(&receipt, &evidence);
    let pipeline = PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        PipelineConfig {
            preset: "quality".into(),
            engine_paths: paths.clone(),
            execution_profile: Some(Arc::new(profile.clone())),
        },
    );
    let result = pipeline
        .start_with_lock("windows-full-quality-preset-acceptance")
        .await;
    evidence["engine_hashes_after"] = json!(engine_hashes(&paths));
    evidence["source_hashes_after"] = json!(source_hashes(&repository));
    evidence["source_video_sha256_after"] = json!(sha256(&video));
    evidence["copied_video_sha256_after"] = json!(sha256(&copied_video));
    evidence["elapsed_seconds"] = json!(started.elapsed().as_secs_f64());
    if let Err(error) = result {
        evidence["status"] = json!("pipeline_failed");
        evidence["error"] = json!(error);
        write_evidence(&receipt, &evidence);
        panic!(
            "full quality pipeline failed; preserved evidence: {}",
            receipt.display()
        );
    }
    evidence["pipeline_completed"] = json!(true);
    evidence["status"] = json!("validating_outputs");
    write_evidence(&receipt, &evidence);
    let state = pipeline.get_state().await;
    evidence["stages"] = json!(state.stages);
    write_evidence(&receipt, &evidence);
    assert_eq!(state.stages.len(), 12);
    assert!(state
        .stages
        .values()
        .all(|stage| stage.status == StageStatus::Completed));
    assert_eq!(
        splat_project::load_execution_profile(&project_dir).unwrap(),
        Some(profile)
    );
    let frames: Value = read_json(&project_dir.join("frames/frames.json"));
    assert_eq!(frames["source_metadata"]["width"], 640);
    assert_eq!(frames["source_metadata"]["height"], 480);
    assert!(frames["frames"]
        .as_array()
        .unwrap()
        .iter()
        .all(|frame| frame["width"] == 640 && frame["height"] == 480));
    let reconstruction = read_colmap_result(&project_dir.join("colmap/result.json")).unwrap();
    assert!(reconstruction.registered_images * 100 >= reconstruction.total_images * 80);
    let image_dir = project_dir.join("training/dataset/images");
    let dimensions: Vec<_> = std::fs::read_dir(&image_dir).unwrap().map(|entry| {
        let path = entry.unwrap().path();
        let (width,height) = image::image_dimensions(&path).unwrap();
        assert!(prepared_dimensions_fit_source((width,height), (640,480)),
            "undistortion may crop the image, but prepared quality data must have positive dimensions and must not upscale the source");
        json!({"file":path.file_name().unwrap().to_string_lossy(),"width":width,"height":height})
    }).collect();
    assert_eq!(dimensions.len(), reconstruction.registered_images);
    assert_eq!(
        validate_model_image_dimensions(&project_dir.join("training/dataset/sparse/0"), &image_dir)
            .unwrap(),
        dimensions.len()
    );
    let preparation: Value = read_json(&project_dir.join("training/config/config.json"));
    assert_eq!(preparation["dataset"]["max_long_edge"], 2560);
    let training: BrushTrainingResult = read_json(&project_dir.join("training/result.json"));
    assert_eq!(training.preset, "quality");
    assert_eq!(training.total_iterations, 30000);
    assert_eq!(training.sh_degree, Some(2));
    assert_eq!(training.resolution, Some(2560));
    assert_eq!(training.resumed_from_iteration, 0);
    assert!(!training.optimizer_state_restored);
    let checkpoint = project_dir.join("training/checkpoints/checkpoint_30000.ply");
    let model = ExportManager::inspect_ply(&checkpoint).unwrap();
    assert!(model.vertex_count > 0 && model.vertex_count <= 300000);
    assert_eq!(model.sh_degree, 2);
    let scene = project_dir.join("output/scene.ply");
    assert_eq!(ExportManager::inspect_ply(&scene).unwrap(), model);
    assert_eq!(sha256(&scene), sha256(&checkpoint));
    let manifest: Value = read_json(&project_dir.join("training/training-fingerprint.json"));
    assert_eq!(manifest["completed"]["iterations"], 30000);
    assert_eq!(manifest["completed"]["checkpoint"], "checkpoint_30000.ply");
    assert_eq!(
        manifest["completed"]["checkpoint_sha256"],
        sha256(&checkpoint)
    );
    assert_eq!(
        manifest["completed"]["result_sha256"],
        sha256(&project_dir.join("training/result.json"))
    );
    let checkpoints = CheckpointScanner::scan(&project_dir.join("training/checkpoints")).unwrap();
    assert_eq!(checkpoints.last().unwrap().iteration, 30000);
    assert_eq!(engine_hashes(&paths), engines_before);
    assert_eq!(source_hashes(&repository), sources_before);
    assert_eq!(sha256(&video), TUM_SHA256);
    assert_eq!(sha256(&copied_video), TUM_SHA256);
    assert!(matches!(
        splat_pipeline::ProjectLock::check(&project_dir),
        splat_pipeline::LockStatus::Unlocked
    ));
    evidence["status"] = json!("full_requested_quality_pipeline_passed");
    evidence["training_result"] = json!(training);
    evidence["completion_manifest"] = manifest;
    evidence["registered_images"] = json!(reconstruction.registered_images);
    evidence["total_images"] = json!(reconstruction.total_images);
    evidence["prepared_image_dimensions"] = json!(dimensions);
    evidence["scene"] = json!({"sha256":sha256(&scene),"vertex_count":model.vertex_count,"sh_degree":model.sh_degree,"all_scalar_values_finite":true});
    evidence["checkpoints"] = json!(checkpoints);
    evidence["source_and_engine_hashes_unchanged"] = json!(true);
    write_evidence(&receipt, &evidence);
    println!("Full quality evidence: {}", receipt.display());
}

fn prepared_dimensions_fit_source(
    (width, height): (u32, u32),
    (source_width, source_height): (u32, u32),
) -> bool {
    width > 0 && height > 0 && width <= source_width && height <= source_height
}

fn required(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("Set {name}")))
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn write_evidence(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn sha256(path: &Path) -> String {
    let mut file = std::fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    format!("{:x}", hash.finalize())
}
fn engine_hashes(paths: &EnginePaths) -> BTreeMap<String, String> {
    [
        ("ffmpeg", &paths.ffmpeg),
        ("ffprobe", &paths.ffprobe),
        ("colmap", &paths.colmap),
        ("brush", &paths.brush),
    ]
    .into_iter()
    .map(|(name, path)| (name.to_string(), sha256(path.as_ref().unwrap())))
    .collect()
}
fn source_hashes(repository: &Path) -> BTreeMap<String, String> {
    [
        "Cargo.lock",
        "presets/quality.json",
        "crates/splat-pipeline/src/runtime.rs",
        "crates/splat-pipeline/src/stages/frame_extract.rs",
        "crates/splat-pipeline/src/stages/image_preprocessing.rs",
        "crates/splat-pipeline/src/stages/training_preparation.rs",
        "crates/splat-pipeline/src/stages/brush_training.rs",
        "crates/splat-engine-brush/src/config.rs",
        "crates/splat-engine-brush/src/adapter.rs",
        "crates/splat-engine-brush/src/runtime.rs",
        "crates/splat-pipeline/tests/windows_quality_preset.rs",
    ]
    .into_iter()
    .map(|path| (path.to_string(), sha256(&repository.join(path))))
    .collect()
}
fn windows_version() -> String {
    let output = splat_process::background_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Write([Environment]::OSVersion.Version.ToString())",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[cfg(test)]
mod prepared_dimensions_tests {
    use super::prepared_dimensions_fit_source;

    #[test]
    fn accepts_original_source_dimensions() {
        assert!(prepared_dimensions_fit_source((640, 480), (640, 480)));
    }

    #[test]
    fn accepts_normal_undistortion_crop() {
        assert!(prepared_dimensions_fit_source((622, 466), (640, 480)));
    }

    #[test]
    fn rejects_zero_dimensions_and_upscale() {
        for dimensions in [(0, 466), (622, 0), (0, 0), (641, 480), (640, 481)] {
            assert!(!prepared_dimensions_fit_source(dimensions, (640, 480)));
        }
    }
}
