use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use splat_domain::{EnginePaths, PipelineStageId, StageStatus};
use splat_engine_brush::{CheckpointScanner, ExportManager};
use splat_pipeline::{
    BrushTrainingResult, BrushTrainingStage, ExportStage, LockStatus, ModelValidationStage,
    PipelineConfig, PipelineOrchestrator, PreviewGenerationStage, ProjectLock,
    TrainingPreparationStage,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default, serde::Serialize)]
struct GpuProfile {
    baseline_memory_mib: u64,
    peak_memory_mib: u64,
    peak_gpu_utilization_percent: u64,
    samples: u64,
}

#[tokio::test]
#[ignore = "requires a real COLMAP project and METORIGIN_TEST_BRUSH"]
async fn cancels_resumes_and_exports_real_brush_training() {
    let project_dir = required_path("METORIGIN_TEST_PROJECT_DIR");
    let brush = required_path("METORIGIN_TEST_BRUSH");
    assert!(project_dir.join("colmap/result.json").is_file());
    reset_brush_outputs(&project_dir);
    let gpu_stop = CancellationToken::new();
    let gpu_profile = Arc::new(Mutex::new(GpuProfile::default()));
    let gpu_monitor = tokio::spawn(monitor_gpu(gpu_profile.clone(), gpu_stop.clone()));

    let mut first = configured_orchestrator(&project_dir, &brush);
    first.register_stage(Box::new(TrainingPreparationStage::new("fast")));
    first.register_stage(Box::new(BrushTrainingStage::new("fast")));
    let first = Arc::new(first);
    let running = {
        let first = first.clone();
        tokio::spawn(async move { first.start_with_lock("real-brush-cancel").await })
    };

    wait_for_checkpoint(&project_dir.join("training/checkpoints"), 500).await;
    first.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), running)
        .await
        .expect("Brush did not stop within 60 seconds")
        .unwrap()
        .unwrap();
    let cancelled = first.get_state().await;
    assert_eq!(
        cancelled.stages[&PipelineStageId::BrushTraining].status,
        StageStatus::Cancelled
    );
    assert!(matches!(
        ProjectLock::check(&project_dir),
        LockStatus::Unlocked
    ));
    let partial = CheckpointScanner::find_latest(&project_dir.join("training/checkpoints"))
        .unwrap()
        .unwrap();
    assert!((500..3000).contains(&partial.iteration));

    let mut resumed = configured_orchestrator(&project_dir, &brush);
    register_brush_tail(&mut resumed);
    resumed.start_with_lock("real-brush-resume").await.unwrap();
    let state = resumed.get_state().await;
    for stage in [
        PipelineStageId::TrainingPreparation,
        PipelineStageId::BrushTraining,
        PipelineStageId::ModelValidation,
        PipelineStageId::Export,
        PipelineStageId::PreviewGeneration,
    ] {
        assert!(matches!(
            state.stages[&stage].status,
            StageStatus::Completed | StageStatus::Skipped
        ));
    }

    let training: BrushTrainingResult = serde_json::from_str(
        &std::fs::read_to_string(project_dir.join("training/result.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(training.total_iterations, 3000);
    assert!(training.resumed_from_iteration >= 500);
    assert!(!training.optimizer_state_restored);
    assert!(training.final_loss.is_none());
    let scene = project_dir.join("output/scene.ply");
    ExportManager::validate_ply(&scene).unwrap();
    assert!(ExportManager::vertex_count(&scene).unwrap() > 0);
    assert!(project_dir.join("output/manifest.json").is_file());
    gpu_stop.cancel();
    let _ = gpu_monitor.await;
    let profile = gpu_profile.lock().await;
    std::fs::write(
        project_dir.join("training/gpu-profile.json"),
        serde_json::to_vec_pretty(&*profile).unwrap(),
    )
    .unwrap();

    let started = Instant::now();
    let mut cached = configured_orchestrator(&project_dir, &brush);
    register_brush_tail(&mut cached);
    cached.start_with_lock("real-brush-cache").await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
}

async fn monitor_gpu(profile: Arc<Mutex<GpuProfile>>, stop: CancellationToken) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                let output = std::process::Command::new("nvidia-smi")
                    .args(["--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"])
                    .output();
                let Ok(output) = output else { continue };
                let text = String::from_utf8_lossy(&output.stdout);
                let Some(line) = text.lines().next() else { continue };
                let mut values = line.split(',').filter_map(|value| value.trim().parse::<u64>().ok());
                let (Some(memory), Some(utilization)) = (values.next(), values.next()) else { continue };
                let mut profile = profile.lock().await;
                if profile.samples == 0 {
                    profile.baseline_memory_mib = memory;
                }
                profile.peak_memory_mib = profile.peak_memory_mib.max(memory);
                profile.peak_gpu_utilization_percent = profile.peak_gpu_utilization_percent.max(utilization);
                profile.samples += 1;
            }
        }
    }
}

fn configured_orchestrator(project_dir: &Path, brush: &Path) -> PipelineOrchestrator {
    PipelineOrchestrator::new_with_config(
        project_dir.to_path_buf(),
        PipelineConfig {
            preset: "fast".to_string(),
            engine_paths: EnginePaths {
                ffmpeg: None,
                ffprobe: None,
                colmap: None,
                brush: Some(brush.to_path_buf()),
            },
        },
    )
}

fn register_brush_tail(orchestrator: &mut PipelineOrchestrator) {
    orchestrator.register_stage(Box::new(TrainingPreparationStage::new("fast")));
    orchestrator.register_stage(Box::new(BrushTrainingStage::new("fast")));
    orchestrator.register_stage(Box::new(ModelValidationStage::new()));
    orchestrator.register_stage(Box::new(ExportStage::new()));
    orchestrator.register_stage(Box::new(PreviewGenerationStage::new()));
}

async fn wait_for_checkpoint(directory: &Path, minimum_iteration: u32) {
    tokio::time::timeout(Duration::from_secs(20 * 60), async {
        loop {
            if CheckpointScanner::find_latest(directory)
                .ok()
                .flatten()
                .map(|checkpoint| checkpoint.iteration >= minimum_iteration)
                .unwrap_or(false)
            {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("Brush did not create a checkpoint within 20 minutes");
}

fn reset_brush_outputs(project_dir: &Path) {
    for relative in [
        "training/checkpoints",
        "training/config",
        "training/dataset",
        "training/logs",
    ] {
        let path = project_dir.join(relative);
        if path.exists() {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    for relative in [
        "training/result.json",
        "training/validation.json",
        "output/scene.ply",
        "output/manifest.json",
    ] {
        let path = project_dir.join(relative);
        if path.exists() {
            std::fs::remove_file(path).unwrap();
        }
    }
}

fn required_path(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required"));
    let path = Path::new(&value).to_path_buf();
    assert!(path.exists(), "{} does not exist: {}", name, path.display());
    path
}
