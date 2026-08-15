import { FolderOpen, List, Plus, SidebarSimple, Stack } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { ProjectInfo, RecentProjectAvailability } from "../../types";
import { ProjectDrawer } from "./ProjectDrawer";
import { ProjectNavigator } from "./ProjectNavigator";
import type { RelinkUiResult } from "./ProjectNavigator";

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
  onSelectProject: (project: ProjectInfo) => void;
  onRevealProject: (project: ProjectInfo) => void;
  onRemoveProject: (project: ProjectInfo) => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRetryAvailability?: (projectId: string) => Promise<void> | void;
  onRelinkProject?: (project: ProjectInfo) => Promise<RelinkUiResult>;
  onOpenIndependent?: (candidatePath: string) => Promise<void> | void;
  onRetry?: () => void;
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
  onSelectProject,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  onRetryAvailability = () => undefined,
  onRelinkProject = async () => ({ kind: "cancelled" }),
  onOpenIndependent = () => undefined,
  onRetry = () => undefined,
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
          <span className="brand-mark" aria-hidden="true"><Stack size={19} weight="fill" /></span>
          {!effectiveCollapsed ? <span>MetOrigin Splat</span> : null}
        </button>
        <button
          type="button"
          className="icon-button"
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
        <button type="button" className="button button-primary sidebar-new-button" onClick={onNewProject} title="新建项目 (Ctrl+N)">
          <Plus size={18} weight="bold" />
          {!effectiveCollapsed ? <span>新建项目</span> : null}
        </button>
      </div>

      {!effectiveCollapsed ? (
        <div className="sidebar-content">
          <p className="sidebar-section-label">最近项目</p>
          <ProjectNavigator {...navigatorProps} />
        </div>
      ) : null}

      <div className="sidebar-footer">
        <button type="button" className="button button-secondary sidebar-open-button" onClick={onOpenProject} title="打开项目 (Ctrl+O)">
          <FolderOpen size={18} />
          {!effectiveCollapsed ? <span>打开项目…</span> : null}
        </button>
      </div>

      {viewportCompact && drawerOpen ? (
        <ProjectDrawer {...navigatorProps} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </aside>
  );
}
