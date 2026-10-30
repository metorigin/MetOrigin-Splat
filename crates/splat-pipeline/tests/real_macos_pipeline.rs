//! Opt-in application-core acceptance. These tests run all twelve production
//! stages and real engines; they do not establish native WebView or packaging acceptance.
#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use splat_domain::project::{ImageFolderSource, ProjectSource, VideoSource};
use splat_domain::runtime::RuntimePlatform;
use splat_domain::{EnginePaths, PipelineStageId, StageStatus};
use splat_engine_brush::{probe_training_runtime, ExportManager, TrainingRuntimeEvidence};
use splat_engine_colmap::{read_colmap_result, validate_model_image_dimensions};
use splat_pipeline::runtime::{freeze_macos_execution_profile, MacosProfileRequest};
use splat_pipeline::{PipelineConfig, PipelineOrchestrator};
use splat_project::ProjectManager;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires public James40 images, native pinned engines, Metal and a fresh test project root"]
async fn macos_real_photos_to_scene_ply() {
    run_pipeline(false).await;
}

#[tokio::test]
#[ignore = "requires James40-derived MPEG4 fixture, native pinned engines, Metal and a fresh test project root"]
async fn macos_real_video_to_scene_ply() {
    run_pipeline(true).await;
}

async fn run_pipeline(video: bool) {
    let root = required_path("METORIGIN_TEST_PROJECT_ROOT");
    let images = required_path("METORIGIN_TEST_IMAGE_DIR");
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packaging/macos-arm64/fixtures/james-sample-40.json"
    ))
    .unwrap();
    let before = fixture_hashes(&images, &expected);
    let paths = EnginePaths {
        ffmpeg: Some(required_path("METORIGIN_TEST_FFMPEG")),
        ffprobe: Some(required_path("METORIGIN_TEST_FFPROBE")),
        colmap: Some(required_path("METORIGIN_TEST_COLMAP")),
        brush: Some(required_path("METORIGIN_TEST_BRUSH")),
    };
    let manager = ProjectManager::new(root.clone());
    let name = if video {
        "M1 视频 中文 空格"
    } else {
        "M1 照片 中文 空格"
    };
    // Never reuse or overwrite a previous acceptance project.
    let (mut project, project_dir) = manager.create_project(name).unwrap();
    let input_video = if video {
        Some(required_path("METORIGIN_TEST_VIDEO"))
    } else {
        None
    };
    let video_hash = input_video.as_deref().map(sha256);
    if let Some(input) = &input_video {
        let name = input.file_name().unwrap();
        std::fs::copy(input, project_dir.join("source").join(name)).unwrap();
        project.source = Some(ProjectSource::Video(VideoSource {
            filename: name.to_string_lossy().into_owned(),
            copied_to_project: true,
        }));
    } else {
        for name in before.keys() {
            std::fs::copy(images.join(name), project_dir.join("source").join(name)).unwrap();
        }
        project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "James40 CC0".into(),
            image_count: 40,
            copied_to_project: true,
        }));
    }
    project.settings.preset = "fast".into();
    project.settings.max_frames = 40;
    project.settings.max_long_edge = 960;
    project.settings.colmap_max_long_edge = 960;
    project.settings.frame_fps = Some(2.0);
    manager.save_project(&project, &project_dir).unwrap();
    let started = std::time::Instant::now();
    let runtime = probe_training_runtime(
        RuntimePlatform::Macos,
        paths.brush.as_deref().unwrap(),
        &project_dir.join("logs/preflight"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let TrainingRuntimeEvidence::Metal(brush) = runtime else {
        panic!("real Metal evidence required")
    };
    let mut profile = freeze_macos_execution_profile(
        MacosProfileRequest {
            os_version: system_value("sw_vers", &["-productVersion"]),
            physical_memory_bytes: system_value("sysctl", &["-n", "hw.memsize"])
                .parse()
                .unwrap(),
            available_threads: std::thread::available_parallelism().unwrap().get() as u32,
            preset: "fast".into(),
            requested_resolution: 960,
            engine_paths: paths.clone(),
            engine_pack_id: None,
        },
        &brush,
    )
    .await
    .unwrap();
    // Explicit smoke overrides are frozen and recorded. This is not preset quality acceptance.
    profile.effective_training.iterations = 300;
    profile.effective_training.max_splats = Some(300_000);
    profile.effective_training.image_cache_budget_bytes = Some(256 * 1024 * 1024);
    profile.effective_training.threads = 4;
    profile.validate_for_execution().unwrap();
    let orchestrator = PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        PipelineConfig {
            preset: "fast".into(),
            engine_paths: paths,
            execution_profile: Some(Arc::new(profile.clone())),
        },
    );
    let mut events = orchestrator.subscribe();
    let events_task = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if !matches!(event, splat_pipeline::OrchestratorEvent::StageProgress(_)) {
                eprintln!("{event:?}");
            }
        }
    });
    let result = orchestrator.start_with_lock("macos-core-acceptance").await;
    events_task.abort();
    result.unwrap();
    let state = orchestrator.get_state().await;
    assert!(state
        .stages
        .values()
        .all(|stage| matches!(stage.status, StageStatus::Completed | StageStatus::Skipped)));
    assert_eq!(
        state.stages[&PipelineStageId::BrushTraining].status,
        StageStatus::Completed
    );
    let reconstruction = read_colmap_result(&project_dir.join("colmap/result.json")).unwrap();
    assert!(reconstruction.registered_images >= 36, "{reconstruction:?}");
    assert_eq!(
        validate_model_image_dimensions(
            &project_dir.join("training/dataset/sparse/0"),
            &project_dir.join("training/dataset/images"),
        )
        .unwrap(),
        reconstruction.registered_images
    );
    let output = project_dir.join("output/scene.ply");
    let metadata = ExportManager::inspect_ply(&output).unwrap();
    assert!(metadata.vertex_count > 0 && metadata.vertex_count <= 300_000);
    assert_eq!(metadata.sh_degree, 0);
    let saved = splat_project::load_execution_profile(&project_dir)
        .unwrap()
        .unwrap();
    assert_eq!(saved, profile);
    assert_eq!(fixture_hashes(&images, &expected), before);
    assert_eq!(input_video.as_deref().map(sha256), video_hash);
    let training: splat_pipeline::BrushTrainingResult =
        serde_json::from_slice(&std::fs::read(project_dir.join("training/result.json")).unwrap())
            .unwrap();
    assert_eq!(training.total_iterations, 300);
    let evidence = serde_json::json!({
        "schema_version": 1, "status": "application_core_smoke_passed",
        "source_kind": if video { "video" } else { "images" },
        "fixture_id": "james-sample-cc0-40-v1",
        "video_fixture": if video { Some("derived MPEG4, 40 views at 2fps; not a separately captured video") } else { None },
        "input_video_sha256": video_hash,
        "source_hashes_unchanged": true,
        "profile": profile, "registered_images": reconstruction.registered_images,
        "vertex_count": metadata.vertex_count, "sh_degree": metadata.sh_degree,
        "ply_sha256": sha256(&output), "ply_bytes": std::fs::metadata(&output).unwrap().len(),
        "elapsed_seconds": started.elapsed().as_secs_f64(),
        "native_ui_verified": false, "clean_machine_verified": false,
    });
    std::fs::write(
        project_dir.join("runtime/acceptance-evidence.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    println!(
        "Application-core evidence: {}",
        project_dir
            .join("runtime/acceptance-evidence.json")
            .display()
    );
}

fn fixture_hashes(images: &Path, expected: &serde_json::Value) -> BTreeMap<String, String> {
    expected["images"]
        .as_array()
        .unwrap()
        .iter()
        .map(|image| {
            let name = image["path"].as_str().unwrap();
            let hash = sha256(&images.join(name));
            assert_eq!(
                hash,
                image["sha256"].as_str().unwrap(),
                "fixture identity changed: {name}"
            );
            (name.to_string(), hash)
        })
        .collect()
}

fn sha256(path: &Path) -> String {
    let mut file = std::fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    format!("{:x}", hash.finalize())
}

fn system_value(program: &str, args: &[&str]) -> String {
    let output = splat_process::background_command(program)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn required_path(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    assert!(
        path.is_absolute() && path.exists(),
        "{name} must be an existing absolute path"
    );
    path
}
