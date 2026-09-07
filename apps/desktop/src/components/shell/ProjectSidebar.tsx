import { FolderOpen, GearSix, House, List, Plus, SidebarSimple } from "../primitives/icons";
import { useEffect, useState } from "react";

import type { EngineInfo, ProjectInfo, RecentProjectAvailability, ResourceMetrics } from "../../types";
import { ProjectDrawer } from "./ProjectDrawer";
import { ProjectNavigator } from "./ProjectNavigator";
import type { RelinkUiResult } from "./ProjectNavigator";
import appIconUrl from "../../../src-tauri/icons/app-icon.svg";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  availability?: Record<string, RecentProjectAvailability>;
  loading?: boolean;
  loadError?: string | null;
  activeProjectPath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onHome: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenSettings?: () => void;
  onSelectProject: (project: ProjectInfo) => void;
  onRevealProject: (project: ProjectInfo) => void;
  onRemoveProject: (project: ProjectInfo) => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRetryAvailability?: (projectId: string) => Promise<void> | void;
  onRelinkProject?: (project: ProjectInfo) => Promise<RelinkUiResult>;
  onOpenIndependent?: (candidatePath: string) => Promise<void> | void;
  onRetry?: () => void;
  engines?: EngineInfo[];
  metrics?: ResourceMetrics | null;
}

export function ProjectSidebar({
  projects,
  availability = {},
  loading = false,
  loadError = null,
  activeProjectPath,
  collapsed,
  onToggle,
  onHome,
  onNewProject,
  onOpenProject,
  onOpenSettings = () => undefined,
  onSelectProject,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  onRetryAvailability = () => undefined,
  onRelinkProject = async () => ({ kind: "cancelled" }),
  onOpenIndependent = () => undefined,
  onRetry = () => undefined,
  engines = [],
  metrics = null,
}: ProjectSidebarProps) {
  const [viewportCompact, setViewportCompact] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1120px)");
    const update = () => {
      setViewportCompact(media.matches);
      if (!media.matches) setDrawerOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const effectiveCollapsed = collapsed || viewportCompact;
  const environmentReady = engines.length > 0 && engines.every((engine) => engine.available);
  const gpuLabel = metrics?.gpu
    ? `${metrics.gpu.name.replace("NVIDIA GeForce ", "")} · ${(metrics.gpu.memory_total_bytes / 1024 ** 3).toFixed(0)} GB`
    : "等待硬件检测";
  const navigatorProps = {
    projects,
    availability,
    loading,
    loadError,
    activeProjectPath,
    onSelectProject,
    onRevealProject,
    onRemoveProject,
    onDeleteProject,
    onRetryAvailability,
    onRelinkProject,
    onOpenIndependent,
    onRetryLoad: onRetry,
  };

  return (
    <aside className={`project-sidebar ${effectiveCollapsed ? "is-collapsed" : ""}`}>
      <div className="sidebar-brand-row">
        <button type="button" className="brand-button" onClick={onHome} title="返回项目库">
          <img className="brand-app-icon" src={appIconUrl} alt="" />
          {!effectiveCollapsed ? <span>MetOrigin Splat</span> : null}
        </button>
        <button
          type="button"
          className="icon-button sidebar-toggle-button"
          onClick={() => viewportCompact ? setDrawerOpen(true) : onToggle()}
          aria-label={viewportCompact ? "打开全部项目" : collapsed ? "展开项目栏" : "折叠项目栏"}
          aria-haspopup={viewportCompact ? "dialog" : undefined}
          aria-expanded={viewportCompact ? drawerOpen : undefined}
          title={viewportCompact ? "打开全部项目" : collapsed ? "展开项目栏" : "折叠项目栏"}
        >
          {effectiveCollapsed ? <List size={18} /> : <SidebarSimple size={18} />}
        </button>
      </div>

      <div className="sidebar-main-actions">
        <button type="button" className="button button-primary sidebar-new-button" onClick={onNewProject} title="新建项目 (Ctrl+N)" aria-label="新建项目">
          <Plus size={18} weight="bold" />
          {!effectiveCollapsed ? <span>新建项目</span> : null}
        </button>
        <button type="button" className="button button-secondary sidebar-open-button" onClick={onOpenProject} title="打开项目 (Ctrl+O)" aria-label="打开项目">
          <FolderOpen size={18} />
          {!effectiveCollapsed ? <span>打开项目</span> : null}
        </button>
      </div>

      {!effectiveCollapsed ? (
        <nav className="sidebar-workspace-nav" aria-label="工作区">
          <p className="sidebar-section-label">工作区</p>
          <button type="button" className={!activeProjectPath ? "is-active" : ""} onClick={onHome} aria-current={!activeProjectPath ? "page" : undefined}>
            <House size={17} weight="fill" />
            <span>项目中心</span>
          </button>
        </nav>
      ) : null}

      <div className="sidebar-content sidebar-recent-legacy" aria-label="最近项目快捷访问">
          <p className="sidebar-section-label">最近项目</p>
          <ProjectNavigator {...navigatorProps} />
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-settings-button" onClick={onOpenSettings} aria-label="设置与引擎" title="设置与引擎">
          <GearSix size={17} />
          {!effectiveCollapsed ? <span>设置与引擎</span> : null}
        </button>
        {!effectiveCollapsed ? (
          <div className={`sidebar-engine-card ${environmentReady ? "is-ready" : "is-warning"}`}>
            <span className="status-pill"><i />{environmentReady ? "已连接" : "待检查"}</span>
            <strong>{environmentReady ? "重建引擎已就绪" : "运行环境待检查"}</strong>
            <small>{gpuLabel}</small>
          </div>
        ) : null}
      </div>

      {drawerOpen ? (
        <ProjectDrawer {...navigatorProps} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </aside>
  );
}
