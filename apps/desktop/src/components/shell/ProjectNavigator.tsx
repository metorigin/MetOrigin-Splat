import {
  ArrowClockwise,
  CheckCircle,
  DotsThreeVertical,
  FolderOpen,
  LinkSimple,
  MagnifyingGlass,
  Question,
  Stack,
  Trash,
  WarningCircle,
  XCircle,
} from "../primitives/icons";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatRelativeTime, getProjectStatusLabel, getStageLabel } from "../../localization";
import type { ProjectInfo, RecentProjectAvailability } from "../../types";

export type RelinkUiResult =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "mismatch"; candidatePath: string; code: string }
  | { kind: "error"; code: string; message: string };

export interface ProjectNavigatorProps {
  projects: ProjectInfo[];
  availability: Record<string, RecentProjectAvailability>;
  loading?: boolean;
  loadError?: string | null;
  activeProjectPath: string | null;
  onSelectProject: (project: ProjectInfo) => void;
  onRevealProject: (project: ProjectInfo) => void;
  onRemoveProject: (project: ProjectInfo) => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRetryAvailability: (projectId: string) => Promise<void> | void;
  onRelinkProject: (project: ProjectInfo) => Promise<RelinkUiResult>;
  onOpenIndependent: (candidatePath: string) => Promise<void> | void;
  onRetryLoad?: () => void;
  onNavigate?: () => void;
}

function compactProjectStatus(project: ProjectInfo): string {
  if (["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status)) return "运行中";
  if (project.status === "completed") return "已完成";
  if (project.status === "failed") return "失败";
  if (project.status === "paused") return "已暂停";
  if (project.status === "cancelled") return "已取消";
  if (project.status === "creating") return "创建中";
  return "就绪";
}

function availabilityCopy(value: RecentProjectAvailability | undefined) {
  switch (value?.status ?? "unknown") {
    case "checking":
      return { label: "正在检查路径", className: "is-checking", icon: <ArrowClockwise className="spin" size={13} /> };
    case "available":
      return { label: "路径可用", className: "is-available", icon: <CheckCircle size={13} weight="fill" /> };
    case "missing":
      return { label: "路径已丢失", className: "is-missing", icon: <WarningCircle size={13} weight="fill" /> };
    case "unreadable":
      return { label: "项目数据无法读取", className: "is-unreadable", icon: <WarningCircle size={13} weight="fill" /> };
    case "check_failed":
      return { label: "暂时无法检查", className: "is-check-failed", icon: <Question size={13} weight="fill" /> };
    default:
      return { label: "等待检查路径", className: "is-unknown", icon: <Question size={13} /> };
  }
}

export function ProjectNavigator({
  projects,
  availability,
  loading = false,
  loadError = null,
  activeProjectPath,
  onSelectProject,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  onRetryAvailability,
  onRelinkProject,
  onOpenIndependent,
  onRetryLoad = () => undefined,
  onNavigate = () => undefined,
}: ProjectNavigatorProps) {
  const [query, setQuery] = useState("");
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [relinkBusyId, setRelinkBusyId] = useState<string | null>(null);
  const [retryBusyIds, setRetryBusyIds] = useState<Set<string>>(() => new Set());
  const [relinkResult, setRelinkResult] = useState<Record<string, RelinkUiResult>>({});
  const retryActivated = useRef(new Set<string>());
  const mismatchHeadings = useRef(new Map<string, HTMLDivElement>());
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuInitialPosition = useRef<"first" | "last">("first");

  useEffect(() => {
    if (!menuProjectId) return;
    const frame = window.requestAnimationFrame(() => {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
      (menuInitialPosition.current === "last" ? items[items.length - 1] : items[0])?.focus();
    });
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(`[data-project-menu="${menuProjectId}"]`)) return;
      setMenuProjectId(null);
    };
    window.addEventListener("mousedown", close);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", close);
    };
  }, [menuProjectId]);

  const closeProjectMenu = (restoreFocus: boolean) => {
    setMenuProjectId(null);
    if (restoreFocus) window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  const openProjectMenu = (
    trigger: HTMLButtonElement,
    projectId: string,
    position: "first" | "last" = "first",
  ) => {
    menuTriggerRef.current = trigger;
    menuInitialPosition.current = position;
    setMenuProjectId(projectId);
  };

  const handleProjectMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next >= 0 && items[next]) {
      event.preventDefault();
      items[next].focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeProjectMenu(true);
    } else if (event.key === "Tab") {
      menuTriggerRef.current?.focus();
      closeProjectMenu(false);
    }
  };

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return projects.slice(0, 50);
    return projects.filter((project) => [
      project.name,
      project.path,
      project.status,
      project.stage_label ?? "",
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized))).slice(0, 50);
  }, [projects, query]);

  const relink = async (project: ProjectInfo) => {
    if (relinkBusyId) return;
    setRelinkBusyId(project.id);
    const result = await onRelinkProject(project);
    setRelinkBusyId(null);
    if (result.kind === "cancelled" || result.kind === "success") {
      setRelinkResult((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }
    setRelinkResult((current) => ({ ...current, [project.id]: result }));
    window.requestAnimationFrame(() => mismatchHeadings.current.get(project.id)?.focus());
  };

  return (
    <div className="project-navigator">
      <label className="sidebar-search">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
          placeholder="按名称或路径搜索…"
          aria-label="按项目名称或路径搜索"
        />
      </label>

      <div className="sidebar-project-list">
        {loadError ? (
          <button type="button" className="sidebar-load-error" title={loadError} onClick={onRetryLoad}>
            <WarningCircle size={15} weight="fill" /> 项目列表加载失败，重试
          </button>
        ) : null}
        {filteredProjects.map((project) => {
          const availabilityState = availability[project.id];
          const availabilityView = availabilityCopy(availabilityState);
          const rowRelink = relinkResult[project.id];
          const active = ["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status);
          return (
            <div
              key={`${project.id}:${project.path}`}
              data-project-menu={project.id}
              className={`sidebar-project-row ${activeProjectPath === project.path ? "is-active" : ""}`}
              aria-busy={availabilityState?.status === "checking" || undefined}
            >
              <div className="project-row-main">
                <button type="button" className="sidebar-project-select" aria-label={project.name} onClick={() => { onSelectProject(project); onNavigate(); }}>
                  <span className={`project-file-icon status-${project.status}`} aria-hidden="true"><Stack size={16} weight="fill" /></span>
                  <span className="project-row-copy">
                    <span className="project-row-title-line">
                      <span className="project-row-title" title={project.name}>{project.name}</span>
                      <span className={`project-row-status status-${project.status}`} title={project.stage_label ? `${getProjectStatusLabel(project.status)} · ${getStageLabel(project.stage_label)}` : getProjectStatusLabel(project.status)}>
                        {compactProjectStatus(project)}
                      </span>
                    </span>
                    <span className="project-row-path" title={project.path}>{project.path}</span>
                    <span className="project-row-meta">{formatRelativeTime(project.updated_at)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-project-menu-button"
                  aria-label={`${project.name} 项目操作`}
                  aria-haspopup="menu"
                  aria-expanded={menuProjectId === project.id}
                  aria-controls={menuProjectId === project.id ? `project-menu-${project.id}` : undefined}
                  onClick={(event) => {
                    if (menuProjectId === project.id) closeProjectMenu(true);
                    else openProjectMenu(event.currentTarget, project.id);
                  }}
                  onKeyDown={(event) => {
                    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
                    event.preventDefault();
                    openProjectMenu(event.currentTarget, project.id, event.key === "ArrowUp" ? "last" : "first");
                  }}
                >
                  <DotsThreeVertical size={17} weight="bold" />
                </button>
              </div>

              <div className={`project-availability ${availabilityView.className}`}>
                {availabilityView.icon}<span>{availabilityView.label}</span>
                {availabilityState?.status === "check_failed" || retryActivated.current.has(project.id) ? (
                  <button
                    type="button"
                    aria-busy={retryBusyIds.has(project.id) || availabilityState?.status === "checking" || undefined}
                    aria-disabled={availabilityState?.status !== "check_failed" || retryBusyIds.has(project.id)}
                    tabIndex={availabilityState?.status === "check_failed" || retryActivated.current.has(project.id) ? 0 : -1}
                    onClick={() => {
                      if (availabilityState?.status !== "check_failed" || retryBusyIds.has(project.id)) return;
                      retryActivated.current.add(project.id);
                      setRetryBusyIds((current) => new Set(current).add(project.id));
                      void Promise.resolve(onRetryAvailability(project.id)).finally(() => {
                        setRetryBusyIds((current) => {
                          const next = new Set(current);
                          next.delete(project.id);
                          return next;
                        });
                      });
                    }}
                  >
                    {availabilityState?.status === "check_failed" ? "重试检查" : availabilityView.label}
                  </button>
                ) : null}
                {availabilityState?.status === "check_failed" ? <small>记录已保留</small> : null}
                {availabilityState?.status === "unreadable" ? <small>请检查项目数据，或选择正确的项目位置。</small> : null}
                {["missing", "unreadable"].includes(availabilityState?.status ?? "") ? (
                  <button type="button" disabled={relinkBusyId === project.id} onClick={() => void relink(project)}>
                    <LinkSimple size={13} />{relinkBusyId === project.id ? "正在验证…" : "重新定位"}
                  </button>
                ) : null}
              </div>

              {rowRelink?.kind === "mismatch" ? (
                <div
                  ref={(node) => { if (node) mismatchHeadings.current.set(project.id, node); }}
                  className="project-relink-error"
                  role="alert"
                  tabIndex={-1}
                >
                  <strong>所选目录属于另一个项目</strong>
                  <span>原记录未更改（{rowRelink.code}）。</span>
                  <div>
                    <button type="button" onClick={() => void relink(project)}>选择其他位置</button>
                    <button type="button" onClick={() => { void onOpenIndependent(rowRelink.candidatePath); onNavigate(); }}>作为独立项目打开</button>
                  </div>
                </div>
              ) : rowRelink?.kind === "error" ? (
                <div className="project-relink-error" role="alert"><strong>无法重新定位</strong><span>{rowRelink.message}（{rowRelink.code}）</span></div>
              ) : null}

              {menuProjectId === project.id ? (
                <div ref={menuRef} id={`project-menu-${project.id}`} className="sidebar-project-menu action-menu-popover" role="menu" data-keyboard-overlay="true" onKeyDown={handleProjectMenuKeyDown}>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenuProjectId(null); onRevealProject(project); }}><FolderOpen size={15} />在资源管理器中显示</button>
                  {["missing", "unreadable"].includes(availabilityState?.status ?? "") ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenuProjectId(null); void relink(project); }}><LinkSimple size={15} />重新定位</button> : null}
                  <button type="button" role="menuitem" tabIndex={-1} disabled={active} title={active ? "请先安全取消重建" : undefined} onClick={() => { setMenuProjectId(null); onRemoveProject(project); }}><XCircle size={15} />从最近项目移除</button>
                  <button type="button" role="menuitem" tabIndex={-1} className="is-danger" disabled={active} title={active ? "请先安全取消重建" : undefined} onClick={() => { setMenuProjectId(null); onDeleteProject(project); }}><Trash size={15} />永久删除项目</button>
                </div>
              ) : null}
            </div>
          );
        })}
        {filteredProjects.length === 0 ? (
          <div className="sidebar-empty">{loading ? "正在加载最近项目…" : loadError ? "无法读取最近项目" : query ? "没有匹配项目" : "还没有最近项目"}</div>
        ) : null}
      </div>
    </div>
  );
}
