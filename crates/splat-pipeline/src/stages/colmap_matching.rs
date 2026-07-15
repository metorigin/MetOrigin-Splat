use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::pipeline::{PipelineStageId, StageState, StageStatus};
use splat_domain::progress::TaskProgress;
use splat_engine_colmap::{
    inspect_database, ColmapFeatureParser, MatchingOptions, MatchingStrategy, MatchingValidator,
};
use splat_process::{CompositeParser, ProcessRunner};
use tokio::sync::broadcast;

use crate::stage::{PipelineStage, StageContext};
use crate::stages::colmap_support;
use crate::stages::colmap_support::ColmapSourceKind;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MatchingMetadata {
    strategy_version: u32,
    source_kind: String,
    strategy: MatchingStrategy,
    options: MatchingOptions,
}

/// Matches ordered video frames with COLMAP's sequential matcher.
pub struct ColmapMatchingStage;

impl Default for ColmapMatchingStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ColmapMatchingStage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PipelineStage for ColmapMatchingStage {
    fn id(&self) -> PipelineStageId {
        PipelineStageId::ColmapMatching
    }

    fn validate_inputs(&self, ctx: &StageContext) -> AppResult<()> {
        if !ctx.paths.colmap_db.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Missing",
                "The COLMAP database was not found. Run feature extraction before matching.",
            ));
        }
        let stats = inspect_database(&ctx.paths.colmap_db)?;
        if stats.images == 0 || stats.keypoints == 0 {
            return Err(AppError::new(
                "E-3010",
                ErrorCategory::Engine,
                "COLMAP Features Missing",
                "The COLMAP database does not contain extracted image features.",
            ));
        }
        Ok(())
    }

    fn check_cached(&self, ctx: &StageContext) -> AppResult<bool> {
        if !ctx.paths.colmap_db.exists() {
            return Ok(false);
        }
        let metadata_path = ctx.paths.colmap_dir.join("matching.json");
        let expected_kind = colmap_support::source_kind(ctx)?;
        let metadata = std::fs::read_to_string(metadata_path)
            .ok()
            .and_then(|json| serde_json::from_str::<MatchingMetadata>(&json).ok());
        Ok(inspect_database(&ctx.paths.colmap_db)
            .map(|stats| stats.matched_pairs > 0 && stats.verified_matches > 0)
            .unwrap_or(false)
            && metadata
                .map(|metadata| {
                    metadata.strategy_version == 2
                        && metadata.source_kind == source_kind_name(expected_kind)
                })
                .unwrap_or(false))
    }

    async fn execute(
        &self,
        ctx: &StageContext,
        progress_tx: broadcast::Sender<TaskProgress>,
    ) -> AppResult<StageState> {
        let adapter = colmap_support::adapter(ctx)?;
        let stats = inspect_database(&ctx.paths.colmap_db)?;
        let source_kind = colmap_support::source_kind(ctx)?;
        let (strategy, options) = initial_matching_strategy(source_kind);
        let command = adapter
            .build_matching_command_with_options(
                &ctx.paths.colmap_db,
                &strategy,
                &options,
                &ctx.log_path,
            )
            .with_cwd(&ctx.paths.colmap_dir)
            .with_timeout(Duration::from_secs(2 * 60 * 60));
        let mut parsers = CompositeParser::new();
        parsers.add(Box::new(ColmapFeatureParser::new(
            "ColmapMatching",
            stats.images as u64,
        )));
        let result = ProcessRunner::with_parser(parsers)
            .run_to_completion(command, ctx.cancellation.clone(), Some(progress_tx))
            .await?;
        colmap_support::ensure_success(&result, "feature matching")?;
        MatchingValidator::validate_matching(&ctx.paths.colmap_db)?;
        colmap_support::write_json_atomic(
            &MatchingMetadata {
                strategy_version: 2,
                source_kind: source_kind_name(source_kind).into(),
                strategy,
                options,
            },
            &ctx.paths.colmap_dir.join("matching.json"),
        )?;

        let mut state = StageState::new(self.id());
        state.status = StageStatus::Completed;
        state.progress = 1.0;
        Ok(state)
    }

    fn validate_outputs(&self, ctx: &StageContext) -> AppResult<()> {
        MatchingValidator::validate_matching(&ctx.paths.colmap_db)?;
        Ok(())
    }
}

fn initial_matching_strategy(kind: ColmapSourceKind) -> (MatchingStrategy, MatchingOptions) {
    match kind {
        ColmapSourceKind::Images => (
            MatchingStrategy::Exhaustive,
            MatchingOptions {
                exhaustive_block_size: 50,
                guided_matching: false,
                quadratic_overlap: false,
            },
        ),
        ColmapSourceKind::Video => (
            MatchingStrategy::Sequential { overlap: 15 },
            MatchingOptions {
                guided_matching: false,
                exhaustive_block_size: 50,
                quadratic_overlap: true,
            },
        ),
    }
}

fn source_kind_name(kind: ColmapSourceKind) -> &'static str {
    match kind {
        ColmapSourceKind::Images => "images",
        ColmapSourceKind::Video => "video",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_matching_no_db() {
        let stage = ColmapMatchingStage::new();
        let ctx = StageContext::new(
            PipelineStageId::ColmapMatching,
            Path::new("/nonexistent"),
            None,
        );
        assert!(stage.validate_inputs(&ctx).is_err());
    }

    #[test]
    fn matching_strategy_depends_on_source_kind() {
        let (images, image_options) = initial_matching_strategy(ColmapSourceKind::Images);
        assert_eq!(images, MatchingStrategy::Exhaustive);
        assert_eq!(image_options.exhaustive_block_size, 50);
        let (video, video_options) = initial_matching_strategy(ColmapSourceKind::Video);
        assert_eq!(video, MatchingStrategy::Sequential { overlap: 15 });
        assert!(video_options.quadratic_overlap);
    }
}
