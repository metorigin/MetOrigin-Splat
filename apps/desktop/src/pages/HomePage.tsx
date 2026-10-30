import { useMemo, useState } from "react";
import { t, getLocale } from "../i18n";
import { FolderOpen, MagnifyingGlass, Plus } from "../components/primitives/icons";
import { useAppContext } from "../context";
import type { EngineInfo, ProjectInfo, RecentProjectAvailability } from "../types";
import { Notification } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/shell/PageHeader";
import { ProjectNavigator } from "@/components/shell/ProjectNavigator";
import type { ProjectNavigatorProps } from "@/components/shell/ProjectNavigator";
import { ProjectThumbnail } from "@/components/shell/ProjectThumbnail";

type ProjectActions = Pick<ProjectNavigatorProps, "onRevealProject" | "onDeleteProject" | "onRetryAvailability" | "onRelinkProject" | "onOpenIndependent">;

interface HomePageProps {
  engines: EngineInfo[];
  onOpenProject: () => void;
  onOpenSettings?: () => void;
  onRetry?: () => void;
  titleInWindowHeader?: boolean;
  onSelectProject?: (project: ProjectInfo) => void;
  projectActions?: Partial<ProjectActions>;
}

export function HomePage({ engines, onOpenProject, onOpenSettings, onRetry, titleInWindowHeader = false, onSelectProject, projectActions }: HomePageProps) {
  const { state, dispatch } = useAppContext();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase(getLocale());
  const availability = useMemo(() => Object.fromEntries(state.recentProjects.flatMap((project) => {
    const value = state.projectAvailability[project.id];
    return value?.checkedPath === project.path ? [[project.id, value]] : [];
  })) as Record<string, RecentProjectAvailability>, [state.projectAvailability, state.recentProjects]);
  const filtered = useMemo(() => state.recentProjects.filter((project) =>
    !query || `${project.name} ${project.path}`.toLocaleLowerCase(getLocale()).includes(query)), [query, state.recentProjects]);
  const unavailableEngines = engines.filter((engine) => !engine.available);
  const open = (project: ProjectInfo) => dispatch({ type: "NAVIGATE", page: { type: "project-detail", projectId: project.id, projectPath: project.path } });
  const create = () => dispatch({ type: "NAVIGATE", page: { type: "new-project" } });
  const hasSearch = query.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col px-5 pt-4 pb-8 lg:px-6">
        {!titleInWindowHeader ? <PageHeader title={t("项目中心")} className="mb-4 min-h-9 p-0" /> : null}

        {unavailableEngines.length > 0 ? <Notification variant="warning" role="alert" className="mb-4" message={<>{t("部分引擎需要处理")} · {unavailableEngines.map((engine) => engine.name).join(", ")}</>} actions={onOpenSettings ? <Button variant="ghost" size="xs" onClick={onOpenSettings}>{t("打开设置")}</Button> : null} /> : null}

        <section className="min-w-0" aria-labelledby="recent-project-heading">
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="mr-auto flex items-baseline gap-2.5" title={t("按最近打开排序")}>
              <h2 id="recent-project-heading" className="text-sm font-medium">{t("全部项目")}</h2>
              <span className="text-xs text-muted-foreground tabular-nums" aria-label={t("本机项目记录")}>{hasSearch ? `${filtered.length.toLocaleString(getLocale())} / ` : ""}{state.recentProjects.length.toLocaleString(getLocale())}</span>
              <span className="sr-only">{t("按最近打开排序")}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="relative w-48 lg:w-56">
                <Label htmlFor="project-center-search" className="sr-only">{t("搜索项目名称或路径")}</Label>
                <MagnifyingGlass size={15} aria-hidden="true" className="pointer-events-none absolute top-2 left-2.5 text-muted-foreground" />
                <Input id="project-center-search" className="h-8 border-transparent bg-muted/55 pl-8 text-xs shadow-none focus-visible:bg-background" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索项目…")} />
              </div>
              <Button variant="ghost" size="sm" onClick={onOpenProject}><FolderOpen size={15} />{t("打开项目")}</Button>
              <Button size="sm" onClick={create}><Plus size={15} />{t("新建项目")}</Button>
            </div>
          </div>
          {state.recentProjectsError ? <Notification variant="warning" role="alert" className="mb-3" message={t("最近项目读取失败，正在显示已加载的记录。")} actions={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重新加载")}</Button> : null} /> : null}
          {filtered.length > 0 ? <div className="border-t border-border/70 pt-4">
            <ProjectNavigator projects={filtered} availability={availability} activeProjectPath={null}
              loading={state.recentProjectsLoading} gallery showSearch={false} maxItems={filtered.length} showHealthyAvailability={false}
              renderThumbnail={(project) => <ProjectThumbnail project={project} availability={availability[project.id]} />}
              onSelectProject={onSelectProject ?? open}
              onRevealProject={projectActions?.onRevealProject ?? (() => undefined)}
              onDeleteProject={projectActions?.onDeleteProject ?? (() => undefined)}
              onRetryAvailability={projectActions?.onRetryAvailability ?? (() => undefined)}
              onRelinkProject={projectActions?.onRelinkProject ?? (async () => ({ kind: "cancelled" }))}
              onOpenIndependent={projectActions?.onOpenIndependent ?? (() => undefined)} />
          </div> : <div className="flex min-h-72 flex-col items-center justify-center gap-3 border-t border-border/70 p-6 text-center"><FolderOpen size={28} className="text-muted-foreground" /><h3 className="text-base font-medium">{state.recentProjectsLoading ? t("正在加载项目") : hasSearch ? t("没有匹配的项目") : t("创建你的第一个场景")}</h3><p className="max-w-md text-sm text-muted-foreground">{hasSearch ? t("试试其他名称或路径。") : t("导入连续照片或视频，逐步完成三维重建。")}</p>{hasSearch ? <Button variant="outline" size="sm" onClick={() => setSearch("")}>{t("清除搜索")}</Button> : null}</div>}
        </section>
      </div>
    </div>
  );
}
