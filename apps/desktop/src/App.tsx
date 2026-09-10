import { localizeMessage, t } from "./i18n";
import { SpinnerGap, WarningCircle, X } from "./components/primitives/icons";
import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProjectSidebar } from "./components/shell/ProjectSidebar";
import { TitleRunBar } from "./components/shell/TitleRunBar";
import { SettingsDrawer } from "./components/settings";
import { ActionReceipt, StatusAnnouncer } from "./components/feedback";
import { WorkspaceActionDialog } from "./components/workspace";
import {
  AppProvider,
  selectActivePipelineSnapshot,
  selectPipelineFreshness,
  selectProjectPipelineSnapshot,
  useAppContext,
} from "./context";
import { shouldIgnoreShortcut, useProjectAvailability } from "./hooks";
import { useModelEditor } from "./hooks/useModelEditor";
import type { Page } from "./context";
import { getStageLabel } from "./localization";
import { HomePage, NewProjectPage, ProjectDetailPage } from "./pages";
import {
  confirmRemoveRecentProject,
  DesktopCommandError,
  desktopApi,
  isActivePipelineConflict,
  isDesktopRuntime,
  selectProjectDirectory,
} from "./services/desktop";
import { isUiPreviewMode } from "./services/uiPreview";
import type {
  AppSettings,
  PipelineConflictInfo,
  PipelineEventEnvelope,
  PipelineSnapshot,
  Project,
  ProjectInfo,
  ProjectStatus,
  ResourceMetrics,
  TaskProgress,
  ActionReceipt as ActionReceiptModel,
  WorkspaceActionRequest,
} from "./types";
import { useTheme } from "./hooks/useTheme";
import { useLanguage } from "./hooks/useLanguage";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/buzz.css";

const ModelEditorPage = lazy(() => import("./pages/ModelEditorPage"));

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

export function AppWorkspace() {
  useTheme();
  useLanguage();
  const previewNavigated = useRef(false);
  const { state, dispatch } = useAppContext();
  const previewOverlay = isUiPreviewMode()
    ? new URLSearchParams(window.location.search).get("preview-overlay")
    : null;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => previewOverlay === "settings");
  const [deleteCandidate, setDeleteCandidate] = useState<ProjectInfo | null>(null);
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceActionRequest | null>(null);
  const [actionReceipt, setActionReceipt] = useState<ActionReceiptModel | null>(null);
  const [taskProgressByProject, setTaskProgressByProject] = useState<Record<string, TaskProgress>>({});
  const [announcement, setAnnouncement] = useState("");
  const [workspaceActivitySignal, setWorkspaceActivitySignal] = useState(0);
  const editor = useModelEditor((error) => dispatch({ type: "SET_ERROR", error }));
  const leaveEditor = editor.leave;
  const navigate = useCallback(async (page: Page) => {
    if (await leaveEditor()) dispatch({ type: "NAVIGATE", page });
  }, [dispatch, leaveEditor]);
  const { retryProjectAvailability } = useProjectAvailability(
    state.recentProjects,
    state.projectAvailability,
    dispatch,
  );
  const previousPipelineAnnouncement = useRef<{
    projectId: string;
    stage: string | null;
    stale: boolean;
  } | null>(null);

  const activeProjectPath =
    state.page.type === "project-detail" ? state.page.projectPath : null;
  const activeProject = useMemo(
    () =>
      state.recentProjects.find(
        (project) => project.path === activeProjectPath,
      ) ?? null,
    [activeProjectPath, state.recentProjects],
  );
  const viewedPipelineSnapshot = selectProjectPipelineSnapshot(state, activeProject?.id);
  const viewedPipelineFreshness = selectPipelineFreshness(state, activeProject?.id);
  const activePipelineSnapshot = selectActivePipelineSnapshot(state);
  const activePipelineProject = useMemo(() => {
    if (!activePipelineSnapshot) return null;
    return state.recentProjects.find((project) => project.id === activePipelineSnapshot.project_id) ?? {
      id: activePipelineSnapshot.project_id,
      get name() { return t("活动项目"); },
      path: activePipelineSnapshot.project_path,
      status: activePipelineSnapshot.status,
      updated_at: activePipelineSnapshot.started_at ?? activePipelineSnapshot.accepted_at ?? new Date().toISOString(),
      stage_label: activePipelineSnapshot.state.current_stage ?? undefined,
    };
  }, [activePipelineSnapshot, state.recentProjects]);
  const activePipelineFreshness = selectPipelineFreshness(state, activePipelineSnapshot?.project_id);
  const pipelineStatus = activePipelineSnapshot?.status ?? viewedPipelineSnapshot?.status ?? null;
  const pipelineConflict = useMemo<PipelineConflictInfo | null>(() => {
    if (!activeProject || !activePipelineSnapshot || !activePipelineProject) return null;
    if (activeProject.id === activePipelineSnapshot.project_id) return null;
    return {
      activeProjectId: activePipelineSnapshot.project_id,
      activeProjectName: activePipelineProject.name,
      status: activePipelineSnapshot.status,
      stageLabel: activePipelineSnapshot.state.current_stage
        ? activePipelineProject.stage_label ?? activePipelineSnapshot.state.current_stage
        : null,
      progress: Number.isFinite(activePipelineSnapshot.state.overall_progress)
        ? activePipelineSnapshot.state.overall_progress
        : null,
      updatedAt: activePipelineFreshness.updatedAt,
    };
  }, [activePipelineFreshness.updatedAt, activePipelineProject, activePipelineSnapshot, activeProject]);

  const refreshActivePipeline = useCallback(async (): Promise<PipelineSnapshot | null> => {
    try {
      const snapshot = await desktopApi.getActivePipelineSummary();
      dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot });
      return snapshot;
    } catch (error) {
      dispatch({ type: "SET_PIPELINE_ERROR", error: String(error) });
      return null;
    }
  }, [dispatch]);

  const loadApplicationData = useCallback(async () => {
    dispatch({ type: "SET_ENGINES_LOADING" });
    dispatch({ type: "SET_RECENT_PROJECTS_LOADING" });
    const versionTask = desktopApi.appVersion()
      .then(setVersion)
      .catch(() => undefined);
    const enginesTask = desktopApi.checkEngines()
      .then((engines) => dispatch({ type: "SET_ENGINES", engines }))
      .catch((error) => dispatch({ type: "SET_ENGINES_ERROR", error: String(error) }));
    // Recent records must become interactive as soon as the index read ends;
    // engine/settings checks may touch slower resources and must not gate it.
    const projectsTask = desktopApi.listRecentProjectIndex()
      .then((projects) => dispatch({ type: "SET_RECENT_PROJECTS", projects }))
      .catch((error) => dispatch({ type: "SET_RECENT_PROJECTS_ERROR", error: String(error) }));
    const settingsTask = desktopApi.getAppSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        setSettingsError(null);
      })
      .catch((error) => setSettingsError(String(error)));
    await Promise.all([versionTask, enginesTask, projectsTask, settingsTask]);
  }, [dispatch]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    setMetrics(null);
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
    if (!isUiPreviewMode() || previewNavigated.current) return;
    const previewPage = new URLSearchParams(window.location.search).get("preview-page");
    if (previewPage === "new-project") {
      previewNavigated.current = true;
      dispatch({ type: "NAVIGATE", page: { type: "new-project" } });
      return;
    }
    if (previewPage === "workspace") {
      const project = state.recentProjects[0];
      if (project) {
        previewNavigated.current = true;
        dispatch({
          type: "NAVIGATE",
          page: { type: "project-detail", projectId: project.id, projectPath: project.path },
        });
      }
    }
  }, [dispatch, state.recentProjects]);

  useEffect(() => {
    let disposed = false;
    let unlistenPipeline: (() => void) | null = null;
    const refresh = (event?: PipelineEventEnvelope) => {
      if (event?.event.progress) {
        setTaskProgressByProject((current) => ({
          ...current,
          [event.project_id]: event.event.progress as TaskProgress,
        }));
      }
      if (!disposed) void refreshActivePipeline();
    };
    refresh();
    if (isDesktopRuntime()) {
      void listen<PipelineEventEnvelope>("pipeline://event", ({ payload }) => refresh(payload)).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenPipeline = unlisten;
      });
    }
    const timer = window.setInterval(refresh, 3_000);
    return () => {
      disposed = true;
      unlistenPipeline?.();
      window.clearInterval(timer);
    };
  }, [refreshActivePipeline]);

  useEffect(() => {
    if (!activePipelineSnapshot) {
      previousPipelineAnnouncement.current = null;
      return;
    }
    const next = {
      projectId: activePipelineSnapshot.project_id,
      stage: activePipelineSnapshot.state.current_stage,
      stale: activePipelineFreshness.stale,
    };
    const previous = previousPipelineAnnouncement.current;
    previousPipelineAnnouncement.current = next;
    if (!previous || previous.projectId !== next.projectId) return;
    if (previous.stage !== next.stage && next.stage) {
      setAnnouncement(t("当前阶段已切换为{0}。", getStageLabel(next.stage)));
    } else if (!previous.stale && next.stale) {
      setAnnouncement(t("任务状态暂时无法刷新，正在显示最后一次有效状态。"));
    } else if (previous.stale && !next.stale) {
      setAnnouncement(t("任务状态已恢复更新。"));
    }
  }, [activePipelineFreshness.stale, activePipelineSnapshot]);

  useEffect(() => {
    dispatch({ type: "SET_PIPELINE_ERROR", error: null });
    if (!activeProjectPath) return;
    let disposed = false;
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
    const activelyRunning = activeProject && ["starting", "running", "pausing", "cancelling", "recovering"].includes(activeProject.status);
    const timer = window.setInterval(() => void refresh(), activelyRunning ? 3_000 : 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeProject, activeProjectPath, dispatch]);

  const blockForActiveProject = useCallback((requestedProjectId: string): boolean => {
    if (!activePipelineSnapshot || activePipelineSnapshot.project_id === requestedProjectId) return false;
    dispatch({
      type: "SET_PIPELINE_CONFLICT",
      requestedProjectId,
      activeProjectId: activePipelineSnapshot.project_id,
    });
    return true;
  }, [activePipelineSnapshot, dispatch]);

  const captureRaceConflict = useCallback(async (
    requestedProjectId: string,
    error: unknown,
  ): Promise<boolean> => {
    if (!isActivePipelineConflict(error)) return false;
    dispatch({ type: "SET_ERROR", error: t("当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。") });
    const active = await refreshActivePipeline();
    if (active && active.project_id !== requestedProjectId) {
      dispatch({
        type: "SET_PIPELINE_CONFLICT",
        requestedProjectId,
        activeProjectId: active.project_id,
      });
    }
    return true;
  }, [dispatch, refreshActivePipeline]);

  const openSelectedProject = useCallback(
    async (project: ProjectInfo) => {
      if (activeProjectPath === project.path) return;
      if (!await leaveEditor()) return;
      dispatch({
        type: "NAVIGATE",
        page: {
          type: "project-detail",
          projectId: project.id,
          projectPath: project.path,
        },
      });
    },
    [activeProjectPath, dispatch, leaveEditor],
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

  const handleOpenIndependent = useCallback(async (path: string) => {
    try {
      const project = await desktopApi.openProject(path);
      const info = toProjectInfo(project, path);
      dispatch({ type: "ADD_RECENT_PROJECT", project: info });
      await openSelectedProject(info);
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [dispatch, openSelectedProject]);

  const handleRelinkProject = useCallback(async (project: ProjectInfo) => {
    if (activeProjectPath === project.path && !await leaveEditor()) return { kind: "cancelled" as const };
    const candidatePath = await selectProjectDirectory();
    if (!candidatePath) return { kind: "cancelled" as const };
    try {
      const refreshed = await desktopApi.relinkRecentProject({
        projectId: project.id,
        previousPath: project.path,
        candidatePath,
      });
      dispatch({ type: "RELINK_RECENT_PROJECT", project: refreshed, previousPath: project.path });
      if (activeProjectPath === project.path) {
        dispatch({
          type: "NAVIGATE",
          page: { type: "project-detail", projectId: refreshed.id, projectPath: refreshed.path },
        });
      }
      return { kind: "success" as const };
    } catch (error) {
      if (error instanceof DesktopCommandError && error.code === "UI-PROJECT-RELINK-MISMATCH") {
        return {
          kind: "mismatch" as const,
          candidatePath,
          code: error.code,
        };
      }
      const normalized = error instanceof DesktopCommandError ? error.uiError : null;
      return {
        kind: "error" as const,
        code: normalized?.code ?? "UI-PROJECT-RELINK-FAILED",
        message: normalized?.message ?? t("无法验证所选项目位置，原记录未更改。"),
      };
    }
  }, [activeProjectPath, dispatch, leaveEditor]);

  const handleRevealProject = useCallback(async (project: ProjectInfo) => {
    try {
      const result = await desktopApi.openProjectLocation({
        projectId: project.id,
        projectPath: project.path,
        targetType: "project_root",
      });
      if (result.missing) {
        dispatch({ type: "SET_ERROR", error: result.message ?? t("项目目录已移动或删除。") });
      }
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [dispatch]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      if (activeProjectPath === project.path && !await leaveEditor()) return;
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
  }, [activeProjectPath, dispatch, leaveEditor]);

  const requestProjectDeletion = useCallback(async (project: ProjectInfo) => {
    if (activeProjectPath === project.path && !await leaveEditor()) return;
    setDeleteCandidate(project);
    setWorkspaceAction({
      projectId: project.id,
      projectPath: project.path,
      action: "delete_project",
    });
  }, [activeProjectPath, leaveEditor]);

  const handleStart = useCallback(async () => {
    if (!activeProject) return;
    if (blockForActiveProject(activeProject.id)) return;
    try {
      const snapshot = await desktopApi.startPipeline(activeProject.path);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
      dispatch({
        type: "ADD_RECENT_PROJECT",
        project: { ...activeProject, status: "running" },
      });
      setAnnouncement(t("项目“{0}”已开始重建。", activeProject.name));
    } catch (error) {
      if (await captureRaceConflict(activeProject.id, error)) return;
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, blockForActiveProject, captureRaceConflict, dispatch]);

  const handlePause = useCallback(() => {
    if (!activeProject) return;
    setWorkspaceAction({
      projectId: activeProject.id,
      projectPath: activeProject.path,
      action: "pause",
    });
  }, [activeProject]);

  const handleResume = useCallback(async () => {
    if (!activeProject) return;
    if (blockForActiveProject(activeProject.id)) return;
    try {
      const snapshot = await desktopApi.resumePipeline(activeProject.path);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
      dispatch({ type: "ADD_RECENT_PROJECT", project: { ...activeProject, status: snapshot.status } });
      setAnnouncement(t("项目“{0}”已继续重建。", activeProject.name));
    } catch (error) {
      if (await captureRaceConflict(activeProject.id, error)) return;
      dispatch({ type: "SET_ERROR", error: String(error) });
    }
  }, [activeProject, blockForActiveProject, captureRaceConflict, dispatch]);

  const handleCancel = useCallback(() => {
    if (!activeProject) return;
    setWorkspaceAction({
      projectId: activeProject.id,
      projectPath: activeProject.path,
      action: "cancel",
    });
  }, [activeProject]);

  const handleWorkspaceActionCompleted = useCallback(async (receipt: ActionReceiptModel) => {
    setActionReceipt(receipt);
    setAnnouncement(receipt.message);
    if (workspaceAction?.action === "delete_project" && deleteCandidate) {
      dispatch({ type: "REMOVE_RECENT_PROJECT", projectId: deleteCandidate.id });
      if (activeProjectPath === deleteCandidate.path) {
        dispatch({ type: "NAVIGATE", page: { type: "home" } });
      }
      setDeleteCandidate(null);
    } else if (activeProject) {
      try {
        const snapshot = await desktopApi.getPipelineState(activeProject.path);
        dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot });
        dispatch({ type: "ADD_RECENT_PROJECT", project: { ...activeProject, status: snapshot.status } });
      } catch {
        void refreshActivePipeline();
      }
    }
    setWorkspaceAction(null);
    void loadApplicationData();
  }, [activeProject, activeProjectPath, deleteCandidate, dispatch, loadApplicationData, refreshActivePipeline, workspaceAction]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void navigate({ type: "new-project" });
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void handleOpenProject();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [navigate, handleOpenProject]);

  const page = (() => {
    switch (state.page.type) {
      case "home":
        return (
          <HomePage
            engines={state.engines}
            metrics={metrics}
            onOpenProject={() => void handleOpenProject()}
            onRetry={() => void loadApplicationData()}
          />
        );
      case "new-project":
        return <NewProjectPage settings={settings} onOpenSettings={() => setSettingsOpen(true)} />;
      case "project-detail":
        if (editor.session) return <Suspense fallback={<div className="preview-empty" role="status"><SpinnerGap size={28} className="spin" aria-hidden="true" /><span>{t("正在载入")}</span></div>}>
          <ModelEditorPage ref={editor.editorRef} session={editor.session}
            onBack={() => void leaveEditor()} />
        </Suspense>;
        return (
          <ProjectDetailPage
            key={state.page.projectId}
            metrics={metrics}
            activityOpenSignal={workspaceActivitySignal}
            projectId={state.page.projectId}
            projectPath={state.page.projectPath}
          />
        );
    }
  })();

  return (
    <div className={`workspace-shell page-${state.page.type}${editor.session ? " is-model-editing" : ""}`}>
      {state.page.type !== "new-project" ? (
        <ProjectSidebar
          projects={state.recentProjects}
          availability={state.projectAvailability}
          loading={state.recentProjectsLoading}
          loadError={state.recentProjectsError}
          activeProjectPath={activeProjectPath}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((value) => !value)}
          onHome={() => void navigate({ type: "home" })}
          onNewProject={() =>
            void navigate({ type: "new-project" })
          }
          onOpenProject={() => void handleOpenProject()}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectProject={(project) => void openSelectedProject(project)}
          onRevealProject={(project) => void handleRevealProject(project)}
          onRemoveProject={(project) => void handleRemoveProject(project)}
          onDeleteProject={requestProjectDeletion}
          onRetryAvailability={retryProjectAvailability}
          onRelinkProject={handleRelinkProject}
          onOpenIndependent={handleOpenIndependent}
          onRetry={() => void loadApplicationData()}
          engines={state.engines}
          metrics={metrics}
        />
      ) : null}

      <section className="workspace-surface">
        <div className="workspace-header-stack">
          {state.page.type === "home" ? <h1 className="sr-only">{t("项目中心")}</h1> : null}
          {state.page.type === "project-detail" && !editor.session ? (
            <TitleRunBar
              project={activeProject}
              pipelineSnapshot={viewedPipelineSnapshot}
              pipelineConflict={pipelineConflict}
              taskProgress={activeProject ? taskProgressByProject[activeProject.id] ?? null : null}
              updatedAt={viewedPipelineFreshness.updatedAt}
              onHome={() => void navigate({ type: "home" })}
              onEdit={isDesktopRuntime() && activeProject ? () => void editor.open(activeProject) : undefined}
              openingEditor={editor.opening}
              onBlockedAttempt={() => activeProject && blockForActiveProject(activeProject.id)}
              onStart={() => void handleStart()}
              onPause={handlePause}
              onResume={() => void handleResume()}
              onCancel={handleCancel}
              onRevealProject={() => activeProject && void handleRevealProject(activeProject)}
              onRemoveProject={() => activeProject && void handleRemoveProject(activeProject)}
              onDeleteProject={() => activeProject && requestProjectDeletion(activeProject)}
              onViewActivity={() => setWorkspaceActivitySignal((value) => value + 1)}
            />
          ) : null}
        </div>
        <main className="workspace-content">{page}</main>
      </section>

      {settingsOpen && (
        <SettingsDrawer
          engines={state.engines}
          enginesLoading={state.enginesLoading}
          enginesError={state.enginesError}
          version={version}
          settings={settings}
          loadError={settingsError}
          metrics={metrics}
          projectId={activeProject?.id ?? null}
          projectPath={activeProjectPath}
          onClose={() => setSettingsOpen(false)}
          onSettings={setSettings}
          onEngines={(engines) => dispatch({ type: "SET_ENGINES", engines })}
          onError={(error) => dispatch({ type: "SET_ERROR", error })}
          onRetrySettings={() => void loadApplicationData()}
        />
      )}

      {workspaceAction && (
        <WorkspaceActionDialog
          request={workspaceAction}
          onClose={() => {
            setWorkspaceAction(null);
            if (workspaceAction.action === "delete_project") setDeleteCandidate(null);
          }}
          onCompleted={handleWorkspaceActionCompleted}
        />
      )}
      {actionReceipt ? <ActionReceipt receipt={actionReceipt} onDismiss={() => setActionReceipt(null)} /> : null}

      {isUiPreviewMode() ? <div className="preview-mode-label">{t("界面预览 · 示例数据")}</div> : null}

      {state.error && (
        <div className="global-error" role="alert">
          <WarningCircle size={19} weight="fill" />
          <span>{localizeMessage(state.error)}</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_ERROR", error: null })}
            aria-label={t("关闭错误提示")}
          >
            <X size={17} />
          </button>
        </div>
      )}

      {state.loading && (
        <div className="loading-overlay" aria-live="polite">
          <div className="loading-spinner" />
          <p>{t("正在处理…")}</p>
        </div>
      )}
      <StatusAnnouncer message={announcement} />
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
