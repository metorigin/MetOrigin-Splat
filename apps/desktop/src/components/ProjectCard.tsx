import type { ProjectInfo } from "../types";

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

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
};

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const color = STATUS_COLORS[project.status] || "var(--text-secondary)";
  const label = STATUS_LABELS[project.status] || project.status;
  const timeAgo = getTimeAgo(project.updated_at);

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
        <div className="project-stage">{project.stage_label}</div>
      )}
      <div className="project-meta">
        <span className="project-time">{timeAgo}</span>
        <button className="text-button" onClick={(e) => { e.stopPropagation(); onClick(); }}>
          {project.status === "completed" ? "View Results →" : "Continue →"}
        </button>
      </div>
    </div>
  );
}

function getTimeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(isoString).toLocaleDateString();
}
