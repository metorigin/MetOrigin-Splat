use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    read_colmap_result, ColmapValidator, ValidationOptions, ValidationReport,
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
        Ok(serde_json::from_str::<ValidationReport>(&json)
            .map(|report| report.passed)
            .unwrap_or(false))
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
        let report = ColmapValidator::validate(
            &model_info,
            result.total_images,
            &ValidationOptions::default(),
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
            return Err(AppError::new(
                "E-3034",
                ErrorCategory::Media,
                "COLMAP Reconstruction Quality Too Low",
                format!(
                    "The source material did not produce a training-ready reconstruction: {details}"
                ),
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
        if !report.passed {
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
