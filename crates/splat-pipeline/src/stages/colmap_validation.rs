use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    inspect_match_graph, read_colmap_result, read_registered_image_names, ColmapValidator,
    QualityDecision, ValidationContext, ValidationOptions, ValidationReport,
};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;

/// Runs model_analyzer on the selected model from `colmap/result.json` and
/// persists a structured quality report.
pub struct ColmapValidationStage;

impl Default for ColmapValidationStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapValidationStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapValidationStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapValidation
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        if !colmap_support::has_complete_model(&model_path) {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "Incomplete COLMAP Model",
                "The selected COLMAP sparse model is missing required files.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_validation.exists() {
            return Ok(false);
        }
        let json = match std::fs::read_to_string(&ctx.paths.colmap_validation) {
            Ok(json) => json,
            Err(_) => return Ok(false),
        };
        let report = match serde_json::from_str::<ValidationReport>(&json) {
            Ok(report) => report,
            Err(_) => return Ok(false),
        };
        let result = match read_colmap_result(&ctx.paths.colmap_result) {
            Ok(result) => result,
            Err(_) => return Ok(false),
        };
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        let current_hash = match crate::colmap_quality::model_sha256(&model_path) {
            Ok(hash) => hash,
            Err(_) => return Ok(false),
        };
        Ok(report.passed && report.model_hash.as_deref() == Some(current_hash.as_str()))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let adapter = colmap_support::adapter(ctx)?;
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        let _ = progress_tx.send(
            TaskProgress::new("ColmapValidation", "Analyzing selected COLMAP model")
                .with_percent(0.25),
        );
        let model_info = adapter.mapper().analyze_model(&model_path)?;
        let graph = inspect_match_graph(&ctx.paths.colmap_db)?;
        let registered_names = read_registered_image_names(&model_path)?;
        let image_dir = colmap_support::image_dir(ctx)?;
        let ordered_input_names = image_names(&image_dir)?;
        let registered_set = registered_names
            .iter()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        let input_set = ordered_input_names
            .iter()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        let missing_model_images = registered_set
            .difference(&input_set)
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        let model_hash = crate::colmap_quality::model_sha256(&model_path)?;
        let accepted = crate::colmap_quality::acceptance_matches(&ctx.project_dir, &model_hash);
        let source_kind = colmap_support::source_kind(ctx)?;
        let report = ColmapValidator::validate_detailed(
            &model_info,
            result.total_images,
            &ValidationOptions::default(),
            &ValidationContext {
                model_complete: colmap_support::has_complete_model(&model_path),
                missing_model_images,
                graph,
                ordered_input_names,
                registered_names,
                is_video: matches!(source_kind, colmap_support::ColmapSourceKind::Video),
                automatic_fallbacks_exhausted: result.automatic_fallbacks_exhausted,
                accepted_for_current_model: accepted,
                model_hash: Some(model_hash),
            },
        );
        colmap_support::write_json_atomic(&report, &ctx.paths.colmap_validation)?;
        let _ = progress_tx.send(
            TaskProgress::new("ColmapValidation", "COLMAP diagnostics saved").with_percent(1.0),
        );

        if !report.passed {
            let details = report
                .failed_checks()
                .iter()
                .map(|check| check.detail.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let requires_confirmation = report.decision == QualityDecision::RequiresConfirmation;
            return Err(AppError::new(
                "E-3034",
                ErrorCategory::Media,
                if requires_confirmation {
                    "COLMAP Quality Confirmation Required"
                } else {
                    "COLMAP Reconstruction Blocked"
                },
                if requires_confirmation {
                    format!(
                        "The best fallback model is trainable but below recommended quality: {details}. Explicit confirmation is required before Brush training."
                    )
                } else {
                    format!(
                        "Every automatic COLMAP strategy failed a hard training requirement: {details}"
                    )
                },
            )
            .with_suggestions(vec![
                "Capture the scene with more overlap and slower camera motion",
                "Avoid motion blur, reflective surfaces, and textureless regions",
                "Use a stable subset of sharp frames to distinguish data quality from pipeline failure",
            ]));
        }

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        let json = std::fs::read_to_string(&ctx.paths.colmap_validation).map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "COLMAP Validation Report Missing",
                "The structured COLMAP validation report was not created.",
            )
            .with_technical(error.to_string())
        })?;
        let report: ValidationReport = serde_json::from_str(&json).map_err(|error| {
            AppError::new(
                "E-3034",
                ErrorCategory::Engine,
                "Invalid COLMAP Validation Report",
                "The COLMAP validation report is malformed.",
            )
            .with_technical(error.to_string())
        })?;
        let result = read_colmap_result(&ctx.paths.colmap_result)?;
        let model_path = colmap_support::model_path(&ctx.project_dir, &result.model_path);
        let hash_matches = crate::colmap_quality::model_sha256(&model_path)
            .map(|hash| report.model_hash.as_deref() == Some(hash.as_str()))
            .unwrap_or(false);
        if !report.passed || !hash_matches {
            return Err(AppError::new(
                "E-3034",
                ErrorCategory::Media,
                "COLMAP Validation Failed",
                "The reconstruction did not pass the configured quality thresholds.",
            ));
        }
        Ok(())
    }
}

fn image_names(directory: &std::path::Path) -> AppResult<Vec<String>> {
    let mut names = std::fs::read_dir(directory)
        .map_err(|error| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Inspect COLMAP Images",
                "Could not enumerate reconstruction input images.",
            )
            .with_technical(error.to_string())
        })?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let path = entry.path();
            let supported = path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "jpg" | "jpeg" | "png"
                    )
                })
                .unwrap_or(false);
            supported.then(|| entry.file_name().to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_colmap_validation_requires_result() {
        let stage = ColmapValidationStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapValidation,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn test_colmap_validation_cache_missing() {
        let dir = tempfile::tempdir().unwrap();
        let stage = ColmapValidationStage::new();
        let ctx = StageContext::new(PipelineStageId::ColmapValidation, dir.path(), None);
        assert!(!stage.check_cached(&ctx).unwrap());
    }
}
