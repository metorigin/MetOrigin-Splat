import type { PipelineState, PipelineStageId, TaskProgress } from "../types";
import { PIPELINE_STAGE_IDS } from "../types";
import { StageProgress } from "./StageProgress";

interface PipelineProgressProps {
  state: PipelineState;
  latestLogs?: Record<string, string>;
  onRetryStage?: (stageId: PipelineStageId) => void;
  latestProgress?: TaskProgress | null;
  updatedAt?: number | null;
}

export function PipelineProgress({
  state,
  latestLogs,
  onRetryStage,
  latestProgress = null,
  updatedAt = null,
}: PipelineProgressProps) {
  const activeStage = state.current_stage;
  const overallPct = Number.isFinite(state.overall_progress)
    && state.overall_progress >= 0
    && state.overall_progress <= 1
    ? Math.round(state.overall_progress * 100)
    : null;
  const workUnit = latestProgress && latestProgress.total_items > 0
    ? `${Math.max(0, latestProgress.current_item).toLocaleString()} / ${latestProgress.total_items.toLocaleString()} 项`
    : "正在统计实际工作量";

  return (
    <div className="pipeline-progress">
      <div
        className="pipeline-header"
        role="progressbar"
        aria-label="总体进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={overallPct ?? undefined}
        aria-valuetext={`${workUnit}，${overallPct == null ? "总体进度正在估算" : `总体进度 ${overallPct}%`}`}
      >
        <div className="pipeline-overall">
          <span className="pipeline-pct">{overallPct == null ? "正在估算" : `${overallPct}%`}</span>
          <span className="pipeline-label">总体进度</span>
          <span className="pipeline-label">{workUnit}</span>
          <span className="pipeline-label">{updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待活动"}</span>
        </div>
        <div className="pipeline-bar-track">
          <div
            className="pipeline-bar-fill"
            style={{ width: `${overallPct ?? 0}%` }}
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
