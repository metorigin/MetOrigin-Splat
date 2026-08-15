import {
  CaretDown,
  FolderOpen,
  Pause,
  Play,
  SlidersHorizontal,
  StopCircle,
  Trash,
  XCircle,
} from "@phosphor-icons/react";
import { useId, useState } from "react";

import { useMenuFocus } from "../../hooks";
import { getProjectStatusLabel, getStageLabel } from "../../localization";
import type { PipelineConflictInfo, PipelineSnapshot, ProjectInfo, TaskProgress } from "../../types";
import { PipelineConflictNotice } from "./PipelineConflictNotice";

interface TitleRunBarProps {
  project: ProjectInfo | null;
  pipelineSnapshot: PipelineSnapshot | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onRevealProject: () => void;
  onRemoveProject: () => void;
  onDeleteProject: () => void;
  pipelineConflict?: PipelineConflictInfo | null;
  onBlockedAttempt?: () => void;
  onReturnToActiveProject?: () => void;
  taskProgress?: TaskProgress | null;
  updatedAt?: number | null;
}

export function TitleRunBar({
  project,
  pipelineSnapshot,
  onStart,
  onPause,
  onResume,
  onCancel,
  onOpenSettings,
  onRevealProject,
  onRemoveProject,
  onDeleteProject,
  pipelineConflict = null,
  onBlockedAttempt = () => undefined,
  onReturnToActiveProject = () => undefined,
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
  const menu = useMenuFocus({
    open: menuOpen,
    onOpenChange: setMenuOpen,
    itemCount: 4,
    isDisabled: (index) => isRunning && index >= 2,
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
        <div className="project-heading">
          <h1>{project.name}</h1>
        </div>

        <div className="run-actions">
          {isRunning && (
            <button
              type="button"
              className="button button-danger"
              onClick={onCancel}
              disabled={isControlling}
            >
              <StopCircle size={17} />
              {status === "cancelling" ? "正在取消…" : "取消（安全）"}
            </button>
          )}
          <button
            type="button"
            className="button button-secondary"
            onClick={handleRunAction}
            disabled={isControlling}
            aria-disabled={pipelineConflict ? true : undefined}
            aria-describedby={pipelineConflict ? conflictDescriptionId : undefined}
            title={isRunning ? "安全暂停并保留有效产物" : canResume ? "校验产物后继续重建" : "开始重建"}
          >
            {isRunning ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
            {isControlling ? "正在处理…" : isRunning ? "暂停" : canResume ? "继续" : "开始重建"}
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
                <button type="button" {...menu.getItemProps(1)} onClick={() => { setMenuOpen(false); onOpenSettings(); }}>
                  <SlidersHorizontal size={15} /> 设置
                </button>
                <span className="action-menu-separator" />
                <button type="button" {...menu.getItemProps(2)} disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onRemoveProject(); }}>
                  <XCircle size={15} /> 从最近项目移除
                </button>
                <button type="button" {...menu.getItemProps(3)} className="is-danger" disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onDeleteProject(); }}>
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
      {pipelineConflict && (
        <PipelineConflictNotice
          id={conflictDescriptionId}
          conflict={pipelineConflict}
          assertive={conflictAssertive}
          onReturn={onReturnToActiveProject}
        />
      )}
    </header>
  );
}
