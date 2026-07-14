import {
  CaretDown,
  Pause,
  PencilSimple,
  Play,
  StopCircle,
} from "@phosphor-icons/react";

import { getProjectStatusLabel } from "../../localization";
import type { PipelineState, ProjectInfo } from "../../types";

interface TitleRunBarProps {
  project: ProjectInfo | null;
  pipelineState: PipelineState | null;
  running: boolean;
  onStart: () => void;
  onCancel: () => void;
}

export function TitleRunBar({
  project,
  pipelineState,
  running,
  onStart,
  onCancel,
}: TitleRunBarProps) {
  const isRunning = running && project !== null;
  const progress = project
    ? Math.round((pipelineState?.overall_progress ?? 0) * 100)
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
            >
              <StopCircle size={17} />
              取消（安全）
            </button>
          )}
          <button
            type="button"
            className="button button-secondary"
            onClick={onStart}
            disabled={!project || isRunning}
            title={isRunning ? "暂停功能将在运行控制阶段接入" : "开始重建"}
          >
            {isRunning ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
            {isRunning ? "暂停" : "开始重建"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={!project}
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
          <strong>{project ? getProjectStatusLabel(project.status) : "未选择项目"}</strong>
          <span>剩余约</span>
          <strong>尚未测量</strong>
        </div>
      </div>
    </header>
  );
}
