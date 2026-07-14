import {
  CaretDown,
  CaretUp,
  FolderOpen,
  List,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  Stack,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import {
  formatRelativeTime,
  getProjectStatusLabel,
  getStageLabel,
} from "../../localization";
import type { ProjectInfo } from "../../types";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeProjectPath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onHome: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSelectProject: (project: ProjectInfo) => void;
}

export function ProjectSidebar({
  projects,
  activeProjectPath,
  collapsed,
  onToggle,
  onHome,
  onNewProject,
  onOpenProject,
  onSelectProject,
}: ProjectSidebarProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const matches = normalizedQuery
      ? projects.filter((project) =>
          [project.name, project.status, project.stage_label ?? ""].some(
            (value) =>
              value.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
          ),
        )
      : projects;
    return expanded ? matches.slice(0, 20) : matches.slice(0, 5);
  }, [expanded, projects, query]);

  return (
    <aside className={`project-sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="sidebar-brand-row">
        <button
          type="button"
          className="brand-button"
          onClick={onHome}
          title="返回项目库"
        >
          <span className="brand-mark" aria-hidden="true">
            <Stack size={19} weight="fill" />
          </span>
          {!collapsed && <span>MetaOrigin Splat</span>}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label={collapsed ? "展开项目栏" : "折叠项目栏"}
          title={collapsed ? "展开项目栏" : "折叠项目栏"}
        >
          {collapsed ? <List size={18} /> : <SidebarSimple size={18} />}
        </button>
      </div>

      <div className="sidebar-main-actions">
        <button
          type="button"
          className="button button-primary sidebar-new-button"
          onClick={onNewProject}
          title="新建项目 (Ctrl+N)"
        >
          <Plus size={18} weight="bold" />
          {!collapsed && <span>新建项目</span>}
        </button>
      </div>

      {!collapsed && (
        <div className="sidebar-content">
          <p className="sidebar-section-label">最近项目</p>
          <label className="sidebar-search">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="搜索项目…"
              aria-label="搜索项目"
            />
          </label>

          <div className="sidebar-project-list">
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`sidebar-project-row ${
                  activeProjectPath === project.path ? "is-active" : ""
                }`}
                onClick={() => onSelectProject(project)}
              >
                <span
                  className={`project-file-icon status-${project.status.toLowerCase()}`}
                  aria-hidden="true"
                >
                  <Stack size={16} weight="fill" />
                </span>
                <span className="project-row-copy">
                  <span className="project-row-title">{project.name}</span>
                  <span className="project-row-meta">
                    {formatRelativeTime(project.updated_at)}
                  </span>
                </span>
                <span className={`project-row-status status-${project.status.toLowerCase()}`}>
                  {project.stage_label
                    ? getStageLabel(project.stage_label)
                    : getProjectStatusLabel(project.status)}
                </span>
              </button>
            ))}

            {filteredProjects.length === 0 && (
              <div className="sidebar-empty">
                {query ? "没有匹配项目" : "还没有最近项目"}
              </div>
            )}
          </div>

          {projects.length > 5 && (
            <button
              type="button"
              className="sidebar-more-button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
              {expanded ? "收起项目" : `显示更多项目 (${projects.length})`}
            </button>
          )}
        </div>
      )}

      <div className="sidebar-footer">
        <button
          type="button"
          className="button button-secondary sidebar-open-button"
          onClick={onOpenProject}
          title="打开项目 (Ctrl+O)"
        >
          <FolderOpen size={18} />
          {!collapsed && <span>打开项目…</span>}
        </button>
      </div>
    </aside>
  );
}
