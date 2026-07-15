import { WarningCircle, X } from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DeleteProjectDialog } from "./components/shell/DeleteProjectDialog";
import { ProjectSidebar } from "./components/shell/ProjectSidebar";
import { SystemStatusBar } from "./components/shell/SystemStatusBar";
import { TitleRunBar } from "./components/shell/TitleRunBar";
import { SettingsDrawer } from "./components/settings";
import { AppProvider, useAppContext } from "./context";
import { HomePage, NewProjectPage, ProjectDetailPage } from "./pages";
import {
  confirmSafeCancel,
  confirmRemoveRecentProject,
  desktopApi,
  isDesktopRuntime,
  selectProjectDirectory,
} from "./services/desktop";
import type { AppSettings, PipelineEventEnvelope, Project, ProjectInfo, ProjectStatus, ResourceMetrics } from "./types";
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
  const [deleteCandidate, setDeleteCandidate] = useState<ProjectInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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
    dispatch({ type: "SET_ENGINES_LOADING" });
    dispatch({ type: "SET_RECENT_PROJECTS_LOADING" });
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
    } else {
      dispatch({ type: "SET_ENGINES_ERROR", error: String(enginesResult.reason) });
    }
    if (projectsResult.status === "fulfilled") {
      dispatch({ type: "SET_RECENT_PROJECTS", projects: projectsResult.value });
    } else {
      dispatch({ type: "SET_RECENT_PROJECTS_ERROR", error: String(projectsResult.reason) });
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
      timer = window.setTimeout(sample, document.hidden ? 30_000 : active ? 5_000 : 15_000);
    };
    void sample();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [activeProjectPath, pipelineStatus]);

  useEffect(() => {
    void loadApplicationData();
  }, [loadApplicationData]);

  useEffect(() => {
    dispatch({ type: "SET_PIPELINE_ERROR", error: null });
    if (!activeProjectPath) {
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: null });
      return;
    }
    let disposed = false;
    let unlistenPipeline: (() => void) | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    const refresh = async (): Promise<void> => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try {
        const snapshot = await desktopApi.getPipelineState(activeProjectPath);
        if (disposed) return;
        if (activeProject && snapshot.project_id !== activeProject.id) return;
        dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
        const snapshotStage = snapshot.state.current_stage ?? undefined;
        if (
          activeProject &&
          (activeProject.status !== snapshot.status ||
            activeProject.stage_label !== snapshotStage)
        ) {
          dispatch({
            type: "ADD_RECENT_PROJECT",
            project: {
              ...activeProject,
              status: snapshot.status,
              stage_label: snapshotStage,
            },
          });
        }
      } catch (error) {
        if (!disposed) dispatch({ type: "SET_PIPELINE_ERROR", error: String(error) });
      } finally {
        refreshInFlight = false;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    void refresh();
    if (isDesktopRuntime()) {
      void listen<PipelineEventEnvelope>("pipeline://event", (event) => {
        if (!activeProject || event.payload.project_id !== activeProject.id) return;
        void refresh();
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenPipeline = unlisten;
      });
    }
    const activelyRunning = activeProject && ["starting", "running", "pausing", "cancelling", "recovering"].includes(activeProject.status);
    const timer = window.setInterval(() => void refresh(), activelyRunning ? 3_000 : 10_000);
    return () => {
      disposed = true;
      unlistenPipeline?.();
      window.clearInterval(timer);
    };
  }, [activeProject, activeProjectPath, dispatch]);

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

  const handleRevealProject = useCallback(async (project: ProjectInfo) => {
    try {
      const result = await desktopApi.openProjectLocation({
        projectId: project.id,
        projectPath: project.path,
        targetType: "project_root",
      });
      if (result.missing) {
        dispatch({ type: "SET_ERROR", error: result.message ?? "项目目录已移动或删除。" });
        const remove = await confirmRemoveRecentProject(project.name);
        if (remove) {
          await desktopApi.removeRecentProject(project.id, project.path);
          dispatch({ type: "REMOVE_RECENT_PROJECT", projectId: project.id });
          if (activeProjectPath === project.path) {
            dispatch({ type: "NAVIGATE", page: { type: "home" } });
          }
        }
      }
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProjectPath, dispatch]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      const confirmed = await confirmRemoveRecentProject(project.name);
      if (!confirmed) return;
      await desktopApi.removeRecentProject(project.id, project.path);
      dispatch({ type: "REMOVE_RECENT_PROJECT", projectId: project.id });
      if (activeProjectPath === project.path) {
        dispatch({ type: "NAVIGATE", page: { type: "home" } });
      }
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProjectPath, dispatch]);

  const handleDeleteProject = useCallback(async () => {
    if (!deleteCandidate) return;
    setDeleteBusy(true);
    try {
      await desktopApi.deleteProject({
        projectId: deleteCandidate.id,
        projectPath: deleteCandidate.path,
      });
      dispatch({ type: "REMOVE_RECENT_PROJECT", projectId: deleteCandidate.id });
      if (activeProjectPath === deleteCandidate.path) {
        dispatch({ type: "NAVIGATE", page: { type: "home" } });
      }
      setDeleteCandidate(null);
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    } finally {
      setDeleteBusy(false);
    }
  }, [activeProjectPath, deleteCandidate, dispatch]);

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
        return <HomePage onRetry={() => void loadApplicationData()} />;
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
        loading={state.recentProjectsLoading}
        loadError={state.recentProjectsError}
        activeProjectPath={activeProjectPath}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onHome={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}
        onNewProject={() =>
          dispatch({ type: "NAVIGATE", page: { type: "new-project" } })
        }
        onOpenProject={() => void handleOpenProject()}
        onSelectProject={(project) => void openSelectedProject(project)}
        onRevealProject={(project) => void handleRevealProject(project)}
        onRemoveProject={(project) => void handleRemoveProject(project)}
        onDeleteProject={setDeleteCandidate}
        onRetry={() => void loadApplicationData()}
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
          onRevealProject={() => activeProject && void handleRevealProject(activeProject)}
          onRemoveProject={() => activeProject && void handleRemoveProject(activeProject)}
          onDeleteProject={() => activeProject && setDeleteCandidate(activeProject)}
        />
        <main className="workspace-content">{page}</main>
      </section>

      <SystemStatusBar
        engines={state.engines}
        enginesLoading={state.enginesLoading}
        enginesError={state.enginesError}
        version={version}
        metrics={metrics}
        onOpenSettings={() => setSettingsOpen(true)}
        onRetryEngines={() => void loadApplicationData()}
      />

      {settingsOpen && settings && (
        <SettingsDrawer
          engines={state.engines}
          settings={settings}
          metrics={metrics}
          projectId={activeProject?.id ?? null}
          projectPath={activeProjectPath}
          onClose={() => setSettingsOpen(false)}
          onSettings={setSettings}
          onEngines={(engines) => dispatch({ type: "SET_ENGINES", engines })}
          onError={(error) => dispatch({ type: "SET_ERROR", error })}
        />
      )}

      {deleteCandidate && (
        <DeleteProjectDialog
          project={deleteCandidate}
          busy={deleteBusy}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => void handleDeleteProject()}
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
