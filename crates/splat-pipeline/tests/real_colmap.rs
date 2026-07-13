use std::path::{Path, PathBuf};

use splat_domain::{EnginePaths, PipelineStageId, StageStatus};
use splat_engine_colmap::ValidationReport;
use splat_pipeline::{
    ColmapFeatureStage, ColmapMappingStage, ColmapMatchingStage, ColmapValidationStage,
    PipelineConfig, PipelineOrchestrator,
};

#[tokio::test]
#[ignore = "requires a real frame project and METORIGIN_TEST_COLMAP"]
async fn reconstructs_real_frames_or_writes_quality_diagnosis() {
    let project_dir = required_path("METORIGIN_TEST_PROJECT_DIR");
    let colmap = required_path("METORIGIN_TEST_COLMAP");
    assert!(project_dir.join("frames/frames.json").is_file());

    let config = PipelineConfig {
        preset: "fast".to_string(),
        engine_paths: EnginePaths {
            ffmpeg: None,
            ffprobe: None,
            colmap: Some(colmap),
            brush: None,
        },
    };
    let mut orchestrator = PipelineOrchestrator::new_with_config(project_dir.clone(), config);
    orchestrator.register_stage(Box::new(ColmapFeatureStage::new()));
    orchestrator.register_stage(Box::new(ColmapMatchingStage::new()));
    orchestrator.register_stage(Box::new(ColmapMappingStage::new()));
    orchestrator.register_stage(Box::new(ColmapValidationStage::new()));

    let execution = orchestrator.start_with_lock("real-colmap-test").await;
    let state = orchestrator.get_state().await;
    assert!(matches!(
        state.stages[&PipelineStageId::ColmapFeatureExtraction].status,
        StageStatus::Completed | StageStatus::Skipped
    ));
    assert!(matches!(
        state.stages[&PipelineStageId::ColmapMatching].status,
        StageStatus::Completed | StageStatus::Skipped
    ));
    assert!(matches!(
        state.stages[&PipelineStageId::ColmapMapping].status,
        StageStatus::Completed | StageStatus::Skipped
    ));
    assert!(project_dir.join("colmap/result.json").is_file());

    match execution {
        Ok(()) => {
            assert!(matches!(
                state.stages[&PipelineStageId::ColmapValidation].status,
                StageStatus::Completed | StageStatus::Skipped
            ));
            let report = read_report(&project_dir);
            assert!(report.passed);
        }
        Err(error) => {
            let report = read_report(&project_dir);
            assert!(!report.passed, "unexpected pipeline error: {error}");
            assert_eq!(
                state.stages[&PipelineStageId::ColmapValidation].status,
                StageStatus::Failed
            );
        }
    }
}

fn read_report(project_dir: &Path) -> ValidationReport {
    let path = project_dir.join("colmap/validation.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn required_path(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required"));
    let path = Path::new(&value).to_path_buf();
    assert!(path.exists(), "{} does not exist: {}", name, path.display());
    path
}
