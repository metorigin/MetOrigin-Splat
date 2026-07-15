use std::path::{Path, PathBuf};

use splat_domain::project::{ImageFolderSource, ProjectSource};
use splat_domain::{EnginePaths, ProjectStatus};
use splat_engine_colmap::{
    inspect_database, read_colmap_result, validate_model_image_dimensions, QualityDecision,
    ValidationReport,
};
use splat_pipeline::image_input::{read_image_manifest, scan_image_directory};
use splat_pipeline::{
    ColmapFeatureStage, ColmapMappingStage, ColmapMatchingStage, ColmapValidationStage,
    FrameExtractionStage, ImagePreprocessingStage, MediaValidationStage, PipelineConfig,
    PipelineOrchestrator, TrainingPreparationStage,
};
use splat_project::ProjectManager;

#[tokio::test]
#[ignore = "requires METORIGIN_TEST_IMAGE_DIR, METORIGIN_TEST_PROJECT_ROOT, and METORIGIN_TEST_COLMAP"]
async fn reconstructs_real_image_folder_without_ffmpeg() {
    let input = required_path("METORIGIN_TEST_IMAGE_DIR");
    let project_root = required_path("METORIGIN_TEST_PROJECT_ROOT");
    let colmap = required_path("METORIGIN_TEST_COLMAP");
    let scan = scan_image_directory(&input).unwrap();
    assert_eq!(
        scan.images.len(),
        73,
        "the acceptance dataset must contain 73 valid images"
    );

    let manager = ProjectManager::new(project_root.clone());
    let expected_project_dir = project_root.join("real-image-enhanced.splat-project");
    let (mut project, project_dir) = if expected_project_dir.exists() {
        (
            manager.open_project(&expected_project_dir).unwrap(),
            expected_project_dir,
        )
    } else {
        manager.create_project("real-image-enhanced").unwrap()
    };
    project.source = Some(ProjectSource::ImageFolder(ImageFolderSource {
        folder_name: input
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        image_count: scan.images.len(),
        copied_to_project: true,
    }));
    project.settings.preset = "fast".into();
    project.settings.max_frames = 300;
    project.settings.max_long_edge = 1280;
    project.settings.colmap_max_long_edge = 2560;
    project.status = ProjectStatus::Ready;
    manager.save_project(&project, &project_dir).unwrap();
    copy_image_source(&input, &project_dir.join("source"));

    let config = PipelineConfig {
        preset: "fast".into(),
        engine_paths: EnginePaths {
            ffmpeg: None,
            ffprobe: None,
            colmap: Some(colmap),
            brush: None,
        },
    };
    let mut orchestrator = PipelineOrchestrator::new_with_config(project_dir.clone(), config);
    orchestrator.register_stage(Box::new(MediaValidationStage::new()));
    orchestrator.register_stage(Box::new(FrameExtractionStage::new("fast")));
    orchestrator.register_stage(Box::new(ImagePreprocessingStage::new()));
    orchestrator.register_stage(Box::new(ColmapFeatureStage::new()));
    orchestrator.register_stage(Box::new(ColmapMatchingStage::new()));
    orchestrator.register_stage(Box::new(ColmapMappingStage::new()));
    orchestrator.register_stage(Box::new(ColmapValidationStage::new()));
    orchestrator.register_stage(Box::new(TrainingPreparationStage::new("fast")));
    orchestrator
        .start_with_lock("real-image-pipeline-test")
        .await
        .unwrap();

    let manifest = read_image_manifest(&project_dir.join("frames/frames.json"))
        .unwrap()
        .unwrap();
    assert_eq!(manifest.schema_version, 3);
    assert_eq!(manifest.selected_image_count, 73);
    assert_eq!(manifest.reconstruction_long_edge, 2560);
    assert_eq!(manifest.training_long_edge, 1280);
    assert!(manifest.camera_groups.len() <= 2);
    assert!(manifest
        .frames
        .iter()
        .all(|frame| frame.width.max(frame.height) <= 2560));

    let database = inspect_database(&project_dir.join("colmap/database.db")).unwrap();
    assert_eq!(database.images, 73);
    assert!(database.keypoints > 0);
    assert!(database.cameras <= 2);

    let result = read_colmap_result(&project_dir.join("colmap/result.json")).unwrap();
    assert_eq!(result.source_kind.as_deref(), Some("images"));
    assert!(result.registered_images >= 66, "result: {result:?}");
    assert!(result
        .attempts
        .first()
        .is_some_and(|attempt| attempt.matching_strategy.contains("exhaustive")
            && attempt.mapper == "global_mapper"));

    let validation: ValidationReport =
        serde_json::from_slice(&std::fs::read(project_dir.join("colmap/validation.json")).unwrap())
            .unwrap();
    assert_eq!(validation.decision, QualityDecision::Pass);

    let training_images = project_dir.join("training/dataset/images");
    let training_model = project_dir.join("training/dataset/sparse/0");
    assert_eq!(
        validate_model_image_dimensions(&training_model, &training_images).unwrap(),
        result.registered_images
    );
    assert_eq!(count_images(&training_images), result.registered_images);
    assert!(image_long_edges(&training_images)
        .into_iter()
        .all(|edge| edge <= 1280));

    println!("real image acceptance project: {}", project_dir.display());
}

fn copy_image_source(input: &Path, target: &Path) {
    for entry in walkdir::WalkDir::new(input)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let relative = entry.path().strip_prefix(input).unwrap();
        let destination = target.join(relative);
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        if !destination.exists() {
            std::fs::hard_link(entry.path(), &destination)
                .or_else(|_| std::fs::copy(entry.path(), &destination).map(|_| ()))
                .unwrap();
        }
    }
}

fn count_images(directory: &Path) -> usize {
    image_long_edges(directory).len()
}

fn image_long_edges(directory: &Path) -> Vec<u32> {
    std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| image::image_dimensions(entry.path()).ok())
        .map(|(width, height)| width.max(height))
        .collect()
}

fn required_path(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required"));
    let path = PathBuf::from(value);
    assert!(path.exists(), "{} does not exist: {}", name, path.display());
    path
}
