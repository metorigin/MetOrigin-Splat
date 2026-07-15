import {
  CaretDown,
  CaretUp,
  DotsThreeVertical,
  FolderOpen,
  List,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  Stack,
  Trash,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import {
  formatRelativeTime,
  getProjectStatusLabel,
  getStageLabel,
} from "../../localization";
import type { ProjectInfo } from "../../types";

function compactProjectStatus(project: ProjectInfo): string {
  if (["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status)) return "运行中";
  if (project.status === "completed") return "已完成";
  if (project.status === "failed") return "失败";
  if (project.status === "paused") return "已暂停";
  if (project.status === "cancelled") return "已取消";
  if (project.status === "creating") return "创建中";
  return "就绪";
}

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  loading?: boolean;
  loadError?: string | null;
  activeProjectPath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onHome: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSelectProject: (project: ProjectInfo) => void;
  onRevealProject: (project: ProjectInfo) => void;
  onRemoveProject: (project: ProjectInfo) => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRetry?: () => void;
}

export function ProjectSidebar({
  projects,
  loading = false,
  loadError = null,
  activeProjectPath,
  collapsed,
  onToggle,
  onHome,
  onNewProject,
  onOpenProject,
  onSelectProject,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  onRetry = () => undefined,
}: ProjectSidebarProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [viewportCompact, setViewportCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 1120px)");
    const update = () => setViewportCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const effectiveCollapsed = collapsed || viewportCompact;
  useEffect(() => {
    if (!menuProjectId) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent) {
        const target = event.target as HTMLElement;
        if (target.closest(`[data-project-menu="${menuProjectId}"]`)) return;
      }
      setMenuProjectId(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuProjectId]);

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
    <aside className={`project-sidebar ${effectiveCollapsed ? "is-collapsed" : ""}`}>
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
          {!effectiveCollapsed && <span>MetOrigin Splat</span>}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          aria-label={viewportCompact ? "窄窗口下项目栏已折叠" : collapsed ? "展开项目栏" : "折叠项目栏"}
          title={viewportCompact ? "放大窗口后可展开项目栏" : collapsed ? "展开项目栏" : "折叠项目栏"}
          disabled={viewportCompact}
        >
          {effectiveCollapsed ? <List size={18} /> : <SidebarSimple size={18} />}
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
          {!effectiveCollapsed && <span>新建项目</span>}
        </button>
      </div>

      {!effectiveCollapsed && (
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
            {loadError && (
              <button type="button" className="sidebar-load-error" title={loadError} onClick={onRetry}>
                <WarningCircle size={15} weight="fill" /> 项目列表加载失败，重试
              </button>
            )}
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                data-project-menu={project.id}
                className={`sidebar-project-row ${
                  activeProjectPath === project.path ? "is-active" : ""
                }`}
              >
                <button type="button" className="sidebar-project-select" onClick={() => onSelectProject(project)}>
                  <span
                    className={`project-file-icon status-${project.status.toLowerCase()}`}
                    aria-hidden="true"
                  >
                    <Stack size={16} weight="fill" />
                  </span>
                  <span className="project-row-copy">
                    <span className="project-row-title-line">
                      <span className="project-row-title" title={project.name}>{project.name}</span>
                      <span
                        className={`project-row-status status-${project.status.toLowerCase()}`}
                        title={project.stage_label ? `${getProjectStatusLabel(project.status)} · ${getStageLabel(project.stage_label)}` : getProjectStatusLabel(project.status)}
                      >
                        {compactProjectStatus(project)}
                      </span>
                    </span>
                    <span className="project-row-meta">
                      {formatRelativeTime(project.updated_at)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-project-menu-button"
                  aria-label={`${project.name} 项目操作`}
                  aria-expanded={menuProjectId === project.id}
                  onClick={() => setMenuProjectId((current) => current === project.id ? null : project.id)}
                >
                  <DotsThreeVertical size={17} weight="bold" />
                </button>
                {menuProjectId === project.id && (
                  <div className="sidebar-project-menu action-menu-popover" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMenuProjectId(null); onRevealProject(project); }}><FolderOpen size={15} />在资源管理器中显示</button>
                    <button type="button" role="menuitem" disabled={["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status)} title={["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status) ? "请先安全取消重建" : undefined} onClick={() => { setMenuProjectId(null); onRemoveProject(project); }}><XCircle size={15} />从最近项目移除</button>
                    <button type="button" role="menuitem" className="is-danger" disabled={["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status)} title={["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status) ? "请先安全取消重建" : undefined} onClick={() => { setMenuProjectId(null); onDeleteProject(project); }}><Trash size={15} />永久删除项目</button>
                  </div>
                )}
              </div>
            ))}

            {filteredProjects.length === 0 && (
              <div className="sidebar-empty">
                {loading ? "正在加载最近项目…" : loadError ? "无法读取最近项目" : query ? "没有匹配项目" : "还没有最近项目"}
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
          {!effectiveCollapsed && <span>打开项目…</span>}
        </button>
      </div>
    </aside>
  );
}
