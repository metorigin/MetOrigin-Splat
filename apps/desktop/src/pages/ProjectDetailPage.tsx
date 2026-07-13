import { useEffect, useState } from "react";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { PipelineProgress } from "../components";
import type { Project, PipelineState } from "../types";

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
    return <div className="page"><div className="loading-indicator">Loading project...</div></div>;
  }

  if (openCmd.error) {
    return (
      <div className="page">
        <div className="error-message">{openCmd.error}</div>
        <button className="btn btn-text" onClick={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}>
          ← Back to Home
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
        ← Back
      </button>

      <h1 className="page-title">{project?.name || "Project"}</h1>

      {/* Project info card */}
      {project && (
        <div className="project-info-card">
          <div className="info-row">
            <span className="info-label">Status</span>
            <span className={`status-indicator ${project.status}`}>
              {project.status}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">Preset</span>
            <span>{project.settings.preset}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Created</span>
            <span>{new Date(project.created_at).toLocaleDateString()}</span>
          </div>
          {project.source && (
            <div className="info-row">
              <span className="info-label">Source</span>
              <span>{project.source.type === "Video" ? project.source.filename : `${project.source.folder_name} (images)`}</span>
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
          {pipelineRunning ? "Running..." : "▶ Start Training"}
        </button>
        <button className="btn btn-secondary">
          📂 Open Output Directory
        </button>
      </div>

      {/* Pipeline progress */}
      {pipelineState && (
        <section className="section">
          <h2 className="section-title">Pipeline Progress</h2>
          <PipelineProgress state={pipelineState} />
        </section>
      )}

      {startPipelineCmd.error && (
        <div className="error-message">{startPipelineCmd.error}</div>
      )}
    </div>
  );
}
