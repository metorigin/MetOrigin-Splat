use std::path::{Path, PathBuf};
use std::sync::Arc;

use splat_domain::{EnginePaths, PipelineStageId, StageStatus};
use splat_pipeline::{
    FrameExtractionStage, LockStatus, PipelineConfig, PipelineOrchestrator, ProjectLock,
};

#[tokio::test]
#[ignore = "requires METORIGIN_TEST_VIDEO, METORIGIN_TEST_PROJECT_DIR, and local FFmpeg paths"]
async fn extracts_real_video_with_fast_preset() {
    let video = required_path("METORIGIN_TEST_VIDEO");
    let project_dir = required_path("METORIGIN_TEST_PROJECT_DIR");
    let ffmpeg = required_path("METORIGIN_TEST_FFMPEG");
    let ffprobe = required_path("METORIGIN_TEST_FFPROBE");

    prepare_project(&project_dir, &video);
    let had_valid_manifest = project_dir.join("frames").join("frames.json").exists();

    let config = PipelineConfig {
        preset: "fast".to_string(),
        engine_paths: EnginePaths {
            ffmpeg: Some(ffmpeg),
            ffprobe: Some(ffprobe),
            colmap: None,
            brush: None,
        },
    };
    let mut orchestrator = PipelineOrchestrator::new_with_config(project_dir.clone(), config);
    orchestrator.register_stage(Box::new(FrameExtractionStage::new("fast")));

    orchestrator
        .start_with_lock("real-ffmpeg-test")
        .await
        .unwrap();

    let state = orchestrator.get_state().await;
    let expected_status = if had_valid_manifest {
        StageStatus::Skipped
    } else {
        StageStatus::Completed
    };
    assert_eq!(
        state.stages[&PipelineStageId::FrameExtraction].status,
        expected_status
    );
    let manifest_path = project_dir.join("frames").join("frames.json");
    let manifest: splat_engine_ffmpeg::FrameManifest =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert!(
        (250..=280).contains(&manifest.total_frames),
        "expected about 266 frames, got {}",
        manifest.total_frames
    );
    assert!(manifest
        .frames
        .iter()
        .all(|frame| { frame.size_bytes > 0 && frame.width > 0 && frame.height > 0 }));
}

#[tokio::test]
#[ignore = "requires METORIGIN_TEST_VIDEO, METORIGIN_TEST_PROJECT_DIR, and local FFmpeg paths"]
async fn cancels_real_ffmpeg_and_releases_project_lock() {
    let video = required_path("METORIGIN_TEST_VIDEO");
    let base_project = required_path("METORIGIN_TEST_PROJECT_DIR");
    let project_dir = base_project.with_file_name("ffmpeg-cancel.splat-project");
    let ffmpeg = required_path("METORIGIN_TEST_FFMPEG");
    let ffprobe = required_path("METORIGIN_TEST_FFPROBE");
    prepare_project(&project_dir, &video);

    let config = PipelineConfig {
        preset: "fast".to_string(),
        engine_paths: EnginePaths {
            ffmpeg: Some(ffmpeg),
            ffprobe: Some(ffprobe),
            colmap: None,
            brush: None,
        },
    };
    let mut orchestrator = PipelineOrchestrator::new_with_config(project_dir.clone(), config);
    orchestrator.register_stage(Box::new(FrameExtractionStage::new("fast")));
    let orchestrator = Arc::new(orchestrator);
    let running = orchestrator.clone();
    let task = tokio::spawn(async move { running.start_with_lock("cancel-test").await });

    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    orchestrator.cancel().await.unwrap();
    task.await.unwrap().unwrap();

    let state = orchestrator.get_state().await;
    assert_eq!(
        state.stages[&PipelineStageId::FrameExtraction].status,
        StageStatus::Cancelled
    );
    assert!(matches!(
        ProjectLock::check(&project_dir),
        LockStatus::Unlocked
    ));
    assert!(!project_dir.join("frames").join("frames.json").exists());
}

fn prepare_project(project_dir: &Path, video: &Path) {
    let source_dir = project_dir.join("source");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(project_dir.join("frames")).unwrap();
    std::fs::create_dir_all(project_dir.join("logs")).unwrap();
    let project_video = source_dir.join(video.file_name().unwrap());
    if !project_video.exists() {
        std::fs::hard_link(video, &project_video)
            .or_else(|_| std::fs::copy(video, &project_video).map(|_| ()))
            .unwrap();
    }
}

fn required_path(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required"));
    let path = Path::new(&value).to_path_buf();
    assert!(path.exists(), "{} does not exist: {}", name, path.display());
    path
}
