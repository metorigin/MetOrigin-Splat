import type { StageState } from "../types";
import { CheckCircle, Circle, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import {
  formatCommandError,
  getStageLabel,
  STAGE_STATUS_LABELS,
} from "../localization";

interface StageProgressProps {
  stage: StageState;
  isActive: boolean;
  latestLog?: string;
  onRetry?: () => void;
}

export function StageProgress({
  stage,
  isActive,
  latestLog,
  onRetry,
}: StageProgressProps) {
  const label = getStageLabel(stage.stage_id);
  const icon = stage.status === "completed" || stage.status === "skipped"
    ? <CheckCircle size={16} weight="fill" />
    : stage.status === "failed"
      ? <WarningCircle size={16} weight="fill" />
      : stage.status === "cancelled"
        ? <XCircle size={16} weight="fill" />
        : stage.status === "running" || stage.status === "preparing"
          ? <SpinnerGap size={16} className="spin" />
          : <Circle size={16} />;
  const statusClass = stage.status;
  const progressPct = Math.round(stage.progress * 100);

  return (
    <div className={`stage-progress ${statusClass} ${isActive ? "active" : ""}`}>
      <div className="stage-row">
        <span className="stage-icon">{icon}</span>
        <span className="stage-label" title={STAGE_STATUS_LABELS[stage.status]}>
          {label}
        </span>
        {stage.status === "running" && (
          <span className="stage-percent">{progressPct}%</span>
        )}
        {stage.status === "failed" && (
          <button className="retry-button" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
      {stage.status === "running" && (
        <div className="stage-bar-track">
          <div
            className="stage-bar-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      {stage.status === "failed" && stage.error && (
        <div className="stage-error">
          {formatCommandError(stage.error, "start_pipeline")}
        </div>
      )}
      {isActive && latestLog && (
        <div className="stage-log">{latestLog}</div>
      )}
    </div>
  );
}
