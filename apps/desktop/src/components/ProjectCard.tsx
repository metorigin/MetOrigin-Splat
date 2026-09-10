import { t } from "../i18n";
import type { ProjectInfo } from "../types";
import { formatRelativeTime, getProjectStatusLabel, getStageLabel } from "../localization";

interface ProjectCardProps {
  project: ProjectInfo;
  onClick: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  ready: "var(--primary)",
  running: "var(--accent)",
  completed: "#4caf50",
  failed: "#f44336",
  paused: "#ff9800",
};

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const color = STATUS_COLORS[project.status] || "var(--text-secondary)";
  const label = getProjectStatusLabel(project.status);
  const timeAgo = formatRelativeTime(project.updated_at);

  return (
    <div className="project-card" onClick={onClick}>
      <div className="project-card-header">
        <span className="project-name">{project.name}</span>
        <span
          className="project-status-badge"
          style={{ backgroundColor: color }}
        >
          {label}
        </span>
      </div>
      {project.stage_label && (
        <div className="project-stage">{getStageLabel(project.stage_label)}</div>
      )}
      <div className="project-meta">
        <span className="project-time">{timeAgo}</span>
        <button className="text-button" onClick={(e) => { e.stopPropagation(); onClick(); }}>
          {project.status === "completed" ? t("查看结果 →") : t("继续 →")}
        </button>
      </div>
    </div>
  );
}
