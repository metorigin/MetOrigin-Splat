import type { PipelineState, PipelineStageId } from "../types";
import { PIPELINE_STAGE_IDS } from "../types";
import { StageProgress } from "./StageProgress";

interface PipelineProgressProps {
  state: PipelineState;
  latestLogs?: Record<string, string>;
  onRetryStage?: (stageId: PipelineStageId) => void;
}

export function PipelineProgress({
  state,
  latestLogs,
  onRetryStage,
}: PipelineProgressProps) {
  const activeStage = state.current_stage;
  const overallPct = Math.round(state.overall_progress * 100);

  return (
    <div className="pipeline-progress">
      <div className="pipeline-header">
        <div className="pipeline-overall">
          <span className="pipeline-pct">{overallPct}%</span>
          <span className="pipeline-label">总体进度</span>
        </div>
        <div className="pipeline-bar-track">
          <div
            className="pipeline-bar-fill"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>

      <div className="pipeline-stages">
        {PIPELINE_STAGE_IDS.map((stageId) => {
          const stage = state.stages[stageId];
          if (!stage) return null;

          return (
            <StageProgress
              key={stageId}
              stage={stage}
              isActive={activeStage === stageId}
              latestLog={latestLogs?.[stageId]}
              onRetry={() => onRetryStage?.(stageId as PipelineStageId)}
            />
          );
        })}
      </div>
    </div>
  );
}
