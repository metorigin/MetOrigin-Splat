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
import { useEffect, useRef, useState } from "react";

import { getProjectStatusLabel } from "../../localization";
import type { PipelineSnapshot, ProjectInfo } from "../../types";

function formatRemainingTime(snapshot: PipelineSnapshot | null, progress: number): string {
  if (snapshot?.status === "completed" || progress >= 100) return "已完成";
  if (!snapshot?.started_at || progress < 1 || progress >= 100) {
    return ["starting", "running", "recovering"].includes(snapshot?.status ?? "") ? "计算中" : "—";
  }
  const elapsedSeconds = (Date.now() - new Date(snapshot.started_at).getTime()) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return "计算中";
  const remainingSeconds = Math.max(0, elapsedSeconds * (100 - progress) / progress);
  if (remainingSeconds < 60) return "不足 1 分钟";
  const minutes = Math.ceil(remainingSeconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `约 ${hours} 小时 ${minutes % 60} 分钟`;
}

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
}: TitleRunBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuOpen]);
  const status = pipelineSnapshot?.status ?? project?.status ?? "ready";
  const isRunning = ["starting", "running", "pausing", "cancelling", "recovering"].includes(status) && project !== null;
  const isControlling = ["starting", "pausing", "cancelling", "recovering"].includes(status);
  const canResume = status === "paused" || status === "cancelled";
  const progress = project
    ? Math.round((pipelineSnapshot?.state.overall_progress ?? 0) * 100)
    : 0;
  const remainingTime = formatRemainingTime(pipelineSnapshot, progress);

  return (
    <header className="title-run-bar">
      <div className="title-row">
        <div className="project-heading">
          <h1>{project?.name ?? "项目工作区"}</h1>
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
            onClick={isRunning ? onPause : canResume ? onResume : onStart}
            disabled={!project || isControlling}
            title={isRunning ? "安全暂停并保留有效产物" : canResume ? "校验产物后继续重建" : "开始重建"}
          >
            {isRunning ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
            {isControlling ? "正在处理…" : isRunning ? "暂停" : canResume ? "继续" : "开始重建"}
          </button>
          <div className="project-action-menu" ref={menuRef}>
            <button
              type="button"
              className="button button-secondary"
              disabled={!project}
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              操作
              <CaretDown size={14} />
            </button>
            {menuOpen && project && (
              <div className="action-menu-popover" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRevealProject(); }}>
                  <FolderOpen size={15} /> 在资源管理器中显示
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenSettings(); }}>
                  <SlidersHorizontal size={15} /> 设置
                </button>
                <span className="action-menu-separator" />
                <button type="button" role="menuitem" disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onRemoveProject(); }}>
                  <XCircle size={15} /> 从最近项目移除
                </button>
                <button type="button" role="menuitem" className="is-danger" disabled={isRunning} title={isRunning ? "请先安全取消重建" : undefined} onClick={() => { setMenuOpen(false); onDeleteProject(); }}>
                  <Trash size={15} /> 永久删除项目
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="run-summary-row">
        <div className="progress-summary" role="progressbar" aria-label="整体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span className="progress-copy">
            <span>整体进度</span>
            <strong>{progress}%</strong>
          </span>
          <span className="progress-track" aria-label={`整体进度 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </span>
        </div>
        <div className="run-time-copy">
          <span>状态</span>
          <strong>{project ? getProjectStatusLabel(status) : "未选择项目"}</strong>
          <span>预计剩余</span>
          <strong>{remainingTime}</strong>
        </div>
      </div>
    </header>
  );
}
