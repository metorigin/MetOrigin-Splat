use std::path::Path;

use splat_domain::pipeline::{PipelineStageId, PipelineState, StageStatus};

/// Action to take for recovering a project after a crash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryActionType {
    /// Continue pipeline — retry the last failed stage and proceed.
    Continue,
    /// Restart the entire pipeline from scratch.
    Restart,
    /// No recovery needed — project is in a clean state.
    NoActionNeeded,
}

/// Recommendation for how to handle a potentially crashed project.
#[derive(Debug, Clone)]
pub struct RecoveryAction {
    /// What to do.
    pub action: RecoveryActionType,
    /// Human-readable message explaining the situation.
    pub message: String,
    /// Current pipeline state snapshot.
    pub state: PipelineState,
}

/// Detects incomplete projects after a crash and generates recovery actions.
///
/// # Usage
///
/// Called when a project is opened. Examines the project's pipeline state
/// and output directories to determine if recovery is needed.
pub struct CrashRecovery;

impl CrashRecovery {
    /// Detect whether a project needs crash recovery.
    ///
    /// Checks the pipeline state from `project.json` and verifies the
    /// integrity of completed stage outputs.
    ///
    /// # Logic
    ///
    /// 1. If no stage is "Running" → no action needed (project is clean).
    /// 2. If a stage is "Running" → verify all prior stages' outputs:
    ///    - Prior stages with complete outputs → skip them
    ///    - The Running stage → mark as Failed (it crashed)
    ///    - All subsequent stages → Pending
    /// 3. Return `RecoveryAction::Continue` so the pipeline can resume.
    pub fn detect(state: &PipelineState, project_dir: &Path) -> RecoveryAction {
        // Build a mutable copy of the state for recovery adjustments
        let mut recovered_state = state.clone();
        let mut found_running = false;
        let mut messages = Vec::new();

        // Walk through all stages in order
        for stage_id in PipelineStageId::all() {
            let stage_state = match recovered_state.stages.get(stage_id) {
                Some(s) => s.clone(),
                None => continue,
            };

            match stage_state.status {
                // Stage was running when the crash happened
                StageStatus::Running | StageStatus::Preparing | StageStatus::Cancelling => {
                    found_running = true;

                    // Verify this stage's outputs
                    let outputs_ok = Self::verify_stage_outputs(stage_id, project_dir);

                    if outputs_ok {
                        // Outputs are intact — mark as completed
                        if let Some(s) = recovered_state.stages.get_mut(stage_id) {
                            s.status = StageStatus::Completed;
                            s.progress = 1.0;
                        }
                        messages.push(format!(
                            "阶段“{}”已完成但尚未记录，现已标记为完成。",
                            stage_label_zh(stage_id)
                        ));
                    } else {
                        // Outputs are not intact — mark as failed for retry
                        if let Some(s) = recovered_state.stages.get_mut(stage_id) {
                            s.status = StageStatus::Failed;
                            s.error =
                                Some("Pipeline was interrupted (crash or shutdown).".to_string());
                        }
                        messages.push(format!(
                            "阶段“{}”被中断，将重新执行。",
                            stage_label_zh(stage_id)
                        ));
                    }
                }

                // Stage was Completed — verify output integrity
                StageStatus::Completed if !Self::verify_stage_outputs(stage_id, project_dir) => {
                    tracing::warn!(
                        "Stage '{}' is marked completed but outputs are missing. Re-executing.",
                        stage_label_zh(stage_id)
                    );
                    if let Some(s) = recovered_state.stages.get_mut(stage_id) {
                        s.status = StageStatus::Pending;
                        s.progress = 0.0;
                    }
                    messages.push(format!(
                        "阶段“{}”的输出缺失，将重新执行。",
                        stage_id.label()
                    ));
                }

                // Other states: keep as-is
                _ => {}
            }
        }

        if found_running {
            recovered_state.current_stage = None;
        }

        // Build the recovery action
        if found_running || !messages.is_empty() {
            let message = if found_running {
                format!(
                    "上一次处理流程被中断，将重新执行 {} 个阶段。",
                    recovered_state
                        .stages
                        .values()
                        .filter(|s| s.status == StageStatus::Failed)
                        .count()
                )
            } else {
                messages.join(" ")
            };

            RecoveryAction {
                action: RecoveryActionType::Continue,
                message,
                state: recovered_state,
            }
        } else {
            RecoveryAction {
                action: RecoveryActionType::NoActionNeeded,
                message: "项目状态正常，无需恢复。".to_string(),
                state: recovered_state,
            }
        }
    }

    /// Verify that the output for a given stage exists on disk.
    ///
    /// Each stage has specific output files that must be present for the
    /// stage to be considered "complete".
    fn verify_stage_outputs(stage_id: &PipelineStageId, project_dir: &Path) -> bool {
        match stage_id {
            PipelineStageId::MediaValidation => {
                // Source directory should have media files
                let source_dir = project_dir.join("source");
                source_dir.exists() && has_media_files(&source_dir)
            }
            PipelineStageId::FrameExtraction => {
                // frames/frames.json should exist
                let manifest = project_dir.join("frames").join("frames.json");
                manifest.exists()
            }
            PipelineStageId::ImagePreprocessing => {
                // processed/ directory has images
                let processed_dir = project_dir.join("processed");
                processed_dir.exists() && has_image_files(&processed_dir)
            }
            PipelineStageId::ColmapFeatureExtraction => {
                // colmap/database.db exists and is non-empty
                let db = project_dir.join("colmap").join("database.db");
                db.exists()
                    && std::fs::metadata(&db)
                        .map(|m| m.len() > 1024)
                        .unwrap_or(false)
            }
            PipelineStageId::ColmapMatching => {
                // colmap/database.db exists (matching writes into same db)
                let db = project_dir.join("colmap").join("database.db");
                db.exists()
            }
            PipelineStageId::ColmapMapping => {
                // colmap/sparse/0/cameras.bin exists
                let cameras = project_dir
                    .join("colmap")
                    .join("sparse")
                    .join("0")
                    .join("cameras.bin");
                cameras.exists()
            }
            PipelineStageId::ColmapValidation => {
                // colmap/sparse/0/ with at least cameras.bin and images.bin
                let sparse0 = project_dir.join("colmap").join("sparse").join("0");
                sparse0.join("cameras.bin").exists() || sparse0.join("cameras.txt").exists()
            }
            PipelineStageId::TrainingPreparation => {
                let training = project_dir.join("training");
                training.join("config/config.json").is_file()
                    && training.join("dataset/sparse/0/cameras.bin").is_file()
                    && has_image_files(&training.join("dataset/images"))
            }
            PipelineStageId::BrushTraining => {
                let result_path = project_dir.join("training/result.json");
                std::fs::read_to_string(result_path)
                    .ok()
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                    .and_then(|result| {
                        result["checkpoint_path"]
                            .as_str()
                            .map(|path| project_dir.join(path))
                    })
                    .map(|path| valid_ply(&path))
                    .unwrap_or(false)
            }
            PipelineStageId::ModelValidation => {
                let validation = project_dir.join("training/validation.json");
                std::fs::read_to_string(validation)
                    .ok()
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                    .and_then(|report| report["passed"].as_bool())
                    .unwrap_or(false)
            }
            PipelineStageId::PreviewGeneration => {
                // output/manifest.json exists
                let manifest = project_dir.join("output").join("manifest.json");
                manifest.exists()
            }
            PipelineStageId::Export => {
                let ply = project_dir.join("output").join("scene.ply");
                valid_ply(&ply)
            }
        }
    }

    /// Check if the entire pipeline is fully completed.
    pub fn is_pipeline_complete(state: &PipelineState) -> bool {
        state
            .stages
            .values()
            .all(|s| s.status == StageStatus::Completed || s.status == StageStatus::Skipped)
    }
}

// ─── Helper functions ─────────────────────────────────────────────────────

fn has_media_files(dir: &Path) -> bool {
    count_files_with_extensions(dir, &["mp4", "mov", "avi", "mkv", "jpg", "jpeg", "png"]) > 0
}

fn stage_label_zh(stage_id: &PipelineStageId) -> &'static str {
    match stage_id {
        PipelineStageId::MediaValidation => "媒体校验",
        PipelineStageId::FrameExtraction => "帧提取",
        PipelineStageId::ImagePreprocessing => "图像预处理",
        PipelineStageId::ColmapFeatureExtraction => "COLMAP 特征提取",
        PipelineStageId::ColmapMatching => "COLMAP 特征匹配",
        PipelineStageId::ColmapMapping => "COLMAP 稀疏重建",
        PipelineStageId::ColmapValidation => "COLMAP 结果校验",
        PipelineStageId::TrainingPreparation => "训练准备",
        PipelineStageId::BrushTraining => "Brush 训练",
        PipelineStageId::ModelValidation => "模型校验",
        PipelineStageId::PreviewGeneration => "预览生成",
        PipelineStageId::Export => "导出",
    }
}

fn has_image_files(dir: &Path) -> bool {
    count_files_with_extensions(dir, &["jpg", "jpeg", "png"]) > 0
}

fn valid_ply(path: &Path) -> bool {
    if !path.is_file()
        || std::fs::metadata(path)
            .map(|m| m.len() == 0)
            .unwrap_or(true)
    {
        return false;
    }
    let mut magic = [0u8; 3];
    std::fs::File::open(path)
        .and_then(|mut file| {
            use std::io::Read;
            file.read_exact(&mut magic)
        })
        .is_ok()
        && &magic == b"ply"
}

fn count_files_with_extensions(dir: &Path, exts: &[&str]) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|reader| {
            reader
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| exts.iter().any(|e| ext.eq_ignore_ascii_case(e)))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_domain::pipeline::StageState;
    use std::collections::HashMap;

    fn create_stage_outputs(project_dir: &Path) {
        let paths = [
            "source",
            "frames",
            "processed",
            "colmap/sparse/0",
            "training/config",
            "training/dataset/sparse/0",
            "training/dataset/images",
            "training/checkpoints",
            "output",
        ];
        for path in paths {
            std::fs::create_dir_all(project_dir.join(path)).unwrap();
        }

        std::fs::write(project_dir.join("source/video.mp4"), b"media").unwrap();
        std::fs::write(project_dir.join("frames/frames.json"), b"{}").unwrap();
        std::fs::write(project_dir.join("processed/frame.jpg"), b"image").unwrap();
        std::fs::write(project_dir.join("colmap/database.db"), vec![0; 1025]).unwrap();
        std::fs::write(project_dir.join("colmap/sparse/0/cameras.bin"), b"camera").unwrap();
        std::fs::write(project_dir.join("training/config/config.json"), b"{}").unwrap();
        std::fs::write(
            project_dir.join("training/dataset/sparse/0/cameras.bin"),
            b"camera",
        )
        .unwrap();
        std::fs::write(
            project_dir.join("training/dataset/images/frame.jpg"),
            b"image",
        )
        .unwrap();
        let ply = b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n";
        std::fs::write(
            project_dir.join("training/checkpoints/checkpoint_3000.ply"),
            ply,
        )
        .unwrap();
        std::fs::write(
            project_dir.join("training/result.json"),
            br#"{"checkpoint_path":"training/checkpoints/checkpoint_3000.ply"}"#,
        )
        .unwrap();
        std::fs::write(
            project_dir.join("training/validation.json"),
            br#"{"passed":true}"#,
        )
        .unwrap();
        std::fs::write(project_dir.join("output/scene.ply"), ply).unwrap();
        std::fs::write(project_dir.join("output/manifest.json"), b"{}").unwrap();
    }

    fn create_early_stage_outputs(project_dir: &Path) {
        std::fs::create_dir_all(project_dir.join("source")).unwrap();
        std::fs::create_dir_all(project_dir.join("frames")).unwrap();
        std::fs::write(project_dir.join("source/video.mp4"), b"media").unwrap();
        std::fs::write(project_dir.join("frames/frames.json"), b"{}").unwrap();
    }

    fn make_state(stages: Vec<(PipelineStageId, StageStatus)>) -> PipelineState {
        let mut map = HashMap::new();
        for (id, status) in stages {
            let mut s = StageState::new(id);
            s.status = status;
            if status == StageStatus::Completed {
                s.progress = 1.0;
            }
            map.insert(id, s);
        }
        PipelineState {
            stages: map,
            current_stage: None,
            overall_progress: 0.0,
        }
    }

    fn all_completed_state() -> PipelineState {
        let stages: Vec<_> = PipelineStageId::all()
            .iter()
            .map(|id| (*id, StageStatus::Completed))
            .collect();
        make_state(stages)
    }

    // PipelineStageId doesn't have .index(), so we use a simpler approach
    fn make_partial_state(completed_up_to: PipelineStageId) -> PipelineState {
        let mut map = HashMap::new();
        let all = PipelineStageId::all();
        let mut found = false;
        for id in all {
            if *id == completed_up_to {
                found = true;
                let mut s = StageState::new(*id);
                s.status = StageStatus::Running;
                map.insert(*id, s);
            } else if !found {
                let mut s = StageState::new(*id);
                s.status = StageStatus::Completed;
                s.progress = 1.0;
                map.insert(*id, s);
            } else {
                map.insert(*id, StageState::new(*id));
            }
        }
        PipelineState {
            stages: map,
            current_stage: Some(completed_up_to),
            overall_progress: 0.0,
        }
    }

    #[test]
    fn test_detect_clean_project() {
        let state = all_completed_state();
        let dir = std::env::temp_dir().join("splat-recovery-clean");
        let _ = std::fs::remove_dir_all(&dir);
        create_stage_outputs(&dir);

        let action = CrashRecovery::detect(&state, &dir);
        assert_eq!(action.action, RecoveryActionType::NoActionNeeded);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_detect_crashed_during_extraction() {
        let state = make_partial_state(PipelineStageId::FrameExtraction);
        let dir = std::env::temp_dir().join("splat-recovery-crash");
        let _ = std::fs::create_dir_all(&dir);

        let action = CrashRecovery::detect(&state, &dir);
        assert_eq!(action.action, RecoveryActionType::Continue);
        assert!(!action.message.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_pipeline_complete_true() {
        let state = all_completed_state();
        assert!(CrashRecovery::is_pipeline_complete(&state));
    }

    #[test]
    fn test_is_pipeline_complete_false() {
        let state = make_partial_state(PipelineStageId::FrameExtraction);
        assert!(!CrashRecovery::is_pipeline_complete(&state));
    }

    #[test]
    fn test_verify_stage_outputs_nonexistent() {
        let dir = Path::new("/nonexistent/project");
        let result = CrashRecovery::verify_stage_outputs(&PipelineStageId::MediaValidation, dir);
        assert!(!result);
    }

    #[test]
    fn test_has_media_files() {
        let dir = std::env::temp_dir().join("splat-recovery-media");
        let _ = std::fs::create_dir_all(&dir);
        assert!(!has_media_files(&dir));
        std::fs::write(dir.join("video.mp4"), b"fake").unwrap();
        assert!(has_media_files(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_recovery_preserves_completed_stages() {
        let state = make_partial_state(PipelineStageId::ColmapMapping);
        let dir = std::env::temp_dir().join("splat-recovery-preserve");
        let _ = std::fs::remove_dir_all(&dir);
        create_early_stage_outputs(&dir);

        let action = CrashRecovery::detect(&state, &dir);

        // Prior stages (like MediaValidation, FrameExtraction) should remain Completed
        assert_eq!(
            action
                .state
                .stages
                .get(&PipelineStageId::MediaValidation)
                .unwrap()
                .status,
            StageStatus::Completed
        );
        assert_eq!(
            action
                .state
                .stages
                .get(&PipelineStageId::FrameExtraction)
                .unwrap()
                .status,
            StageStatus::Completed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_partial_brush_checkpoint_requires_resume() {
        let state = make_partial_state(PipelineStageId::BrushTraining);
        let dir = std::env::temp_dir().join("splat-recovery-brush-partial");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("training/checkpoints")).unwrap();
        std::fs::write(
            dir.join("training/checkpoints/checkpoint_0500.ply"),
            b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n",
        )
        .unwrap();

        let action = CrashRecovery::detect(&state, &dir);
        assert_eq!(
            action.state.stages[&PipelineStageId::BrushTraining].status,
            StageStatus::Failed
        );
        assert!(action.state.current_stage.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
