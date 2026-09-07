import {
  ArrowClockwise,
  CaretDown,
  Export,
  FolderOpen,
  Pause,
  Play,
  StopCircle,
  Trash,
  XCircle,
} from "../primitives/icons";
import { useId, useState } from "react";

import { useMenuFocus } from "../../hooks";
import { getProjectStatusLabel, getStageLabel } from "../../localization";
import type { PipelineConflictInfo, PipelineSnapshot, ProjectInfo, TaskProgress } from "../../types";
import appIconUrl from "../../../src-tauri/icons/app-icon.svg";

interface TitleRunBarProps {
  project: ProjectInfo | null;
  pipelineSnapshot: PipelineSnapshot | null;
  onStart: () => void;
  onHome?: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRevealProject: () => void;
  onRemoveProject: () => void;
  onDeleteProject: () => void;
  onViewActivity?: () => void;
  pipelineConflict?: PipelineConflictInfo | null;
  onBlockedAttempt?: () => void;
  taskProgress?: TaskProgress | null;
  updatedAt?: number | null;
}

export function TitleRunBar({
  project,
  pipelineSnapshot,
  onStart,
  onHome = () => undefined,
  onPause,
  onResume,
  onCancel,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  onViewActivity = () => undefined,
  pipelineConflict = null,
  onBlockedAttempt = () => undefined,
  taskProgress = null,
  updatedAt = null,
}: TitleRunBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [conflictAssertive, setConflictAssertive] = useState(false);
  const menuId = useId();
  const conflictDescriptionId = useId();
  const status = pipelineSnapshot?.status ?? project?.status ?? "ready";
  const isRunning = ["starting", "running", "pausing", "cancelling", "recovering"].includes(status);
  const isControlling = ["starting", "pausing", "cancelling", "recovering"].includes(status);
  const canResume = status === "paused" || status === "cancelled";
  const isFailed = status === "failed";
  const isComplete = status === "completed";
  const statusLabel = status === "running" ? "处理中" : status === "failed" ? "已阻塞" : status === "ready" ? "等待中" : getProjectStatusLabel(status);
  const menu = useMenuFocus({
    open: menuOpen,
    onOpenChange: setMenuOpen,
    itemCount: 3,
    isDisabled: (index) => isRunning && index >= 1,
  });
  if (!project) return null;
  const progress = pipelineSnapshot && Number.isFinite(pipelineSnapshot.state.overall_progress)
    ? Math.round(pipelineSnapshot.state.overall_progress * 100)
    : null;
  const stageLabel = pipelineSnapshot?.state.current_stage
    ? getStageLabel(pipelineSnapshot.state.current_stage)
    : project.stage_label
      ? getStageLabel(project.stage_label)
      : "正在准备";
  const workUnit = taskProgress && taskProgress.total_items > 0
    ? `${Math.max(0, taskProgress.current_item).toLocaleString()} / ${taskProgress.total_items.toLocaleString()} 项`
    : null;
  const progressText = [
    stageLabel,
    workUnit,
    progress == null ? "整体进度正在估算" : `整体进度 ${progress}%`,
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

  return (
    <header className="title-run-bar">
      <div className="title-row">
        <button type="button" className="workspace-brand-button" onClick={onHome} title="返回项目中心">
          <img src={appIconUrl} alt="" />
          <span>MetOrigin Splat</span>
        </button>
        <div className="project-heading">
          <h1 aria-label={project.name}>{project.name}</h1>
          <p>{project.path}</p>
        </div>

        <div className="run-actions">
          <span className={`status-pill status-${status}`}><i />{statusLabel}</span>
          {(status === "running" || status === "cancelling") && (
            <button
              type="button"
              className="button button-danger"
              onClick={onCancel}
              disabled={isControlling}
            >
              <StopCircle size={17} />
              {status === "cancelling" ? "正在取消…" : "取消任务"}
            </button>
          )}
          {isFailed ? <button type="button" className="button button-secondary" onClick={onViewActivity}>查看日志</button> : null}
          <button
            type="button"
            className={`button ${isFailed || canResume ? "button-primary" : "button-secondary"}`}
            onClick={isComplete ? onRevealProject : handleRunAction}
            disabled={isControlling}
            aria-disabled={pipelineConflict && !isComplete ? true : undefined}
            aria-describedby={pipelineConflict && !isComplete ? conflictDescriptionId : undefined}
            title={isComplete ? "打开项目文件目录" : isFailed ? "重新启动任务并校验现有产物" : isRunning ? "安全暂停并保留有效产物" : canResume ? "校验产物后继续重建" : "开始重建"}
            aria-label={isRunning ? "暂停" : undefined}
          >
            {isComplete ? <Export size={17} /> : isFailed ? <ArrowClockwise size={17} /> : isRunning ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
            {isControlling ? "正在处理…" : isComplete ? "查看项目文件" : isFailed ? "重试任务" : isRunning ? "暂停任务" : canResume ? "继续" : "开始重建"}
          </button>
          <div className="project-action-menu">
            <button
              ref={menu.triggerRef}
              type="button"
              className="button button-secondary"
              disabled={!project}
              onClick={() => menuOpen ? menu.closeMenu(true) : menu.openMenu("first")}
              onKeyDown={menu.onTriggerKeyDown}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls={menuOpen ? menuId : undefined}
            >
              操作
              <CaretDown size={14} />
            </button>
            {menuOpen && project && (
              <div ref={menu.menuRef} id={menuId} className="action-menu-popover" role="menu" data-keyboard-overlay="true" onKeyDown={menu.onMenuKeyDown}>
                <button type="button" {...menu.getItemProps(0)} onClick={() => { setMenuOpen(false); onRevealProject(); }}>
                  <FolderOpen size={15} /> 在资源管理器中显示
                </button>
                <span className="action-menu-separator" />
                <button type="button" {...menu.getItemProps(1)} disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onRemoveProject(); }}>
                  <XCircle size={15} /> 从最近项目移除
                </button>
                <button type="button" {...menu.getItemProps(2)} className="is-danger" disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onDeleteProject(); }}>
                  <Trash size={15} /> 永久删除项目
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="run-summary-row">
        <div
          className="progress-summary"
          role="progressbar"
          aria-label="整体进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
          aria-valuetext={progressText}
        >
          <span className="progress-copy">
            <span>整体进度</span>
            <strong>{progress == null ? "正在估算" : `${progress}%`}</strong>
          </span>
          <span className="progress-track" aria-hidden="true">
            <span style={{ width: `${progress ?? 0}%` }} />
          </span>
        </div>
        <div className="run-time-copy">
          <span>状态</span>
          <strong>{getProjectStatusLabel(status)}</strong>
          <span>当前阶段</span>
          <strong>{stageLabel}</strong>
          <span>实际工作量</span>
          <strong>{workUnit ?? "正在统计"}</strong>
          <span>最近更新</span>
          <strong>{updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "等待活动"}</strong>
        </div>
      </div>
      {pipelineConflict && !isComplete && (
        <p id={conflictDescriptionId} className={conflictAssertive ? "run-conflict-feedback" : "sr-only"} role={conflictAssertive ? "alert" : undefined}>
          当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。
        </p>
      )}
    </header>
  );
}
