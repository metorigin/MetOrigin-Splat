import { useEffect, useState } from "react";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { PipelineProgress } from "../components";
import type { Project, PipelineState } from "../types";
import {
  formatDate,
  getPresetLabel,
  getProjectStatusLabel,
} from "../localization";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
}

export function ProjectDetailPage({
  projectPath,
}: ProjectDetailPageProps) {
  const { dispatch } = useAppContext();

  const openCmd = useTauriCommand<Project>("open_project");
  const startPipelineCmd = useTauriCommand<void>("start_pipeline");
  const getStateCmd = useTauriCommand<PipelineState>("get_pipeline_state");
  const openProject = openCmd.execute;
  const startPipeline = startPipelineCmd.execute;
  const getPipelineState = getStateCmd.execute;

  const [project, setProject] = useState<Project | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);

  // Load project data
  useEffect(() => {
    void openProject({ path: projectPath })
      .then((loadedProject) => {
        if (loadedProject) setProject(loadedProject);
      })
      .catch(() => undefined);
  }, [openProject, projectPath]);

  // Poll pipeline state when running
  useEffect(() => {
    if (!pipelineRunning) return;
    const interval = setInterval(async () => {
      try {
        const state = await getPipelineState();
        if (state) {
          setPipelineState(state);
          if (state.current_stage === null && state.overall_progress >= 1.0) {
            setPipelineRunning(false);
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [getPipelineState, pipelineRunning]);

  const handleStartTraining = async () => {
    setPipelineRunning(true);
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      await startPipeline({ projectPath });
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: String(e) });
      setPipelineRunning(false);
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  };

  if (openCmd.loading) {
    return <div className="page"><div className="loading-indicator">正在加载项目…</div></div>;
  }

  if (openCmd.error) {
    return (
      <div className="page">
        <div className="error-message">{openCmd.error}</div>
        <button className="btn btn-text" onClick={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}>
          ← 返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="page project-detail-page">
      <button
        className="btn btn-text back-button"
        onClick={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}
      >
        ← 返回
      </button>

      <h1 className="page-title">{project?.name || "项目"}</h1>

      {/* Project info card */}
      {project && (
        <div className="project-info-card">
          <div className="info-row">
            <span className="info-label">状态</span>
            <span className={`status-indicator ${project.status}`}>
              {getProjectStatusLabel(project.status)}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">质量预设</span>
            <span>{getPresetLabel(project.settings.preset)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">创建日期</span>
            <span>{formatDate(project.created_at)}</span>
          </div>
          {project.source && (
            <div className="info-row">
              <span className="info-label">源媒体</span>
              <span>{project.source.type === "Video" ? project.source.filename : `${project.source.folder_name}（${project.source.image_count} 张图片）`}</span>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="action-buttons">
        <button
          className="btn btn-primary btn-large"
          onClick={handleStartTraining}
          disabled={pipelineRunning}
        >
          {pipelineRunning ? "正在运行…" : "▶ 开始训练"}
        </button>
        <button className="btn btn-secondary">
          📂 打开输出目录
        </button>
      </div>

      {/* Pipeline progress */}
      {pipelineState && (
        <section className="section">
          <h2 className="section-title">处理进度</h2>
          <PipelineProgress state={pipelineState} />
        </section>
      )}

      {startPipelineCmd.error && (
        <div className="error-message">{startPipelineCmd.error}</div>
      )}
    </div>
  );
}
