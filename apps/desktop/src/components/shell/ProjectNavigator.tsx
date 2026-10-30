import { localizeMessage, t, getLocale } from "../../i18n";
import {
  ArrowClockwise,
  CheckCircle,
  DotsThreeVertical,
  FolderOpen,
  ImageSquare,
  LinkSimple,
  MagnifyingGlass,
  PauseCircle,
  SpinnerGap,
  Question,
  Stack,
  Trash,
  WarningCircle,
} from "../primitives/icons";
import { useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Notification } from "@/components/feedback";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { DesktopMenu } from "./DesktopMenu";
import { DesktopContextMenu, DesktopContextMenuItem, DesktopContextMenuSeparator } from "./DesktopContextMenu";

import { formatRelativeTime, getProjectStatusLabel, getStageLabel } from "../../localization";
import type { ProjectInfo, RecentProjectAvailability } from "../../types";

export type RelinkUiResult =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "mismatch"; candidatePath: string; code: string }
  | { kind: "error"; code: string; message: string };

type ProjectMenuAction = { key: string; separator: true } | {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  destructive?: boolean;
};

function projectMenuContent(actions: ProjectMenuAction[], context = false) {
  const Item = context ? DesktopContextMenuItem : DropdownMenuItem;
  const Separator = context ? DesktopContextMenuSeparator : DropdownMenuSeparator;
  return actions.map((action) => "separator" in action ? <Separator key={action.key} /> : <Item key={action.key} disabled={action.disabled} title={action.title} className={action.destructive ? "text-destructive focus:text-destructive" : undefined} onSelect={action.onSelect}>{action.icon}{action.label}</Item>);
}

export interface ProjectNavigatorProps {
  projects: ProjectInfo[];
  availability: Record<string, RecentProjectAvailability>;
  loading?: boolean;
  loadError?: string | null;
  activeProjectPath: string | null;
  onSelectProject: (project: ProjectInfo) => void;
  onRevealProject: (project: ProjectInfo) => void;
  onDeleteProject: (project: ProjectInfo) => void;
  onRetryAvailability: (projectId: string) => Promise<void> | void;
  onRelinkProject: (project: ProjectInfo) => Promise<RelinkUiResult>;
  onOpenIndependent: (candidatePath: string) => Promise<void> | void;
  onRetryLoad?: () => void;
  onNavigate?: () => void;
  compact?: boolean;
  catalog?: boolean;
  gallery?: boolean;
  renderThumbnail?: (project: ProjectInfo) => ReactNode;
  showSearch?: boolean;
  maxItems?: number;
  showHealthyAvailability?: boolean;
}

function compactProjectStatus(project: ProjectInfo): string {
  if (["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status)) return t("运行中");
  if (project.status === "completed") return t("已完成");
  if (project.status === "failed") return t("失败");
  if (project.status === "paused") return t("已暂停");
  if (project.status === "cancelled") return t("已取消");
  if (project.status === "creating") return t("创建中");
  return t("就绪");
}

function projectLocation(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  return `…${separator}${parts.slice(-2).join(separator)}`;
}

function availabilityCopy(value: RecentProjectAvailability | undefined) {
  switch (value?.status ?? "unknown") {
    case "checking":
      return { label: t("正在检查路径"), className: "text-muted-foreground", icon: <ArrowClockwise className="spin" size={13} /> };
    case "available":
      return { label: t("路径可用"), className: "text-muted-foreground", icon: <CheckCircle size={13} /> };
    case "missing":
      return { label: t("路径已丢失"), className: "text-warning", icon: <WarningCircle size={13} /> };
    case "unreadable":
      return { label: t("项目数据无法读取"), className: "text-destructive", icon: <WarningCircle size={13} /> };
    case "check_failed":
      return { label: t("暂时无法检查"), className: "text-warning", icon: <Question size={13} /> };
    default:
      return { label: t("等待检查路径"), className: "text-muted-foreground", icon: <Question size={13} /> };
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
  onDeleteProject,
  onRetryAvailability,
  onRelinkProject,
  onOpenIndependent,
  onRetryLoad = () => undefined,
  onNavigate = () => undefined,
  compact = false,
  catalog = false,
  gallery = false,
  renderThumbnail,
  showSearch = true,
  maxItems = 50,
  showHealthyAvailability = true,
}: ProjectNavigatorProps) {
  const summaryPrefix = useId();
  const galleryView = gallery && !compact;
  const catalogRow = catalog && !compact && !galleryView;
  const [query, setQuery] = useState("");
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [contextProjectId, setContextProjectId] = useState<string | null>(null);
  const [relinkBusyId, setRelinkBusyId] = useState<string | null>(null);
  const [retryBusyIds, setRetryBusyIds] = useState<Set<string>>(() => new Set());
  const [relinkResult, setRelinkResult] = useState<Record<string, RelinkUiResult>>({});
  const retryActivated = useRef(new Set<string>());
  const mismatchHeadings = useRef(new Map<string, HTMLDivElement>());
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(getLocale());
    if (!normalized) return projects.slice(0, maxItems);
    return projects.filter((project) => [
      project.name,
      project.path,
      project.status,
      project.stage_label ?? "",
    ].some((value) => value.toLocaleLowerCase(getLocale()).includes(normalized))).slice(0, maxItems);
  }, [projects, query, maxItems]);

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

  const retryAvailability = (projectId: string) => {
    if (availability[projectId]?.status !== "check_failed" || retryBusyIds.has(projectId)) return;
    retryActivated.current.add(projectId);
    setRetryBusyIds((current) => new Set(current).add(projectId));
    void Promise.resolve(onRetryAvailability(projectId)).finally(() => {
      setRetryBusyIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {showSearch ? <label className="relative block shrink-0 [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-1/2 [&>svg]:-translate-y-1/2 [&>svg]:text-muted-foreground">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <Input className="h-9 pl-9 text-xs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
          placeholder={t("按名称或路径搜索…")}
          aria-label={t("按项目名称或路径搜索")}
        />
      </label> : null}

      <div role={galleryView ? "list" : undefined} className={`min-h-0 overflow-y-auto ${galleryView ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] items-start gap-4" : compact ? "space-y-0.5" : "space-y-1"}`}>
        {loadError ? (
          <Button type="button" variant="ghost" className={`h-auto w-full justify-start whitespace-normal text-left text-xs text-destructive ${galleryView ? "col-span-full" : ""}`} title={loadError} onClick={onRetryLoad}>
            <WarningCircle size={15} /> {t("项目列表加载失败，重试")}</Button>
        ) : null}
        {filteredProjects.map((project) => {
          const availabilityState = availability[project.id];
          const availabilityView = availabilityCopy(availabilityState);
          const rowRelink = relinkResult[project.id];
          const active = ["starting", "running", "pausing", "cancelling", "recovering"].includes(project.status);
          // A cached running status cannot prove that an unavailable project
          // still owns a task. The backend checks actual owners before deletion.
          const deletionBlocked = active && !["missing", "unreadable"].includes(availabilityState?.status ?? "");
          const statusTitle = project.stage_label ? `${getProjectStatusLabel(project.status)} · ${getStageLabel(project.stage_label)}` : getProjectStatusLabel(project.status);
          const summaryId = `${summaryPrefix}-project-summary-${project.id}`;
          const availabilityProblem = ["missing", "unreadable", "check_failed"].includes(availabilityState?.status ?? "");
          const showAvailability = !compact && !galleryView && (showHealthyAvailability || availabilityProblem || retryActivated.current.has(project.id));
          const statusIcon = active || project.status === "creating"
            ? <SpinnerGap size={15} className="motion-safe:animate-spin" />
            : project.status === "failed"
              ? <WarningCircle size={15} className="text-destructive" />
              : project.status === "paused"
                ? <PauseCircle size={15} className="text-warning" />
                : <Stack size={15} />;
          const actions: ProjectMenuAction[] = [
            { key: "reveal", label: t("在资源管理器中显示"), icon: <FolderOpen size={15} />, onSelect: () => onRevealProject(project) },
            ...((compact || galleryView) && availabilityState?.status === "check_failed" ? [{ key: "retry", label: t("重试检查"), icon: <ArrowClockwise size={15} />, disabled: retryBusyIds.has(project.id), onSelect: () => retryAvailability(project.id) }] : []),
            ...(["missing", "unreadable"].includes(availabilityState?.status ?? "") ? [{ key: "relink", label: t("重新定位"), icon: <LinkSimple size={15} />, onSelect: () => void relink(project) }] : []),
            { key: "separator", separator: true },
            { key: "delete", label: t("永久删除项目"), icon: <Trash size={15} />, disabled: deletionBlocked, title: deletionBlocked ? t("请先安全取消重建") : undefined, destructive: true, onSelect: () => onDeleteProject(project) },
          ];
          const projectMenu = <DesktopMenu open={menuProjectId === project.id} onOpenChange={(open) => { setMenuProjectId(open ? project.id : null); if (open) setContextProjectId(null); }} trigger={<Button ref={(node) => { if (node) menuTriggers.current.set(project.id, node); else menuTriggers.current.delete(project.id); }} variant="ghost" size="icon-sm" className={galleryView ? "absolute top-2 right-2 size-7 rounded-md bg-background/90 text-foreground opacity-0 shadow-sm group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[state=open]:opacity-100 hover:bg-background dark:hover:bg-background" : compact ? "size-6 shrink-0 text-muted-foreground opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[state=open]:opacity-100" : undefined} aria-label={t("{0} 项目操作", project.name)}><DotsThreeVertical size={17} /></Button>}>
            {projectMenuContent(actions)}
          </DesktopMenu>;
          const projectCard = (
            <div
              key={`${project.id}:${project.path}`}
              data-project-menu={project.id}
              role={galleryView ? "listitem" : undefined}
              className={`group/project rounded-md ${galleryView ? "w-full max-w-[220px] p-1.5" : compact ? "px-1" : catalogRow ? "px-2 py-1" : "p-2"} ${activeProjectPath === project.path ? "bg-accent" : "hover:bg-accent/70"}`}
              aria-busy={availabilityState?.status === "checking" || undefined}
            >
              {galleryView ? <div className="relative">
                <Button type="button" variant="ghost" className="h-auto w-full min-w-0 flex-col items-stretch gap-0 rounded-sm p-0 text-left whitespace-normal hover:bg-transparent dark:hover:bg-transparent" aria-label={project.name} aria-describedby={summaryId} title={`${project.name}\n${statusTitle}\n${project.path}\n${availabilityView.label}\n${formatRelativeTime(project.updated_at)}`} onClick={() => { onSelectProject(project); onNavigate(); }}>
                  <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-sm border border-border/70 bg-muted/45 [&>img]:size-full [&>img]:object-cover">
                    {renderThumbnail?.(project) ?? <ImageSquare size={30} aria-hidden="true" className="size-[30px] text-muted-foreground" />}
                  </span>
                  <span className="mt-2 block min-w-0 truncate text-center text-[13px] font-medium" title={project.name}>{project.name}</span>
                  <span id={summaryId} className="sr-only">{statusTitle} · {project.path} · {availabilityView.label} · {formatRelativeTime(project.updated_at)}</span>
                </Button>
                {projectMenu}
              </div> : <div className={`flex gap-1 ${compact ? "h-8 items-center" : catalogRow ? "items-center" : "items-start"}`}>
                <Button type="button" variant="ghost" className={`min-w-0 flex-1 justify-start gap-2 text-left hover:bg-transparent ${compact ? "h-8 px-1 py-0" : catalogRow ? "h-12 items-center p-1" : "h-auto items-start p-1"}`} aria-label={project.name} aria-describedby={compact || catalogRow ? summaryId : undefined} title={compact ? `${project.name}\n${statusTitle}\n${project.path}\n${availabilityView.label}` : undefined} onClick={() => { onSelectProject(project); onNavigate(); }}>
                  <span className={`shrink-0 text-muted-foreground ${compact || catalogRow ? "" : "mt-0.5"}`} role={compact ? "img" : undefined} aria-hidden={compact ? undefined : true} aria-label={compact ? availabilityProblem ? availabilityView.label : compactProjectStatus(project) : undefined} title={compact && availabilityProblem ? `${statusTitle} · ${availabilityView.label}` : statusTitle}>{compact ? availabilityProblem ? availabilityView.icon : statusIcon : <Stack size={16} />}</span>
                  <span className={`min-w-0 flex-1 ${compact ? "truncate" : catalogRow ? "grid gap-0.5" : "grid gap-1"}`}>
                    <span className={`min-w-0 ${compact ? "block truncate" : catalogRow ? "flex items-center gap-1" : "flex flex-wrap items-center gap-1"}`}>
                      <span className={`min-w-0 truncate ${compact ? "text-[13px] font-normal" : "text-sm font-medium"}`} title={project.name}>{project.name}</span>
                      {!compact ? <Badge variant={project.status === "failed" ? "destructive" : project.status === "completed" ? "success" : project.status === "paused" ? "warning" : "secondary"} className={`px-1.5 py-0 text-xs font-normal ${catalogRow ? "shrink-0" : ""}`} title={statusTitle}>
                        {compactProjectStatus(project)}
                      </Badge> : null}
                    </span>
                    {!compact ? <>
                      <span className="truncate text-xs font-normal text-muted-foreground" title={project.path}>{catalogRow ? projectLocation(project.path) : project.path}</span>
                      {!catalogRow ? <span className="text-xs font-normal text-muted-foreground">{formatRelativeTime(project.updated_at)}</span> : null}
                    </> : null}
                  </span>
                  {compact || catalogRow ? <span id={summaryId} className="sr-only">{statusTitle} · {project.path} · {availabilityView.label}</span> : null}
                </Button>
                {catalogRow ? <time dateTime={project.updated_at} className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatRelativeTime(project.updated_at)}</time> : null}
                {projectMenu}
              </div>}

              {showAvailability ? <div className={`flex items-center text-xs ${compact ? "h-6 min-w-0 gap-1 pb-1 pl-6 pr-1" : "mt-1 flex-wrap gap-1.5 px-1"} ${availabilityView.className}`}>
                <span className={`flex items-center gap-1 ${compact ? "min-w-0 flex-1" : ""}`} title={availabilityView.label}>
                  <span className="shrink-0" aria-hidden="true">{availabilityView.icon}</span>
                  <span className={compact ? "truncate" : undefined}>{availabilityView.label}</span>
                </span>
                {availabilityState?.status === "check_failed" || retryActivated.current.has(project.id) ? (
                  <Button variant="ghost" size="sm" className={compact ? "h-5 shrink-0 px-1 py-0 text-[11px]" : "h-auto px-1 py-0.5 text-xs"}
                    type="button"
                    aria-busy={retryBusyIds.has(project.id) || availabilityState?.status === "checking" || undefined}
                    aria-disabled={availabilityState?.status !== "check_failed" || retryBusyIds.has(project.id)}
                    tabIndex={availabilityState?.status === "check_failed" || retryActivated.current.has(project.id) ? 0 : -1}
                    onClick={() => retryAvailability(project.id)}
                  >
                    {availabilityState?.status === "check_failed" ? t("重试检查") : availabilityView.label}
                  </Button>
                ) : null}
                {availabilityState?.status === "check_failed" ? <small className={compact ? "sr-only" : undefined}>{t("记录已保留")}</small> : null}
                {availabilityState?.status === "unreadable" ? <small className={compact ? "sr-only" : undefined}>{t("请检查项目数据，或选择正确的项目位置。")}</small> : null}
                {["missing", "unreadable"].includes(availabilityState?.status ?? "") ? (
                  <Button variant="ghost" size="sm" className={compact ? "h-5 shrink-0 px-1 py-0 text-[11px]" : "h-auto px-1 py-0.5 text-xs"} type="button" disabled={relinkBusyId === project.id} onClick={() => void relink(project)}>
                    {!compact ? <LinkSimple size={13} /> : null}{relinkBusyId === project.id ? t("正在验证…") : t("重新定位")}
                  </Button>
                ) : null}
              </div> : null}

              {rowRelink?.kind === "mismatch" ? (
                <Notification variant="error"
                  ref={(node) => { if (node) mismatchHeadings.current.set(project.id, node); else mismatchHeadings.current.delete(project.id); }}
                  className="mt-2"
                  tabIndex={-1}
                  title={t("所选目录属于另一个项目")}
                  message={<>{t("原记录未更改（")}{rowRelink.code}）。</>}
                  actions={<>
                    <Button variant="outline" size="sm" type="button" onClick={() => void relink(project)}>{t("选择其他位置")}</Button>
                    <Button variant="outline" size="sm" type="button" onClick={() => { void onOpenIndependent(rowRelink.candidatePath); onNavigate(); }}>{t("作为独立项目打开")}</Button>
                  </>}
                />
              ) : rowRelink?.kind === "error" ? (
                <Notification variant="error" className="mt-2" title={t("无法重新定位")} message={<>{localizeMessage(rowRelink.message)}（{rowRelink.code}）</>} />
              ) : null}
            </div>
          );
          return galleryView ? <DesktopContextMenu key={`${project.id}:${project.path}`} trigger={projectCard} label={t("{0} 项目操作", project.name)} open={contextProjectId === project.id} onOpenChange={(open) => { setContextProjectId(open ? project.id : null); if (open) setMenuProjectId(null); }} onReturnFocus={() => menuTriggers.current.get(project.id)?.focus()}>{projectMenuContent(actions, true)}</DesktopContextMenu> : projectCard;
        })}
        {filteredProjects.length === 0 ? (
          <div className={`px-3 py-8 text-center text-xs text-muted-foreground ${galleryView ? "col-span-full" : ""}`}>{loading ? t("正在加载最近项目…") : loadError ? t("无法读取最近项目") : query ? t("没有匹配项目") : t("还没有最近项目")}</div>
        ) : null}
      </div>
    </div>
  );
}
