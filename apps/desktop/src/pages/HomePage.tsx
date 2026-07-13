import { useEffect } from "react";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { EmptyState, ProjectCard } from "../components";
import type { ProjectInfo, EngineInfo } from "../types";

export function HomePage() {
  const { dispatch } = useAppContext();

  const versionCmd = useTauriCommand<string>("app_version");
  const enginesCmd = useTauriCommand<EngineInfo[]>("check_engines");
  const projectsCmd = useTauriCommand<ProjectInfo[]>("list_recent_projects");
  const loadVersion = versionCmd.execute;
  const loadEngines = enginesCmd.execute;
  const loadProjects = projectsCmd.execute;

  // Load data on mount
  useEffect(() => {
    void loadVersion().catch(() => undefined);
    void loadEngines()
      .then((engines) => {
        if (engines) dispatch({ type: "SET_ENGINES", engines });
      })
      .catch(() => undefined);
    void loadProjects()
      .then((projects) => {
        if (projects) dispatch({ type: "SET_RECENT_PROJECTS", projects });
      })
      .catch(() => undefined);
  }, [dispatch, loadEngines, loadProjects, loadVersion]);

  return (
    <div className="page home-page">
      <header className="hero">
        <h1 className="hero-title">MetaOrigin Splat</h1>
        <p className="hero-subtitle">
          Turn photos and videos into 3D Gaussian Splats
        </p>
      </header>

      <div className="actions-row">
        <button
          className="btn btn-primary btn-large"
          onClick={() => dispatch({ type: "NAVIGATE", page: { type: "new-project" } })}
        >
          ✦ New Project
        </button>
        <button className="btn btn-secondary btn-large">
          📂 Open Project
        </button>
      </div>

      {/* Engine status bar */}
      <div className="engine-status-bar">
        {enginesCmd.data?.map((engine) => (
          <span
            key={engine.name}
            className={`engine-badge ${engine.available ? "available" : "missing"}`}
          >
            {engine.available ? "✅" : "⚠️"} {engine.name}
            {engine.version && ` ${engine.version}`}
          </span>
        ))}
        {versionCmd.data && (
          <span className="version-badge">v{versionCmd.data}</span>
        )}
      </div>

      {/* Recent projects */}
      <section className="section">
        <h2 className="section-title">Recent Projects</h2>

        {projectsCmd.loading && (
          <div className="loading-indicator">Loading projects...</div>
        )}

        {projectsCmd.error && (
          <div className="error-message">{projectsCmd.error}</div>
        )}

        {projectsCmd.data && projectsCmd.data.length === 0 && (
          <EmptyState
            icon="📸"
            title="No Projects Yet"
            description="Create a new project to start converting your media into 3D Gaussian Splats."
            actionLabel="Create Project"
            onAction={() =>
              dispatch({ type: "NAVIGATE", page: { type: "new-project" } })
            }
          />
        )}

        {projectsCmd.data && projectsCmd.data.length > 0 && (
          <div className="project-list">
            {projectsCmd.data.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onClick={() =>
                  dispatch({
                    type: "NAVIGATE",
                    page: {
                      type: "project-detail",
                      projectId: project.id,
                      projectPath: project.path,
                    },
                  })
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
