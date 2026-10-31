//! Opt-in application-core acceptance. These tests run all twelve production
//! stages and real engines; they do not establish native WebView or packaging acceptance.
#![cfg(all(target_os = "windows", target_arch = "x86_64"))]

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use splat_domain::project::{ImageFolderSource, ProjectSource, VideoSource};
use splat_domain::runtime::RuntimePlatform;
use splat_domain::{EnginePaths, PipelineStageId, StageStatus};
use splat_engine_brush::{
    live_preview::{self, Frame, Request, Session},
    CheckpointScanner,
};
use splat_engine_brush::{probe_training_runtime, ExportManager, TrainingRuntimeEvidence};
use splat_engine_colmap::{read_colmap_result, validate_model_image_dimensions};
use splat_pipeline::runtime::{
    freeze_windows_execution_profile, WindowsProfileRequest, WindowsTrainingPolicy,
};
use splat_pipeline::{PipelineConfig, PipelineOrchestrator};
use splat_project::ProjectManager;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires public James40 images, paired Windows engines and explicit WGPU backend and a fresh test project root"]
async fn windows_real_photos_cancel_resume_restore_to_scene_ply() {
    run_pipeline(false, false).await;
}

#[tokio::test]
#[ignore = "requires fixed TUM RGB-D desk AVI, paired Windows engines, explicit WGPU backend and a fresh test project root"]
async fn windows_real_video_cancel_resume_restore_to_scene_ply() {
    run_pipeline(true, false).await;
}

#[tokio::test]
#[ignore = "requires fixed TUM desk AVI at15fps/max320, paired Windows engines and fresh medium project root"]
async fn windows_medium_video_resource_and_recovery() {
    run_pipeline(true, true).await;
}

async fn run_pipeline(video: bool, medium: bool) {
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
    let name = if medium {
        "Windows1 中型视频 中文 空格"
    } else if video {
        "Windows1 视频 中文 空格"
    } else {
        "Windows1 照片 中文 空格"
    };
    // Fresh runs never overwrite an acceptance project. An interrupted medium
    // project may only be reopened through an explicit, bounded opt-in.
    let resume_project = if medium {
        std::env::var_os("METORIGIN_TEST_RESUME_PROJECT").map(PathBuf::from)
    } else {
        None
    };
    let resuming = resume_project.is_some();
    let (mut project, project_dir) = if let Some(path) = resume_project {
        let path = path.canonicalize().unwrap();
        assert!(path.starts_with(root.canonicalize().unwrap()));
        (manager.open_project(&path).unwrap(), path)
    } else {
        manager.create_project(name).unwrap()
    };
    let input_video = if video {
        Some(required_path("METORIGIN_TEST_VIDEO"))
    } else {
        None
    };
    let video_hash = input_video.as_deref().map(sha256);
    if video {
        assert_eq!(
            video_hash.as_deref(),
            Some("3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854"),
            "TUM source identity changed"
        );
    }
    if let Some(input) = &input_video {
        let name = input.file_name().unwrap();
        if resuming {
            assert_eq!(
                sha256(&project_dir.join("source").join(name)),
                sha256(input)
            );
        } else {
            std::fs::copy(input, project_dir.join("source").join(name)).unwrap();
        }
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
    project.settings.max_frames = if medium {
        320
    } else if video {
        120
    } else {
        40
    };
    project.settings.max_long_edge = 960;
    project.settings.colmap_max_long_edge = 960;
    project.settings.frame_fps = Some(if medium {
        15.0
    } else if video {
        5.0
    } else {
        2.0
    });
    let resumed_guard = if resuming {
        let guard =
            splat_pipeline::ProjectLock::try_lock(&project_dir, "medium-interruption-recovery")
                .unwrap();
        let archive_root = project_dir.join("runtime/acceptance-interruptions");
        std::fs::create_dir_all(&archive_root).unwrap();
        let archive = archive_root.join(splat_domain::ProjectId::new().to_string());
        std::fs::create_dir(&archive).unwrap();
        let attempts = project_dir.join("colmap/attempts");
        if attempts.exists() {
            std::fs::rename(&attempts, archive.join("colmap-attempts")).unwrap();
        }
        for file in [
            "runtime/execution-profile.json",
            "runtime/pending-invalidation.json",
            "colmap/logs/video-sequential15-global.mapping.log",
        ] {
            let source = project_dir.join(file);
            if source.exists() {
                std::fs::copy(&source, archive.join(source.file_name().unwrap())).unwrap();
            }
        }
        Some(guard)
    } else {
        manager.save_project(&project, &project_dir).unwrap();
        None
    };
    let started = std::time::Instant::now();
    let runtime = probe_training_runtime(
        RuntimePlatform::Windows,
        paths.brush.as_deref().unwrap(),
        &project_dir.join("logs/preflight"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let TrainingRuntimeEvidence::WindowsWgpu(brush) = runtime else {
        panic!("real Windows WGPU evidence required")
    };
    let mut profile = freeze_windows_execution_profile(
        WindowsProfileRequest {
            os_version: system_value(
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[Console]::Write([Environment]::OSVersion.Version.ToString())",
                ],
            ),
            physical_memory_bytes: std::env::var("METORIGIN_TEST_SYSTEM_MEMORY_BYTES")
                .expect("Set the measured system RAM, not GPU VRAM")
                .parse()
                .unwrap(),
            available_adapter_budget_bytes: None,
            policy: WindowsTrainingPolicy::candidate(),
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
    let iterations: u32 = std::env::var("METORIGIN_TEST_ITERATIONS")
        .unwrap_or_else(|_| "300".into())
        .parse()
        .unwrap();
    assert!(iterations >= 300);
    profile.effective_training.iterations = iterations;
    profile.effective_training.max_splats = Some(300_000);
    profile.effective_training.image_cache_budget_bytes = Some(256 * 1024 * 1024);
    profile.effective_training.threads = 2;
    profile.validate_for_execution().unwrap();
    let config = PipelineConfig {
        preset: "fast".into(),
        engine_paths: paths,
        execution_profile: Some(Arc::new(profile.clone())),
    };
    let cancel_at = if iterations == 300 { 100 } else { 1000 };
    let first = Arc::new(PipelineOrchestrator::new_default_with_config(
        project_dir.clone(),
        config.clone(),
    ));
    if let Some(guard) = resumed_guard {
        first.adopt_execution_lock(guard).await.unwrap();
    }
    let live_stop = CancellationToken::new();
    let monitor = tokio::spawn(monitor_live(project_dir.clone(), live_stop.clone()));
    let running = {
        let first = first.clone();
        tokio::spawn(async move {
            if resuming {
                first.start_with_acquired_lock().await
            } else {
                first.start_with_lock("windows-core-cancel").await
            }
        })
    };
    let partial_ready = tokio::time::timeout(
        Duration::from_secs(20 * 60),
        wait_for_partial(&project_dir, cancel_at, iterations, &running),
    )
    .await;
    first.cancel().await.unwrap();
    let first_result = tokio::time::timeout(Duration::from_secs(60), running)
        .await
        .expect("pipeline failed to stop")
        .unwrap();
    live_stop.cancel();
    let mut frames = monitor.await.unwrap();
    first_result.unwrap();
    assert!(
        partial_ready.is_ok_and(|ready| ready.is_ok()),
        "No recoverable partial checkpoint before timeout or early engine exit"
    );
    let cancelled = first.get_state().await;
    assert_eq!(
        cancelled.stages[&PipelineStageId::BrushTraining].status,
        StageStatus::Cancelled
    );
    assert!(matches!(
        splat_pipeline::ProjectLock::check(&project_dir),
        splat_pipeline::LockStatus::Unlocked
    ));
    let partial = CheckpointScanner::find_latest(&project_dir.join("training/checkpoints"))
        .unwrap()
        .unwrap();
    assert!(partial.iteration >= cancel_at && partial.iteration < iterations);
    let partial_iteration = partial.iteration;
    let orchestrator =
        PipelineOrchestrator::new_default_with_config(project_dir.clone(), config.clone());
    frames.extend(run_with_live(&orchestrator, &project_dir, "windows-core-resume").await);
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
    if video {
        let expected_frames = if medium { 301..=320 } else { 100..=120 };
        assert!(
            expected_frames.contains(&reconstruction.total_images),
            "{reconstruction:?}"
        );
        assert!(
            reconstruction.registered_images * 100 >= reconstruction.total_images * 80,
            "{reconstruction:?}"
        );
    } else {
        assert!(reconstruction.registered_images >= 36, "{reconstruction:?}");
    }
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
    if let Some(input) = &input_video {
        assert_eq!(
            Some(sha256(
                &project_dir.join("source").join(input.file_name().unwrap())
            )),
            video_hash
        );
    } else {
        for (name, hash) in &before {
            assert_eq!(&sha256(&project_dir.join("source").join(name)), hash);
        }
    }
    let training: splat_pipeline::BrushTrainingResult =
        serde_json::from_slice(&std::fs::read(project_dir.join("training/result.json")).unwrap())
            .unwrap();
    assert_eq!(training.total_iterations, iterations);
    assert_eq!(training.resumed_from_iteration, partial_iteration);
    assert!(!training.optimizer_state_restored);
    assert!(!frames.is_empty(), "No real live snapshot was consumed");
    let completed_hash = sha256(&output);
    splat_pipeline::stages::brush_training::restore_checkpoint(&project_dir, cancel_at).unwrap();
    assert!(
        !output.exists(),
        "Restore must archive, not reuse the prior published result"
    );
    let restored =
        PipelineOrchestrator::new_default_with_config(project_dir.clone(), config.clone());
    frames.extend(run_with_live(&restored, &project_dir, "windows-core-explicit-restore").await);
    let restored_result: splat_pipeline::BrushTrainingResult =
        serde_json::from_slice(&std::fs::read(project_dir.join("training/result.json")).unwrap())
            .unwrap();
    assert_eq!(restored_result.resumed_from_iteration, cancel_at);
    assert!(!restored_result.optimizer_state_restored);
    ExportManager::validate_ply(&output).unwrap();
    let archived = walkdir::WalkDir::new(project_dir.join("runtime/checkpoint-restores"))
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name() == "scene.ply" && sha256(entry.path()) == completed_hash);
    assert!(
        archived,
        "Prior valid output must remain recoverable after explicit restore"
    );
    let cached = PipelineOrchestrator::new_default_with_config(project_dir.clone(), config);
    cached.start_with_lock("windows-core-cache").await.unwrap();
    assert_eq!(
        cached.get_state().await.stages[&PipelineStageId::BrushTraining].status,
        StageStatus::Skipped
    );
    let session: Session = serde_json::from_slice(
        &std::fs::read(
            project_dir
                .join(live_preview::DIRECTORY)
                .join("session.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!session.running);
    assert!(matches!(
        splat_pipeline::ProjectLock::check(&project_dir),
        splat_pipeline::LockStatus::Unlocked
    ));
    let metadata = ExportManager::inspect_ply(&output).unwrap();
    let evidence = serde_json::json!({
        "schema_version": 1, "status": "application_core_smoke_passed",
        "source_kind": if video { "video" } else { "images" },
        "medium_scene": medium,
        "continued_after_external_interruption": resuming,
        "scope": if medium { "medium-scene resource/recovery acceptance; native viewer and per-adapter VRAM budget remain separate" } else { "production application-core generation/recovery acceptance; native UI remains separate" },
        "frame_policy": {"fps":project.settings.frame_fps, "max_frames":project.settings.max_frames},
        "test_harness_overrides": {"preset":"fast", "iterations":iterations, "sh_degree":0, "resolution":960,
            "scope":"Explicit controlled smoke/recovery parameters; not production preset quality acceptance"},
        "source_video_metadata": if video { Some(serde_json::from_slice::<serde_json::Value>(&std::fs::read(project_dir.join("frames/frames.json")).unwrap()).unwrap()["source_metadata"].clone()) } else { None },
        "fixture_id": if video { "tum-rgbd-freiburg1-desk-rgb" } else { "james-sample-cc0-40-v1" },
        "video_fixture": if video { Some("TUM RGB-D Freiburg1 desk, CC-BY4.0; real captured video, extraction policy recorded separately") } else { None },
        "input_video_sha256": video_hash,
        "source_hashes_unchanged": true,
        "profile": profile, "registered_images": reconstruction.registered_images,
        "vertex_count": metadata.vertex_count, "sh_degree": metadata.sh_degree,
        "ply_sha256": sha256(&output), "ply_bytes": std::fs::metadata(&output).unwrap().len(),
        "elapsed_seconds": started.elapsed().as_secs_f64(),
        "cancelled_at_iteration": partial_iteration, "restore_iteration": cancel_at,
        "live_frames": frames, "prior_completed_output_preserved": true, "cache_verified": true,
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

async fn wait_for_partial(
    project: &Path,
    minimum: u32,
    target: u32,
    running: &tokio::task::JoinHandle<splat_domain::AppResult<()>>,
) -> Result<(), &'static str> {
    loop {
        if running.is_finished() {
            return Err("pipeline exited before cancellation checkpoint");
        }
        if let Some(checkpoint) =
            CheckpointScanner::find_latest(&project.join("training/checkpoints")).unwrap()
        {
            if checkpoint.iteration >= target {
                return Err("training completed before cancellation checkpoint");
            }
            if checkpoint.iteration >= minimum {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn run_with_live(
    orchestrator: &PipelineOrchestrator,
    project: &Path,
    reason: &str,
) -> Vec<serde_json::Value> {
    let stop = CancellationToken::new();
    let monitor = tokio::spawn(monitor_live(project.to_path_buf(), stop.clone()));
    let result = orchestrator.start_with_lock(reason).await;
    stop.cancel();
    let frames = monitor.await.unwrap();
    result.unwrap();
    frames
}

async fn monitor_live(project: PathBuf, stop: CancellationToken) -> Vec<serde_json::Value> {
    let root = project.join(live_preview::DIRECTORY);
    let mut observed_session = String::new();
    let mut revision = 0;
    let mut frames = Vec::new();
    loop {
        tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
        let Ok(bytes) = std::fs::read(root.join("session.json")) else {
            continue;
        };
        let session: Session = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(session.protocol, live_preview::PROTOCOL);
        if !session.running || !session.available {
            continue;
        }
        if observed_session != session.session_id {
            observed_session = session.session_id.clone();
            revision = 0;
        }
        let directory = root.join(&session.session_id);
        if let Ok(bytes) = std::fs::read(directory.join("latest.json")) {
            let frame: Frame = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(frame.protocol, live_preview::PROTOCOL);
            assert_eq!(frame.session_id, session.session_id);
            assert_eq!(frame.relative_path, format!("frame-{}.ply", frame.revision));
            if frame.revision > revision {
                let model = directory.join(&frame.relative_path);
                let metadata = ExportManager::inspect_ply(&model).unwrap();
                assert_eq!(metadata.vertex_count, u64::from(frame.splat_count));
                frames.push(serde_json::json!({"session_id":frame.session_id,"revision":frame.revision,
                    "iteration":frame.iteration,"gaussians":metadata.vertex_count,"sh_degree":metadata.sh_degree,"sha256":sha256(&model)}));
                revision = frame.revision;
            }
        }
        let expires_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 10_000;
        live_preview::write_json_atomic(
            &directory.join("request.json"),
            &Request {
                session_id: session.session_id,
                after_revision: revision,
                mode: "live".into(),
                expires_at_ms,
            },
        )
        .unwrap();
    }
    frames
}
