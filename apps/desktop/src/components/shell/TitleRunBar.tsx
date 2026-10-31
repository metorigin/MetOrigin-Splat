import { t, getLocale } from "../../i18n";
import {
  ArrowClockwise,
  CaretDown,
  FolderOpen,
  Pause,
  Pencil,
  Play,
  StopCircle,
  SpinnerGap,
  Trash,
} from "../primitives/icons";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Notification } from "../feedback";
import { Progress } from "@/components/ui/progress";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { DesktopMenu } from "./DesktopMenu";
import { getProjectStatusLabel, getStageLabel } from "../../localization";
import type { PipelineConflictInfo, PipelineSnapshot, ProjectInfo, TaskProgress } from "../../types";

interface TitleRunBarProps {
  project: ProjectInfo | null;
  compact?: boolean;
  pipelineSnapshot: PipelineSnapshot | null;
  onStart: () => void;
  onHome?: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRevealProject: () => void;
  onDeleteProject: () => void;
  onViewActivity?: () => void;
  pipelineConflict?: PipelineConflictInfo | null;
  onBlockedAttempt?: () => void;
  taskProgress?: TaskProgress | null;
  updatedAt?: number | null;
  onEdit?: () => void;
  openingEditor?: boolean;
}

export function TitleRunBar({
  project,
  compact = false,
  pipelineSnapshot,
  onStart,
  onPause,
  onResume,
  onCancel,
  onRevealProject,
  onDeleteProject,
  onViewActivity = () => undefined,
  pipelineConflict = null,
  onBlockedAttempt = () => undefined,
  taskProgress = null,
  updatedAt = null,
  onEdit,
  openingEditor = false,
}: TitleRunBarProps) {
  const [conflictAssertive, setConflictAssertive] = useState(false);
  const conflictDescriptionId = useId();
  const status = pipelineSnapshot?.status ?? project?.status ?? "ready";
  const isRunning = ["starting", "running", "pausing", "cancelling", "recovering"].includes(status);
  const isControlling = ["starting", "pausing", "cancelling", "recovering"].includes(status);
  const canResume = status === "paused" || status === "cancelled";
  const isFailed = status === "failed";
  const isComplete = status === "completed";
  if (!project) return null;
  const progress = isComplete ? 100 : pipelineSnapshot && Number.isFinite(pipelineSnapshot.state.overall_progress)
    ? Math.round(pipelineSnapshot.state.overall_progress * 100)
    : null;
  const stageLabel = isComplete ? t("重建完成") : pipelineSnapshot?.state.current_stage
    ? getStageLabel(pipelineSnapshot.state.current_stage)
    : project.stage_label
      ? getStageLabel(project.stage_label)
      : t("正在准备");
  const workUnit = taskProgress && taskProgress.total_items > 0
    ? t("{0} / {1} 项", Math.max(0, taskProgress.current_item).toLocaleString(getLocale()), taskProgress.total_items.toLocaleString(getLocale()))
    : null;
  const progressText = [
    stageLabel,
    workUnit,
    progress == null ? t("整体进度正在估算") : t("整体进度 {0}%", progress),
  ].filter(Boolean).join("，");
  const handleRunAction = () => {
    if (pipelineConflict) {
      setConflictAssertive(true);
      onBlockedAttempt();
      return;
    }
    if (isRunning) onPause();
    else if (canResume) onResume();
    else onStart();
  };

  const progressDetails = (
      <div className={cn("grid items-center gap-4", !compact && "xl:grid-cols-[minmax(180px,1fr)_auto]")}>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("整体进度")}</span><strong className="font-medium tabular-nums">{progress == null ? t("正在估算") : `${progress}%`}</strong></div>
          <Progress value={progress} aria-label={t("整体进度")} aria-valuetext={progressText} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs [&>span]:text-muted-foreground [&>strong]:mr-3 [&>strong]:font-medium [&>strong]:tabular-nums">
          <span>{t("状态")}</span>
          <strong>{getProjectStatusLabel(status)}</strong>
          <span>{t("当前阶段")}</span>
          <strong>{stageLabel}</strong>
          {(!isComplete || workUnit) && <><span>{t("实际工作量")}</span><strong>{workUnit ?? t("正在统计")}</strong></>}
          <span>{t("最近更新")}</span>
          <strong>{updatedAt ? new Date(updatedAt).toLocaleTimeString(getLocale(), { hour12: false }) : t("等待活动")}</strong>
        </div>
      </div>
  );

  return (
    <header className={cn("bg-background", compact ? "flex h-full min-w-0 flex-1 items-center px-3" : "shrink-0 space-y-3 px-4 py-3")}>
      <div className={cn("flex min-w-0 items-center", compact ? "w-full gap-3" : "flex-wrap gap-4")}>
        <div className={cn("min-w-0 flex-1 [&_h1]:truncate [&_h1]:font-medium [&_p]:truncate [&_p]:text-xs [&_p]:text-muted-foreground", compact ? "[&_h1]:text-sm" : "[&_h1]:text-lg")}>
          <h1 data-tauri-drag-region aria-label={project.name} title={project.name}>{project.name}</h1>
          {!compact ? <p>{project.path}</p> : null}
        </div>

        <div className={cn("flex shrink-0 items-center gap-2", !compact && "flex-wrap")}>
          {isComplete && onEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit} disabled={openingEditor} aria-label={openingEditor ? t("正在打开编辑器") : t("编辑")} title={t("在操作台内使用 SuperSplat 编辑模型")}>{openingEditor ? <SpinnerGap size={17} className="spin" /> : <Pencil size={17} />}<span className={compact ? "max-[900px]:sr-only" : undefined}>{t("编辑")}</span></Button>
          )}
          {(status === "running" || status === "cancelling") && (
            <Button
              type="button"
              variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onCancel}
              aria-label={status === "cancelling" ? t("正在取消…") : t("取消任务")}
              disabled={isControlling}
            >
              <StopCircle size={17} />
              <span className={compact ? "max-[900px]:sr-only" : undefined}>{status === "cancelling" ? t("正在取消…") : t("取消任务")}</span>
            </Button>
          )}
          {isFailed ? <Button type="button" variant="outline" size="sm" className={compact ? "max-[900px]:hidden" : undefined} onClick={onViewActivity}>{t("查看日志")}</Button> : null}
          {!isComplete && <Button
            type="button"
            variant="default" size="sm"
            onClick={handleRunAction}
            disabled={isControlling}
            aria-disabled={pipelineConflict ? true : undefined}
            aria-describedby={pipelineConflict ? conflictDescriptionId : undefined}
            title={isFailed ? t("重新启动任务并校验现有产物") : isRunning ? t("安全暂停并保留有效产物") : canResume ? t("校验产物后继续重建") : t("开始重建")}
            aria-label={isRunning ? t("暂停") : isControlling ? t("正在处理…") : isFailed ? t("重试任务") : canResume ? t("继续") : t("开始重建")}
          >
            {isFailed ? <ArrowClockwise size={17} /> : isRunning ? <Pause size={17} /> : <Play size={17} />}
            <span className={compact ? "max-[900px]:sr-only" : undefined}>{isControlling ? t("正在处理…") : isFailed ? t("重试任务") : isRunning ? t("暂停任务") : canResume ? t("继续") : t("开始重建")}</span>
          </Button>}
          <DesktopMenu trigger={<Button variant="ghost" size="sm" aria-label={t("操作")}><span className={compact ? "max-[900px]:sr-only" : undefined}>{t("操作")}</span><CaretDown size={14} /></Button>}>
            {compact && isFailed ? <DropdownMenuItem onSelect={onViewActivity}>{t("查看日志")}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={onRevealProject}><FolderOpen size={15} />{t("在资源管理器中显示")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={isRunning} title={isRunning ? t("请先安全取消重建") : undefined} onSelect={onDeleteProject}><Trash size={15} />{t("永久删除项目")}</DropdownMenuItem>
          </DesktopMenu>
        </div>
      </div>

      {!compact ? progressDetails : null}
      {pipelineConflict && !isComplete && (
        conflictAssertive && !compact
          ? <Notification id={conflictDescriptionId} variant="warning" role="alert" message={t("当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。")} />
          : <p id={conflictDescriptionId} className="sr-only" role={conflictAssertive ? "alert" : undefined}>
            {t("当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。")}</p>
      )}
    </header>
  );
}
