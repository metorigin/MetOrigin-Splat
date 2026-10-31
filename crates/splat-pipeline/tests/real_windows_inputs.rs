//! Controlled derivatives exercise production input stages and paired Windows
//! engines. Synthetic camera identities are not physical calibration evidence.
#![cfg(all(target_os = "windows", target_arch = "x86_64"))]

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use splat_domain::project::{ImageFolderSource, ProjectSource, VideoSource};
use splat_domain::runtime::RuntimePlatform;
use splat_domain::EnginePaths;
use splat_engine_brush::{probe_training_runtime, ExportManager, TrainingRuntimeEvidence};
use splat_engine_colmap::{read_colmap_result, validate_model_image_dimensions};
use splat_pipeline::image_input::read_image_manifest;
use splat_pipeline::runtime::{
    freeze_windows_execution_profile, WindowsProfileRequest, WindowsTrainingPolicy,
};
use splat_pipeline::{
    FrameExtractionStage, MediaValidationStage, PipelineConfig, PipelineOrchestrator,
};
use splat_project::ProjectManager;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires fresh project root and controlled-inputs-v1 generated from fixed James40"]
async fn windows_controlled_image_preparation_and_rejections() {
    let fixtures = required("METORIGIN_TEST_DERIVED_ROOT");
    let root = required("METORIGIN_TEST_PROJECT_ROOT");
    let before = inventory(&fixtures);
    let mut results = Vec::new();
    for (name, count, expected_error) in [
        ("positive-mixed", 40, None),
        ("orientation-eight", 8, None),
        ("low-texture", 24, None),
        ("low-overlap", 24, None),
        ("corrupt-only", 0, Some("E-1102")),
        ("corrupt-plus-two", 0, Some("E-1103")),
        ("empty", 0, Some("E-1102")),
        ("unsupported-only", 0, Some("E-1102")),
    ] {
        let project = create_project(&root, name, &fixtures.join(name), false);
        let mut pipeline =
            PipelineOrchestrator::new_with_config(project.clone(), PipelineConfig::default());
        pipeline.register_stage(Box::new(MediaValidationStage::new()));
        pipeline.register_stage(Box::new(FrameExtractionStage::new("fast")));
        let result = pipeline
            .start_with_lock("controlled-input-preparation")
            .await;
        if let Some(code) = expected_error {
            let error = result.unwrap_err();
            assert_eq!(error.code, code, "{name}: {error}");
            assert!(!project.join("frames/frames.json").exists());
            assert!(!project.join("frames.preparing").exists());
            results.push(
                serde_json::json!({"case":name,"expected_error":code,"actual_error":error.code,
                "project":project,"message":error.user_message}),
            );
        } else {
            result.unwrap();
            let manifest = read_image_manifest(&project.join("frames/frames.json"))
                .unwrap()
                .unwrap();
            assert_eq!(manifest.frames.len(), count);
            if name == "positive-mixed" {
                assert_eq!(manifest.camera_groups.len(), 4);
                assert!(manifest
                    .camera_groups
                    .iter()
                    .all(|group| group.image_count == 10));
                assert!(manifest
                    .frame_sources
                    .iter()
                    .any(|item| item.camera.focal_length_mm == Some(50.0)));
                assert!(manifest
                    .frame_sources
                    .iter()
                    .any(|item| item.camera.focal_length_35mm == Some(80)));
            }
            results.push(serde_json::json!({"case":name,"frames":count,"camera_groups":manifest.camera_groups,"project":project}));
        }
    }
    assert_eq!(inventory(&fixtures), before);
    std::fs::write(root.join("input-preparation-evidence.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version":1,"status":"production_preparation_passed","source_hashes_unchanged":true,
        "scope":"MediaValidationStage and FrameExtractionStage only; no SfM or Brush execution", "results":results
    })).unwrap()).unwrap();
}

#[tokio::test]
#[ignore = "requires controlled mixed40 fixture, paired native engines and a fresh project root"]
async fn windows_mixed_exif_full_pipeline() {
    full_pipeline("positive-mixed", false, None).await;
}

#[tokio::test]
#[ignore = "requires controlled display90 captured-video derivative, paired engines and a fresh root"]
async fn windows_rotated_captured_video_full_pipeline() {
    full_pipeline("rotated-video", true, None).await;
}

#[tokio::test]
#[ignore = "requires controlled low-texture fixture and paired native engines"]
async fn windows_low_texture_rejected_before_training() {
    full_pipeline("low-texture", false, Some("E-3010")).await;
}

#[tokio::test]
#[ignore = "requires controlled disjoint-view fixture and paired native engines"]
async fn windows_low_overlap_rejected_before_training() {
    full_pipeline("low-overlap", false, Some("E-3020")).await;
}

async fn full_pipeline(name: &str, video: bool, expected_error: Option<&str>) {
    let fixtures = required("METORIGIN_TEST_DERIVED_ROOT");
    let root = required("METORIGIN_TEST_PROJECT_ROOT");
    let source = fixtures.join(name);
    let before = inventory(&source);
    if video {
        let receipt: serde_json::Value = serde_json::from_slice(
            &std::fs::read(fixtures.join("rotated-video-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            receipt["original_sha256"],
            "3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854"
        );
        assert_eq!(
            receipt["derived_sha256"].as_str(),
            before.get("tum-desk-display90.mp4").map(String::as_str)
        );
    } else if name == "positive-mixed" {
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixtures.join("fixture-manifest.json")).unwrap())
                .unwrap();
        let expected = receipt["images"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["path"].as_str().unwrap().to_string(),
                    item["sha256"].as_str().unwrap().to_string(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(before, expected);
    }
    let project = create_project(&root, name, &source, video);
    let paths = EnginePaths {
        ffmpeg: Some(required("METORIGIN_TEST_FFMPEG")),
        ffprobe: Some(required("METORIGIN_TEST_FFPROBE")),
        colmap: Some(required("METORIGIN_TEST_COLMAP")),
        brush: Some(required("METORIGIN_TEST_BRUSH")),
    };
    let evidence = probe_training_runtime(
        RuntimePlatform::Windows,
        paths.brush.as_deref().unwrap(),
        &project.join("logs/preflight"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let TrainingRuntimeEvidence::WindowsWgpu(brush) = evidence else {
        panic!("Windows compute required");
    };
    let profile = freeze_windows_execution_profile(
        WindowsProfileRequest {
            os_version: std::env::var("METORIGIN_TEST_OS_VERSION")
                .expect("Set measured Windows version"),
            physical_memory_bytes: std::env::var("METORIGIN_TEST_SYSTEM_MEMORY_BYTES")
                .unwrap()
                .parse()
                .unwrap(),
            available_threads: std::thread::available_parallelism().unwrap().get() as u32,
            available_adapter_budget_bytes: None,
            policy: WindowsTrainingPolicy::candidate(),
            preset: "fast".into(),
            requested_resolution: 960,
            engine_paths: paths.clone(),
            engine_pack_id: None,
        },
        &brush,
    )
    .await
    .unwrap();
    let pipeline = PipelineOrchestrator::new_default_with_config(
        project.clone(),
        PipelineConfig {
            preset: "fast".into(),
            engine_paths: paths,
            execution_profile: Some(Arc::new(profile.clone())),
        },
    );
    let started = std::time::Instant::now();
    let result = pipeline
        .start_with_lock("windows-derived-input-full-pipeline")
        .await;
    let payload = if let Some(code) = expected_error {
        let error = result.unwrap_err();
        assert_eq!(error.code, code, "{name}: {error}");
        assert!(!project.join("output/scene.ply").exists());
        assert!(!project.join("training/result.json").exists());
        serde_json::json!({"status":"expected_rejection_passed","error":error.code,"message":error.user_message})
    } else {
        result.unwrap();
        let reconstruction = read_colmap_result(&project.join("colmap/result.json")).unwrap();
        if video {
            assert!((100..=120).contains(&reconstruction.total_images));
            assert!(reconstruction.registered_images * 100 >= reconstruction.total_images * 80);
            let frames: serde_json::Value =
                serde_json::from_slice(&std::fs::read(project.join("frames/frames.json")).unwrap())
                    .unwrap();
            assert_eq!(frames["source_metadata"]["rotation"], 90);
            assert_eq!(
                frames["extraction_plan"]["rotation_correction"],
                "transpose=cclock"
            );
            assert!(frames["frames"]
                .as_array()
                .unwrap()
                .iter()
                .all(|frame| frame["width"] == 480 && frame["height"] == 640));
        } else {
            assert!(reconstruction.registered_images >= 36);
            assert!(reconstruction.point_count >= 1000);
            assert!(reconstruction
                .mean_track_length
                .is_some_and(|value| value >= 2.5));
            assert!(reconstruction
                .mean_reprojection_error
                .is_some_and(|value| value > 0.0 && value <= 3.0));
            let manifest = read_image_manifest(&project.join("frames/frames.json"))
                .unwrap()
                .unwrap();
            assert_eq!(manifest.camera_groups.len(), 4);
        }
        assert_eq!(
            validate_model_image_dimensions(
                &project.join("training/dataset/sparse/0"),
                &project.join("training/dataset/images")
            )
            .unwrap(),
            reconstruction.registered_images
        );
        let scene = project.join("output/scene.ply");
        let model = ExportManager::inspect_ply(&scene).unwrap();
        assert!(model.vertex_count > 0 && model.vertex_count <= 300_000);
        assert_eq!(model.sh_degree, 0);
        let training: splat_pipeline::BrushTrainingResult =
            serde_json::from_slice(&std::fs::read(project.join("training/result.json")).unwrap())
                .unwrap();
        assert_eq!(training.total_iterations, 3000);
        serde_json::json!({"status":"derived_input_full_pipeline_passed","registered_images":reconstruction.registered_images,
            "total_images":reconstruction.total_images,"sparse_points":reconstruction.point_count,
            "mean_track_length":reconstruction.mean_track_length,"mean_reprojection_error":reconstruction.mean_reprojection_error,
            "gaussians":model.vertex_count,"sh_degree":model.sh_degree,"scene_sha256":sha256(&scene)})
    };
    assert_eq!(inventory(&source), before);
    for (relative, hash) in &before {
        assert_eq!(&sha256(&project.join("source").join(relative)), hash);
    }
    assert!(matches!(
        splat_pipeline::ProjectLock::check(&project),
        splat_pipeline::LockStatus::Unlocked
    ));
    std::fs::write(project.join("runtime/derived-input-evidence.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version":1,"case":name,"result":payload,"profile":profile,"source_hashes_unchanged":true,
        "test_harness_overrides":{"preset":"fast","iterations":3000,"sh_degree":0,"resolution":960,
            "scope":"Explicit controlled input acceptance parameters; not production preset quality acceptance"},
        "elapsed_seconds":started.elapsed().as_secs_f64(),"native_ui_verified":false
    })).unwrap()).unwrap();
}

fn create_project(root: &Path, name: &str, source: &Path, video: bool) -> PathBuf {
    let manager = ProjectManager::new(root.to_path_buf());
    let (mut project, path) = manager
        .create_project(&format!("Windows 输入 中文 {name}"))
        .unwrap();
    let files = inventory(source);
    for relative in files.keys() {
        let target = path.join("source").join(relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(source.join(relative), target).unwrap();
    }
    project.source = Some(if video {
        ProjectSource::Video(VideoSource {
            filename: "tum-desk-display90.mp4".into(),
            copied_to_project: true,
        })
    } else {
        ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: name.into(),
            image_count: files.len(),
            copied_to_project: true,
        })
    });
    project.settings.preset = "fast".into();
    project.settings.max_frames = if video { 120 } else { 40 };
    project.settings.max_long_edge = 960;
    project.settings.colmap_max_long_edge = 960;
    project.settings.frame_fps = Some(5.0);
    manager.save_project(&project, &path).unwrap();
    path
}

fn inventory(root: &Path) -> BTreeMap<String, String> {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            (
                entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                sha256(entry.path()),
            )
        })
        .collect()
}

fn sha256(path: &Path) -> String {
    let mut file = std::fs::File::open(path).unwrap();
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    format!("{:x}", digest.finalize())
}

fn required(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("Set {name}")));
    assert!(path.is_absolute() && path.exists());
    path
}
