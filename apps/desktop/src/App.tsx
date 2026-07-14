import { WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProjectSidebar } from "./components/shell/ProjectSidebar";
import { SystemStatusBar } from "./components/shell/SystemStatusBar";
import { TitleRunBar } from "./components/shell/TitleRunBar";
import { AppProvider, useAppContext } from "./context";
import { HomePage, NewProjectPage, ProjectDetailPage, TrainingPage } from "./pages";
import {
  confirmSafeCancel,
  desktopApi,
  selectProjectDirectory,
} from "./services/desktop";
import type { Project, ProjectInfo, ProjectStatus } from "./types";
import "./App.css";

function normalizeProjectStatus(status: string): ProjectStatus {
  const normalized = status.toLowerCase();
  if (
    normalized === "creating" ||
    normalized === "ready" ||
    normalized === "running" ||
    normalized === "paused" ||
    normalized === "completed" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return "ready";
}

function toProjectInfo(project: Project, path: string): ProjectInfo {
  return {
    id: project.id,
    name: project.name,
    path,
    status: normalizeProjectStatus(project.status),
    updated_at: project.updated_at,
    stage_label: project.current_stage ?? undefined,
  };
}

function AppWorkspace() {
  const { state, dispatch } = useAppContext();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const activeProjectPath =
    state.page.type === "project-detail" || state.page.type === "training"
      ? state.page.projectPath
      : null;
  const activeProject = useMemo(
    () =>
      state.recentProjects.find(
        (project) => project.path === activeProjectPath,
      ) ?? null,
    [activeProjectPath, state.recentProjects],
  );

  const loadApplicationData = useCallback(async () => {
    const [versionResult, enginesResult, projectsResult] =
      await Promise.allSettled([
        desktopApi.appVersion(),
        desktopApi.checkEngines(),
        desktopApi.listRecentProjects(),
      ]);

    if (versionResult.status === "fulfilled") {
      setVersion(versionResult.value);
    }
    if (enginesResult.status === "fulfilled") {
      dispatch({ type: "SET_ENGINES", engines: enginesResult.value });
    }
    if (projectsResult.status === "fulfilled") {
      dispatch({ type: "SET_RECENT_PROJECTS", projects: projectsResult.value });
    }
  }, [dispatch]);

  useEffect(() => {
    void loadApplicationData();
  }, [loadApplicationData]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void desktopApi
        .getPipelineState()
        .then((pipelineState) => {
          dispatch({ type: "SET_PIPELINE_STATE", state: pipelineState });
          if (
            pipelineState.current_stage === null &&
            pipelineState.overall_progress >= 1
          ) {
            setRunning(false);
            void loadApplicationData();
          }
        })
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [dispatch, loadApplicationData, running]);

  const openSelectedProject = useCallback(
    async (project: ProjectInfo) => {
      dispatch({
        type: "NAVIGATE",
        page: {
          type: "project-detail",
          projectId: project.id,
          projectPath: project.path,
        },
      });
      setRunning(project.status === "running");
    },
    [dispatch],
  );

  const handleOpenProject = useCallback(async () => {
    try {
      const path = await selectProjectDirectory();
      if (!path) return;
      const project = await desktopApi.openProject(path);
      const info = toProjectInfo(project, path);
      dispatch({ type: "ADD_RECENT_PROJECT", project: info });
      await openSelectedProject(info);
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [dispatch, openSelectedProject]);

  const handleStart = useCallback(async () => {
    if (!activeProject) return;
    try {
      setRunning(true);
      await desktopApi.startPipeline(activeProject.path);
      dispatch({
        type: "ADD_RECENT_PROJECT",
        project: { ...activeProject, status: "running" },
      });
    } catch (error) {
      setRunning(false);
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, dispatch]);

  const handleCancel = useCallback(async () => {
    if (!activeProject) return;
    try {
      const confirmed = await confirmSafeCancel(
        activeProject.stage_label ?? "当前阶段",
      );
      if (!confirmed) return;
      await desktopApi.cancelPipeline();
      setRunning(false);
      void loadApplicationData();
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, dispatch, loadApplicationData]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        dispatch({ type: "NAVIGATE", page: { type: "new-project" } });
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void handleOpenProject();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [dispatch, handleOpenProject]);

  const page = (() => {
    switch (state.page.type) {
      case "home":
        return <HomePage />;
      case "new-project":
        return <NewProjectPage />;
      case "project-detail":
        return (
          <ProjectDetailPage
            projectId={state.page.projectId}
            projectPath={state.page.projectPath}
          />
        );
      case "training":
        return (
          <TrainingPage
            projectId={state.page.projectId}
            projectPath={state.page.projectPath}
          />
        );
    }
  })();

  return (
    <div className="workspace-shell">
      <ProjectSidebar
        projects={state.recentProjects}
        activeProjectPath={activeProjectPath}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onHome={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}
        onNewProject={() =>
          dispatch({ type: "NAVIGATE", page: { type: "new-project" } })
        }
        onOpenProject={() => void handleOpenProject()}
        onSelectProject={(project) => void openSelectedProject(project)}
      />

      <section className="workspace-surface">
        <TitleRunBar
          project={activeProject}
          pipelineState={state.pipelineState}
          running={running}
          onStart={() => void handleStart()}
          onCancel={() => void handleCancel()}
        />
        <main className="workspace-content">{page}</main>
      </section>

      <SystemStatusBar engines={state.engines} version={version} />

      {state.error && (
        <div className="global-error" role="alert">
          <WarningCircle size={19} weight="fill" />
          <span>{state.error}</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_ERROR", error: null })}
            aria-label="关闭错误提示"
          >
            <X size={17} />
          </button>
        </div>
      )}

      {state.loading && (
        <div className="loading-overlay" aria-live="polite">
          <div className="loading-spinner" />
          <p>正在处理…</p>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppWorkspace />
    </AppProvider>
  );
}

export default App;
