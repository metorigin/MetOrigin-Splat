import { ArrowRight, ClockCounterClockwise } from "@phosphor-icons/react";

import { formatRelativeTime, getProjectStatusLabel, getStageLabel } from "../../localization";
import type { PipelineSnapshot, ProjectInfo } from "../../types";

interface BackgroundTaskSummaryProps {
  project: ProjectInfo;
  snapshot: PipelineSnapshot;
  updatedAt: number | null;
  onReturn: () => void;
}

export function BackgroundTaskSummary({
  project,
  snapshot,
  updatedAt,
  onReturn,
}: BackgroundTaskSummaryProps) {
  const progress = Number.isFinite(snapshot.state.overall_progress)
    ? Math.round(snapshot.state.overall_progress * 100)
    : null;
  const stage = snapshot.state.current_stage
    ? getStageLabel(snapshot.state.current_stage)
    : "正在准备";

  return (
    <aside className="background-task-summary" aria-label="后台活动任务">
      <ClockCounterClockwise size={18} weight="fill" aria-hidden="true" />
      <div className="background-task-copy">
        <strong>{project.name}</strong>
        <span>{getProjectStatusLabel(snapshot.status)} · {stage}</span>
      </div>
      <span className="background-task-progress">
        {progress == null ? "进度正在估算" : `${progress}%`}
      </span>
      <span className="background-task-freshness">
        {updatedAt ? `更新于 ${formatRelativeTime(new Date(updatedAt).toISOString())}` : "等待首次更新"}
      </span>
      <button type="button" className="button button-secondary" onClick={onReturn}>
        返回活动项目 <ArrowRight size={15} />
      </button>
    </aside>
  );
}
