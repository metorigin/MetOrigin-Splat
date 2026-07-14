import { WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProjectSidebar } from "./components/shell/ProjectSidebar";
import { SystemStatusBar } from "./components/shell/SystemStatusBar";
import { TitleRunBar } from "./components/shell/TitleRunBar";
import { SettingsDrawer } from "./components/settings";
import { AppProvider, useAppContext } from "./context";
import { HomePage, NewProjectPage, ProjectDetailPage } from "./pages";
import {
  confirmSafeCancel,
  desktopApi,
  selectProjectDirectory,
} from "./services/desktop";
import type { AppSettings, Project, ProjectInfo, ProjectStatus, ResourceMetrics } from "./types";
import "./App.css";

function normalizeProjectStatus(status: string): ProjectStatus {
  const normalized = status.toLowerCase();
  if (
    normalized === "creating" ||
    normalized === "starting" ||
    normalized === "ready" ||
    normalized === "running" ||
    normalized === "pausing" ||
    normalized === "paused" ||
    normalized === "cancelling" ||
    normalized === "cancelled" ||
    normalized === "recovering" ||
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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeProjectPath =
    state.page.type === "project-detail" ? state.page.projectPath : null;
  const activeProject = useMemo(
    () =>
      state.recentProjects.find(
        (project) => project.path === activeProjectPath,
      ) ?? null,
    [activeProjectPath, state.recentProjects],
  );
  const pipelineStatus = state.pipelineSnapshot?.status ?? null;

  const loadApplicationData = useCallback(async () => {
    const [versionResult, enginesResult, projectsResult, settingsResult] =
      await Promise.allSettled([
        desktopApi.appVersion(),
        desktopApi.checkEngines(),
        desktopApi.listRecentProjects(),
        desktopApi.getAppSettings(),
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
    if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
  }, [dispatch]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const sample = async () => {
      try {
        const result = await desktopApi.getResourceMetrics(activeProjectPath ?? undefined);
        if (!disposed) setMetrics(result);
      } catch {
        if (!disposed) setMetrics(null);
      }
      if (disposed) return;
      const active = pipelineStatus && ["starting", "running", "pausing", "cancelling", "recovering"].includes(pipelineStatus);
      timer = window.setTimeout(sample, document.hidden ? 15_000 : active ? 2_000 : 5_000);
    };
    void sample();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [activeProjectPath, pipelineStatus]);

  useEffect(() => {
    void loadApplicationData();
  }, [loadApplicationData]);

  useEffect(() => {
    if (!activeProjectPath) {
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: null });
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const snapshot = await desktopApi.getPipelineState(activeProjectPath);
        if (disposed) return;
        dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
        const current = state.recentProjects.find((project) => project.id === snapshot.project_id);
        if (current && current.status !== snapshot.status) {
          dispatch({ type: "ADD_RECENT_PROJECT", project: { ...current, status: snapshot.status } });
        }
      } catch {
        // The project page will surface persistent load failures.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeProjectPath, dispatch, state.recentProjects]);

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
      const snapshot = await desktopApi.startPipeline(activeProject.path);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
      dispatch({
        type: "ADD_RECENT_PROJECT",
        project: { ...activeProject, status: "running" },
      });
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, dispatch]);

  const handlePause = useCallback(async () => {
    if (!activeProject) return;
    try {
      await desktopApi.pausePipeline();
      const snapshot = await desktopApi.getPipelineState(activeProject.path);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
      dispatch({ type: "ADD_RECENT_PROJECT", project: { ...activeProject, status: snapshot.status } });
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, dispatch]);

  const handleResume = useCallback(async () => {
    if (!activeProject) return;
    try {
      const snapshot = await desktopApi.resumePipeline(activeProject.path);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
      dispatch({ type: "ADD_RECENT_PROJECT", project: { ...activeProject, status: snapshot.status } });
    } catch (error) {
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
        return <NewProjectPage settings={settings} />;
      case "project-detail":
        return (
          <ProjectDetailPage
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
          pipelineSnapshot={state.pipelineSnapshot}
          onStart={() => void handleStart()}
          onPause={() => void handlePause()}
          onResume={() => void handleResume()}
          onCancel={() => void handleCancel()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="workspace-content">{page}</main>
      </section>

      <SystemStatusBar engines={state.engines} version={version} metrics={metrics} onOpenSettings={() => setSettingsOpen(true)} />

      {settingsOpen && settings && (
        <SettingsDrawer
          engines={state.engines}
          settings={settings}
          metrics={metrics}
          projectPath={activeProjectPath}
          onClose={() => setSettingsOpen(false)}
          onSettings={setSettings}
          onEngines={(engines) => dispatch({ type: "SET_ENGINES", engines })}
          onError={(error) => dispatch({ type: "SET_ERROR", error })}
        />
      )}

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
