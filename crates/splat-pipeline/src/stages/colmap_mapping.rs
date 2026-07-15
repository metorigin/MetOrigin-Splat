use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    inspect_match_graph, read_colmap_result, read_registered_image_names,
    write_colmap_result_atomic, ColmapAttemptResult, ColmapAttemptStatus, ColmapMapperParser,
    ColmapResult, MapperKind, MatchingOptions, MatchingStrategy, ModelInfo,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;
use crate::stages::colmap_support::ColmapSourceKind;

const STRATEGY_VERSION: u32 = 3;

/// Runs source-appropriate global reconstruction and stronger fallbacks inside
/// the stable public ColmapMapping stage. Every successful model remains in an
/// independent attempt directory until the best candidate is atomically
/// published as colmap/sparse/0.
pub struct ColmapMappingStage;

impl Default for ColmapMappingStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapMappingStage {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Debug, Clone)]
struct AttemptPlan {
    id: &'static str,
    matching_label: &'static str,
    matching: Option<(MatchingStrategy, MatchingOptions)>,
    mapper: MapperKind,
}

#[derive(Debug, Clone)]
struct Candidate {
    attempt_index: usize,
    model_path: PathBuf,
    model_info: ModelInfo,
    hard_trainable: bool,
}

#[async_trait::async_trait]
impl PipelineStage for ColmapMappingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapMapping
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.colmap_db.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Missing",
                "The COLMAP database is required for mapping.",
            ));
        }
        colmap_support::image_dir(ctx)?;
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_result.exists() {
            return Ok(false);
        }
        let result = match read_colmap_result(&ctx.paths.colmap_result) {
            Ok(result) => result,
            Err(_) => return Ok(false),
        };
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        Ok(result.strategy_version == STRATEGY_VERSION
            && colmap_support::has_complete_model(&model_path)
            && result.registered_images >= 3
            && result.point_count >= 100)
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let adapter = colmap_support::adapter(ctx)?;
        let image_dir = colmap_support::image_dir(ctx)?;
        let total_images = colmap_support::count_images(&image_dir);
        let source_kind = colmap_support::source_kind(ctx)?;
        let plans = attempt_plans(source_kind);
        let attempts_root = ctx.paths.colmap_dir.join("attempts");
        reset_attempts(&attempts_root)?;

        let mut attempts = Vec::new();
        let mut candidates = Vec::new();
        let mut stopped_after_recommended_model = false;

        for (plan_index, plan) in plans.iter().enumerate() {
            if ctx.cancellation.is_cancelled() {
                return Err(cancelled_error());
            }
            let base_percent = plan_index as f64 / plans.len() as f64;
            let _ = progress_tx.send(
                TaskProgress::new(
                    "ColmapMapping",
                    format!(
                        "COLMAP attempt {}/{}: {}",
                        plan_index + 1,
                        plans.len(),
                        plan.id
                    ),
                )
                .with_percent(base_percent),
            );

            if let Some((strategy, options)) = plan.matching {
                let matching_command = adapter
                    .build_matching_command_with_options(
                        &ctx.paths.colmap_db,
                        &strategy,
                        &options,
                        &ctx.paths
                            .colmap_logs
                            .join(format!("{}.matching.log", plan.id)),
                    )
                    .with_cwd(&ctx.paths.colmap_dir)
                    .with_timeout(Duration::from_secs(2 * 60 * 60));
                let matching_result = ProcessRunner::new()
                    .run_to_completion(matching_command, ctx.cancellation.clone(), None)
                    .await?;
                if matching_result.cancelled || matching_result.timed_out {
                    colmap_support::ensure_success(&matching_result, "fallback matching")?;
                }
                if !matching_result.is_success() {
                    attempts.push(failed_attempt(
                        plan,
                        format!("matching exit code {:?}", matching_result.exit_code),
                    ));
                    continue;
                }
            }

            let attempt_root = attempts_root.join(plan.id);
            let sparse_dir = attempt_root.join("sparse");
            std::fs::create_dir_all(&sparse_dir).map_err(mapping_filesystem_error)?;
            let command = adapter
                .build_mapping_command_with_kind(
                    plan.mapper,
                    &ctx.paths.colmap_db,
                    &image_dir,
                    &sparse_dir,
                    &ctx.paths
                        .colmap_logs
                        .join(format!("{}.mapping.log", plan.id)),
                )
                .with_cwd(&ctx.paths.colmap_dir)
                .with_timeout(Duration::from_secs(4 * 60 * 60));
            let mut parsers = CompositeParser::new();
            parsers.add(Box::new(ColmapMapperParser::new("ColmapMapping")));
            let process_result = ProcessRunner::with_parser(parsers)
                .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx.clone()))
                .await?;
            if process_result.cancelled || process_result.timed_out {
                colmap_support::ensure_success(&process_result, "sparse mapping")?;
            }
            if !process_result.is_success() {
                attempts.push(failed_attempt(
                    plan,
                    format!("mapping exit code {:?}", process_result.exit_code),
                ));
                continue;
            }

            let analyzed = match adapter.mapper().analyze_result(&sparse_dir, total_images) {
                Ok(result) => result,
                Err(error) => {
                    attempts.push(failed_attempt(plan, error.to_string()));
                    continue;
                }
            };
            let model_path = analyzed.model_path;
            let model_info = match adapter.mapper().analyze_model(&model_path) {
                Ok(info) => info,
                Err(error) => {
                    attempts.push(failed_attempt(plan, error.to_string()));
                    continue;
                }
            };
            if !colmap_support::has_complete_model(&model_path) {
                attempts.push(failed_attempt(plan, "sparse model is incomplete".into()));
                continue;
            }
            let stored_attempt_path = model_path
                .strip_prefix(&ctx.project_dir)
                .unwrap_or(&model_path)
                .to_path_buf();
            let attempt_index = attempts.len();
            attempts.push(ColmapAttemptResult {
                id: plan.id.into(),
                matching_strategy: plan.matching_label.into(),
                mapper: mapper_name(plan.mapper).into(),
                status: ColmapAttemptStatus::Completed,
                model_path: Some(stored_attempt_path),
                model_info: Some(model_info.clone()),
                error: None,
            });
            candidates.push(Candidate {
                attempt_index,
                model_path: model_path.clone(),
                hard_trainable: hard_trainable(&model_info),
                model_info: model_info.clone(),
            });
            if recommended_quality(&model_info, total_images)
                && recommended_coverage(source_kind, &ctx.paths.colmap_db, &image_dir, &model_path)
                    .unwrap_or(false)
            {
                stopped_after_recommended_model = true;
                break;
            }
        }

        let selected = candidates
            .iter()
            .max_by(|left, right| compare_candidates(left, right))
            .ok_or_else(|| {
                AppError::new(
                    "E-3030",
                    ErrorCategory::Engine,
                    "No Sparse Model Generated",
                    "All source-appropriate COLMAP reconstruction attempts failed.",
                )
                .with_suggestions(vec![
                    "Inspect the per-attempt logs under colmap/logs",
                    "Verify that the images overlap and contain stable visual texture",
                ])
            })?;
        let selected_attempt_id = attempts[selected.attempt_index].id.clone();
        publish_selected_model(ctx, &selected.model_path)?;

        if ctx.paths.colmap_validation.exists() {
            std::fs::remove_file(&ctx.paths.colmap_validation).map_err(mapping_filesystem_error)?;
        }
        let acceptance = ctx.paths.colmap_dir.join("quality-acceptance.json");
        if acceptance.exists() {
            std::fs::remove_file(acceptance).map_err(mapping_filesystem_error)?;
        }

        let result = ColmapResult {
            registered_images: selected.model_info.registered_images,
            total_images,
            point_count: selected.model_info.point_count,
            model_path: PathBuf::from("colmap/sparse/0"),
            observations: Some(selected.model_info.observations),
            mean_reprojection_error: Some(selected.model_info.mean_reprojection_error),
            mean_track_length: Some(selected.model_info.mean_track_length),
            strategy_version: STRATEGY_VERSION,
            source_kind: Some(source_kind_name(source_kind).into()),
            selected_attempt_id: Some(selected_attempt_id.clone()),
            selection_reason: Some(selection_reason(selected, stopped_after_recommended_model)),
            attempts,
            automatic_fallbacks_exhausted: !stopped_after_recommended_model,
        };
        write_colmap_result_atomic(&result, &ctx.paths.colmap_result)?;
        let _ = progress_tx.send(
            TaskProgress::new(
                "ColmapMapping",
                format!(
                    "Selected {}: {}/{} images, {} points",
                    selected_attempt_id,
                    result.registered_images,
                    result.total_images,
                    result.point_count
                ),
            )
            .with_percent(1.0),
        );

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        if !colmap_support::has_complete_model(&model_path) {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "Sparse Model Not Created",
                "The selected COLMAP model is incomplete.",
            ));
        }
        Ok(())
    }
}

fn attempt_plans(kind: ColmapSourceKind) -> Vec<AttemptPlan> {
    let guided = MatchingOptions {
        guided_matching: true,
        exhaustive_block_size: 50,
        quadratic_overlap: true,
    };
    match kind {
        ColmapSourceKind::Images => vec![
            AttemptPlan {
                id: "images-exhaustive-global",
                matching_label: "exhaustive block=50",
                matching: None,
                mapper: MapperKind::Global,
            },
            AttemptPlan {
                id: "images-exhaustive-guided-global",
                matching_label: "exhaustive guided block=50",
                matching: Some((MatchingStrategy::Exhaustive, guided)),
                mapper: MapperKind::Global,
            },
            AttemptPlan {
                id: "images-guided-incremental",
                matching_label: "enhanced exhaustive guided database",
                matching: None,
                mapper: MapperKind::Incremental,
            },
        ],
        ColmapSourceKind::Video => vec![
            AttemptPlan {
                id: "video-sequential15-global",
                matching_label: "sequential overlap=15 quadratic",
                matching: None,
                mapper: MapperKind::Global,
            },
            AttemptPlan {
                id: "video-sequential30-guided-global",
                matching_label: "sequential overlap=30 guided quadratic",
                matching: Some((MatchingStrategy::Sequential { overlap: 30 }, guided)),
                mapper: MapperKind::Global,
            },
            AttemptPlan {
                id: "video-exhaustive-guided-global",
                matching_label: "exhaustive guided block=50",
                matching: Some((MatchingStrategy::Exhaustive, guided)),
                mapper: MapperKind::Global,
            },
            AttemptPlan {
                id: "video-guided-incremental",
                matching_label: "enhanced exhaustive guided database",
                matching: None,
                mapper: MapperKind::Incremental,
            },
        ],
    }
}

fn failed_attempt(plan: &AttemptPlan, error: String) -> ColmapAttemptResult {
    ColmapAttemptResult {
        id: plan.id.into(),
        matching_strategy: plan.matching_label.into(),
        mapper: mapper_name(plan.mapper).into(),
        status: ColmapAttemptStatus::Failed,
        model_path: None,
        model_info: None,
        error: Some(error),
    }
}

fn mapper_name(kind: MapperKind) -> &'static str {
    match kind {
        MapperKind::Global => "global_mapper",
        MapperKind::Incremental => "mapper",
    }
}

fn source_kind_name(kind: ColmapSourceKind) -> &'static str {
    match kind {
        ColmapSourceKind::Images => "images",
        ColmapSourceKind::Video => "video",
    }
}

fn hard_trainable(info: &ModelInfo) -> bool {
    info.registered_images >= 3
        && info.point_count >= 100
        && (info.mean_reprojection_error <= 8.0 || info.mean_reprojection_error == 0.0)
}

fn recommended_quality(info: &ModelInfo, total_images: usize) -> bool {
    let minimum_registered = total_images.min(20);
    let rate = if total_images == 0 {
        0.0
    } else {
        info.registered_images as f64 / total_images as f64
    };
    info.registered_images >= minimum_registered
        && rate >= 0.5
        && info.point_count >= 1000
        && info.mean_track_length >= 2.5
        && info.mean_reprojection_error > 0.0
        && info.mean_reprojection_error <= 3.0
}

fn recommended_coverage(
    source_kind: ColmapSourceKind,
    database_path: &Path,
    image_dir: &Path,
    model_path: &Path,
) -> AppResult<bool> {
    let graph = inspect_match_graph(database_path)?;
    if graph.largest_component_coverage < 0.8 {
        return Ok(false);
    }
    if source_kind == ColmapSourceKind::Images {
        return Ok(true);
    }
    let mut input_names = std::fs::read_dir(image_dir)
        .map_err(mapping_filesystem_error)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "jpg" | "jpeg" | "png"
                    )
                })
                .then(|| entry.file_name().to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    input_names.sort();
    let registered = read_registered_image_names(model_path)?
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let largest_missing = input_names
        .iter()
        .fold((0_usize, 0_usize), |(current, largest), name| {
            if registered.contains(name) {
                (0, largest)
            } else {
                let current = current + 1;
                (current, largest.max(current))
            }
        })
        .1;
    Ok(input_names.is_empty() || largest_missing as f64 / input_names.len() as f64 <= 0.2)
}

fn compare_candidates(left: &Candidate, right: &Candidate) -> Ordering {
    left.hard_trainable
        .cmp(&right.hard_trainable)
        .then_with(|| {
            left.model_info
                .registered_images
                .cmp(&right.model_info.registered_images)
        })
        .then_with(|| {
            left.model_info
                .point_count
                .cmp(&right.model_info.point_count)
        })
        .then_with(|| {
            left.model_info
                .mean_track_length
                .total_cmp(&right.model_info.mean_track_length)
        })
        .then_with(|| {
            let left_error = if left.model_info.mean_reprojection_error > 0.0 {
                left.model_info.mean_reprojection_error
            } else {
                f64::MAX
            };
            let right_error = if right.model_info.mean_reprojection_error > 0.0 {
                right.model_info.mean_reprojection_error
            } else {
                f64::MAX
            };
            right_error.total_cmp(&left_error)
        })
}

fn selection_reason(candidate: &Candidate, stopped_after_recommended_model: bool) -> String {
    if stopped_after_recommended_model {
        "Selected the first candidate that met every recommended quality threshold.".into()
    } else if candidate.hard_trainable {
        "All automatic fallbacks were exhausted; selected the trainable candidate with the best registration, point count, track length, and reprojection error.".into()
    } else {
        "All automatic fallbacks were exhausted; selected the strongest candidate for a final blocked-quality report.".into()
    }
}

fn reset_attempts(attempts_root: &Path) -> AppResult<()> {
    if attempts_root.exists() {
        std::fs::remove_dir_all(attempts_root).map_err(mapping_filesystem_error)?;
    }
    std::fs::create_dir_all(attempts_root).map_err(mapping_filesystem_error)
}

fn publish_selected_model(ctx: &StageContext, selected: &Path) -> AppResult<()> {
    let preparing = ctx.paths.colmap_dir.join("sparse.preparing");
    let previous = ctx.paths.colmap_dir.join("sparse.previous");
    if preparing.exists() {
        std::fs::remove_dir_all(&preparing).map_err(mapping_filesystem_error)?;
    }
    let target_model = preparing.join("0");
    std::fs::create_dir_all(&target_model).map_err(mapping_filesystem_error)?;
    for entry in std::fs::read_dir(selected).map_err(mapping_filesystem_error)? {
        let entry = entry.map_err(mapping_filesystem_error)?;
        if entry
            .file_type()
            .map_err(mapping_filesystem_error)?
            .is_file()
        {
            std::fs::copy(entry.path(), target_model.join(entry.file_name()))
                .map_err(mapping_filesystem_error)?;
        }
    }
    if !colmap_support::has_complete_model(&target_model) {
        let _ = std::fs::remove_dir_all(&preparing);
        return Err(AppError::new(
            "E-3030",
            ErrorCategory::Engine,
            "Selected Sparse Model Incomplete",
            "The selected attempt could not be verified before publication.",
        ));
    }
    if previous.exists() {
        std::fs::remove_dir_all(&previous).map_err(mapping_filesystem_error)?;
    }
    let had_current = ctx.paths.colmap_sparse.exists();
    if had_current {
        std::fs::rename(&ctx.paths.colmap_sparse, &previous).map_err(mapping_filesystem_error)?;
    }
    if let Err(error) = std::fs::rename(&preparing, &ctx.paths.colmap_sparse) {
        if had_current {
            let _ = std::fs::rename(&previous, &ctx.paths.colmap_sparse);
        }
        return Err(mapping_filesystem_error(error));
    }
    if previous.exists() {
        let _ = std::fs::remove_dir_all(previous);
    }
    Ok(())
}

fn mapping_filesystem_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Update COLMAP Attempt Output",
        "A COLMAP candidate model could not be written or published safely.",
    )
    .with_technical(error.to_string())
}

fn cancelled_error() -> AppError {
    AppError::new(
        "E-3004",
        ErrorCategory::Engine,
        "COLMAP Mapping Cancelled",
        "COLMAP reconstruction was cancelled by the user.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(registered: usize, points: usize, track: f64, error: f64) -> ModelInfo {
        ModelInfo {
            cameras: 1,
            images: registered,
            registered_images: registered,
            point_count: points,
            observations: points * 3,
            mean_track_length: track,
            mean_reprojection_error: error,
        }
    }

    #[test]
    fn source_kind_has_expected_attempt_order() {
        let images = attempt_plans(ColmapSourceKind::Images);
        assert_eq!(images.len(), 3);
        assert_eq!(images[0].mapper, MapperKind::Global);
        assert!(matches!(
            images[1].matching,
            Some((
                MatchingStrategy::Exhaustive,
                MatchingOptions {
                    guided_matching: true,
                    ..
                }
            ))
        ));
        let video = attempt_plans(ColmapSourceKind::Video);
        assert_eq!(video.len(), 4);
        assert!(matches!(
            video[1].matching,
            Some((MatchingStrategy::Sequential { overlap: 30 }, _))
        ));
    }

    #[test]
    fn candidate_ranking_prefers_trainable_then_registration_and_quality() {
        let blocked = Candidate {
            attempt_index: 0,
            model_path: PathBuf::new(),
            model_info: model(70, 50, 4.0, 0.5),
            hard_trainable: false,
        };
        let trainable = Candidate {
            attempt_index: 1,
            model_path: PathBuf::new(),
            model_info: model(60, 5000, 3.0, 1.0),
            hard_trainable: true,
        };
        assert_eq!(compare_candidates(&trainable, &blocked), Ordering::Greater);
        assert!(recommended_quality(&trainable.model_info, 73));
    }

    #[test]
    fn test_mapping_no_db() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = StageContext::new(PipelineStageId::ColmapMapping, dir.path(), None);
        assert!(ColmapMappingStage::new().validate_inputs(&ctx).is_err());
    }
}
