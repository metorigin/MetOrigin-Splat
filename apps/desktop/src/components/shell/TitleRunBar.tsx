import {
  CaretDown,
  Pause,
  PencilSimple,
  Play,
  StopCircle,
} from "@phosphor-icons/react";

import { getProjectStatusLabel } from "../../localization";
import type { PipelineSnapshot, ProjectInfo } from "../../types";

interface TitleRunBarProps {
  project: ProjectInfo | null;
  pipelineSnapshot: PipelineSnapshot | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}

export function TitleRunBar({
  project,
  pipelineSnapshot,
  onStart,
  onPause,
  onResume,
  onCancel,
  onOpenSettings,
}: TitleRunBarProps) {
  const status = pipelineSnapshot?.status ?? project?.status ?? "ready";
  const isRunning = ["starting", "running", "pausing", "cancelling", "recovering"].includes(status) && project !== null;
  const isControlling = ["starting", "pausing", "cancelling", "recovering"].includes(status);
  const canResume = status === "paused" || status === "cancelled";
  const progress = project
    ? Math.round((pipelineSnapshot?.state.overall_progress ?? 0) * 100)
    : 0;

  return (
    <header className="title-run-bar">
      <div className="title-row">
        <div className="project-heading">
          <h1>{project?.name ?? "项目工作区"}</h1>
          {project && (
            <button
              type="button"
              className="icon-button title-edit-button"
              title="重命名项目"
              aria-label="重命名项目"
              disabled
            >
              <PencilSimple size={15} />
            </button>
          )}
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
          <button
            type="button"
            className="button button-secondary"
            disabled={!project}
            onClick={onOpenSettings}
          >
            操作
            <CaretDown size={14} />
          </button>
        </div>
      </div>

      <div className="run-summary-row">
        <button type="button" className="progress-summary" disabled={!project}>
          <span className="progress-copy">
            <span>整体进度</span>
            <strong>{progress}%</strong>
          </span>
          <span className="progress-track" aria-label={`整体进度 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </span>
        </button>
        <div className="run-time-copy">
          <span>状态</span>
          <strong>{project ? getProjectStatusLabel(status) : "未选择项目"}</strong>
          <span>剩余约</span>
          <strong>尚未测量</strong>
        </div>
      </div>
    </header>
  );
}
