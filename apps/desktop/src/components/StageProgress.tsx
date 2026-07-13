import type { StageState } from "../types";
import { STAGE_LABELS, STAGE_ICONS } from "../types";

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
  const label = STAGE_LABELS[stage.stage_id] || stage.stage_id;
  const icon = STAGE_ICONS[stage.status] || "○";
  const statusClass = stage.status;
  const progressPct = Math.round(stage.progress * 100);

  return (
    <div className={`stage-progress ${statusClass} ${isActive ? "active" : ""}`}>
      <div className="stage-row">
        <span className="stage-icon">{icon}</span>
        <span className="stage-label">{label}</span>
        {stage.status === "running" && (
          <span className="stage-percent">{progressPct}%</span>
        )}
        {stage.status === "failed" && (
          <button className="retry-button" onClick={onRetry}>
            Retry
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
        <div className="stage-error">{stage.error}</div>
      )}
      {isActive && latestLog && (
        <div className="stage-log">{latestLog}</div>
      )}
    </div>
  );
}
