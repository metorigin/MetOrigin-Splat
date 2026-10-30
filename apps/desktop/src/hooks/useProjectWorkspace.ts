import { listen } from "@tauri-apps/api/event";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { resourceMemory } from "../lib/resourcePresentation";

import {
  selectActivePipelineSnapshot,
  selectProjectPipelineSnapshot,
  useAppContext,
} from "../context";
import { useAsyncResource, useTauriCommand } from "../hooks";
import { getStageLabel } from "../localization";
import { desktopApi, isActivePipelineConflict, isDesktopRuntime } from "../services/desktop";
import { normalizeCommandError } from "../services/errors";
import { isUiPreviewMode } from "../services/uiPreview";
import type {
  ActionReceipt as ActionReceiptModel,
  ArtifactSummary,
  CheckpointSummary,
  PipelineEventEnvelope,
  PipelineStageId,
  Project,
  ProjectStatus,
  ResourceMetrics,
  WorkspaceActionRequest
} from "../types";
import { failedStageId, plyActionState } from "@/pages/projectTimeline";

import type { StagePreview } from "@/components/workspace/workspacePresentation";
import { FRAME_PREVIEW_STAGES, GAUSSIAN_STAGES, SPARSE_PREVIEW_STAGES, TRAINING_PREVIEW_STAGES } from "@/components/workspace/workspacePresentation";
function normalizeStatus(status: string): ProjectStatus {
  const value = status.toLowerCase() as ProjectStatus;
  return ["creating", "starting", "ready", "running", "pausing", "paused", "cancelling", "cancelled", "recovering", "completed", "failed"].includes(value)
    ? value
    : "ready";
}


/** Keeps request generations, task identity and domain operations outside presentation. */
export function useProjectWorkspace(projectId: string, projectPath: string, metrics: ResourceMetrics | null, activityOpenSignal: number) {
  const { state, dispatch } = useAppContext();
  const previewMode = isUiPreviewMode();
  const previewOverlay = previewMode
    ? new URLSearchParams(window.location.search).get("preview-overlay")
    : null;
  const activePipeline = selectActivePipelineSnapshot(state);
  const openCmd = useTauriCommand<Project>("open_project");
  const openProject = openCmd.execute;
  const [project, setProject] = useState<Project | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<PipelineStageId | null>(null);
  const [stageFocus, setStageFocus] = useState<PipelineStageId | null>(null);
  const [previewRelativePath, setPreviewRelativePath] = useState<string | null>(null);
  const [followStage, setFollowStage] = useState(true);
  const artifactResource = useAsyncResource<ArtifactSummary>();
  const checkpointResource = useAsyncResource<CheckpointSummary[]>();
  const previewResource = useAsyncResource<StagePreview>();
  const artifacts = artifactResource.resource.data;
  const checkpoints = checkpointResource.resource.data ?? [];
  const resourceRequest = useRef(0);
  const [checkpointOpen, setCheckpointOpen] = useState(() => previewOverlay === "checkpoint");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(() => previewOverlay === "activity");
  const [qualityAction, setQualityAction] = useState<"output" | "ply" | null>(null);
  const [recoveringStage, setRecoveringStage] = useState<PipelineStageId | null>(null);
  const [qualityDialogOpen, setQualityDialogOpen] = useState(() => previewOverlay === "quality");
  const [qualityAccepting, setQualityAccepting] = useState(false);
  const [activityRefreshSignal, setActivityRefreshSignal] = useState(0);
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceActionRequest | null>(null);
  const [actionReceipt, setActionReceipt] = useState<ActionReceiptModel | null>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activityOpenSignal > 0) setActivityOpen(true);
  }, [activityOpenSignal]);

  useEffect(() => {
    let disposed = false;
    void openProject({ path: projectPath })
      .then((loadedProject) => {
        // Opening can finish after navigation or relocation remounts this owner.
        // Its captured path must not overwrite the newer project's shared index
        // or sequence-zero snapshot after this effect has been disposed.
        if (disposed || !loadedProject) return;
        const normalizedProject = {
          ...loadedProject,
          status: normalizeStatus(loadedProject.status),
        };
        setProject(normalizedProject);
        dispatch({
          type: "SET_PIPELINE_SNAPSHOT",
          snapshot: {
            project_id: normalizedProject.id,
            project_path: projectPath,
            status: normalizedProject.status,
            state: normalizedProject.pipeline_state,
            sequence: 0,
            accepted_at: null,
            started_at: null,
            control_intent: "none",
          },
        });
        dispatch({
          type: "ADD_RECENT_PROJECT",
          recentlyOpened: true,
          project: {
            id: normalizedProject.id,
            name: normalizedProject.name,
            path: projectPath,
            status: normalizedProject.status,
            updated_at: normalizedProject.updated_at,
            stage_label: normalizedProject.current_stage ?? undefined,
          },
        });
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [dispatch, openProject, projectPath]);

  const loadArtifacts = artifactResource.load;
  const loadCheckpoints = checkpointResource.load;
  const refreshWorkspaceResources = useCallback(async () => {
    const requestId = ++resourceRequest.current;
    const [artifactResult] = await Promise.allSettled([
      loadArtifacts(
        `${projectPath}:artifacts:${requestId}`,
        async () => {
          const data = await desktopApi.getProjectArtifacts(projectPath);
          const artifactItems = [
            [t("帧清单"), data.frames_manifest],
            [t("相机重建"), data.colmap_result],
            [t("最终 Splat"), data.scene_ply],
            [t("导出清单"), data.output_manifest],
          ] as const;
          const partialIssues = artifactItems.flatMap(([scope, item]) => item.error ? [{
            scope,
            error: normalizeCommandError(item.error, "get_project_artifacts"),
            retryActionKey: `artifacts:${scope}`,
          }] : []);
          return {
            data,
            completeness: partialIssues.length > 0 ? "partial" as const : "complete" as const,
            partialIssues,
          };
        },
        (error) => normalizeCommandError(error, "get_project_artifacts"),
        { background: true },
      ),
      loadCheckpoints(
        `${projectPath}:checkpoints:${requestId}`,
        () => desktopApi.listCheckpoints(projectPath),
        (error) => normalizeCommandError(error, "list_checkpoints"),
        { background: true },
      ),
    ]);
    if (artifactResult.status === "fulfilled") {
      const data = artifactResult.value;
      setSelectedStage((current) => current
        ?? (data.scene_ply.validated
          ? "Export"
          : data.colmap_result.validated
            ? "ColmapValidation"
            : data.frames_manifest.validated
              ? "FrameExtraction"
              : "MediaValidation"));
    }
  }, [loadArtifacts, loadCheckpoints, projectPath]);

  useEffect(() => {
    void refreshWorkspaceResources();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshWorkspaceResources();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshWorkspaceResources]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<PipelineEventEnvelope>("pipeline://event", ({ payload }) => {
      if (disposed || payload.project_id !== projectId) return;
      setActivityRefreshSignal((current) => Math.max(current + 1, payload.sequence));
      if ([
        "stage_completed",
        "stage_failed",
        "pipeline_completed",
        "pipeline_failed",
        "pipeline_cancelled",
      ].includes(payload.event.kind)) {
        void refreshWorkspaceResources();
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectId, refreshWorkspaceResources]);

  const liveSnapshot = selectProjectPipelineSnapshot(state, project?.id ?? projectId);
  const pipelineState = liveSnapshot?.state ?? project?.pipeline_state;
  // A terminal snapshot deliberately clears current_stage. Do not revive the
  // stage from the project originally opened while training was still running.
  const currentStage = pipelineState ? pipelineState.current_stage : project?.current_stage ?? null;
  const workspaceStatus = liveSnapshot?.status ?? project?.status ?? "ready";
  const workspaceComplete = workspaceStatus === "completed";
  const latestCheckpointPath = checkpoints[checkpoints.length - 1]?.relative_path ?? null;
  // Explicit restore clears current_stage while leaving BrushTraining paused.
  // This is a preview selection, not a replacement for the authoritative stage.
  const pausedStage = Object.values(pipelineState?.stages ?? {}).find((stage) => stage.status === "paused")?.stage_id;
  const awaitingFinalPublication = currentStage !== null
    && ["Export", "PreviewGeneration"].includes(currentStage)
    && artifacts?.scene_ply.exists === false;
  const followedStage = workspaceComplete && artifacts?.scene_ply.validated
    ? "Export"
    : awaitingFinalPublication ? null
      : currentStage ?? pausedStage ?? (artifacts?.scene_ply.validated ? "Export" : null);
  useEffect(() => {
    if (!followStage || !followedStage) return;
    setPreviewRelativePath(null);
    setSelectedStage(followedStage as PipelineStageId);
  }, [followStage, followedStage]);

  // A successful resource refresh can revoke an already installed GPU model.
  // Unmount that viewer instead of treating a missing path as a retained result.
  // Unknown/failed reads retain the last known resource, and live previews may
  // still start before the first checkpoint or final output has been published.
  const finalSourceMissing = artifacts?.scene_ply.exists === false && artifacts.scene_ply.error === null;
  const gaussianSourceMissing = previewRelativePath !== null
    ? previewRelativePath === artifacts?.scene_ply.relative_path
      ? finalSourceMissing
      : checkpointResource.resource.data !== null
        && !checkpoints.some((checkpoint) => checkpoint.relative_path === previewRelativePath && checkpoint.valid)
    : selectedStage !== null && !TRAINING_PREVIEW_STAGES.includes(selectedStage) && finalSourceMissing;

  const sparsePreviewSelected = selectedStage !== null && SPARSE_PREVIEW_STAGES.includes(selectedStage);
  const framePreviewSelected = selectedStage !== null && FRAME_PREVIEW_STAGES.includes(selectedStage);
  // Wait for published manifests. Bind thumbnails to the frame manifest so
  // replacement/removal invalidates them without re-encoding on unrelated polls.
  const sparseArtifact = artifacts?.colmap_result;
  const frameArtifact = artifacts?.frames_manifest;
  const previewRequestKey = selectedStage && !GAUSSIAN_STAGES.includes(selectedStage)
    && (!sparsePreviewSelected || sparseArtifact?.exists)
    && (!framePreviewSelected || frameArtifact?.exists)
    ? JSON.stringify([
      projectId,
      projectPath,
      selectedStage,
      sparsePreviewSelected
        ? [sparseArtifact?.relative_path, sparseArtifact?.size_bytes, sparseArtifact?.updated_at]
        : framePreviewSelected
          ? [frameArtifact?.relative_path, frameArtifact?.exists, frameArtifact?.size_bytes, frameArtifact?.updated_at]
          : previewRelativePath ?? latestCheckpointPath ?? "output",
    ])
    : null;
  const loadPreview = previewResource.load;
  const resetPreview = previewResource.reset;
  const loadSelectedPreview = useCallback(async () => {
    if (!selectedStage || !previewRequestKey) {
      resetPreview();
      return;
    }
    const stageId = selectedStage;
    const requestKey = previewRequestKey;
    if (SPARSE_PREVIEW_STAGES.includes(stageId) || FRAME_PREVIEW_STAGES.includes(stageId)) resetPreview();
    const previewCommand = FRAME_PREVIEW_STAGES.includes(stageId)
      ? "get_frame_preview"
      : SPARSE_PREVIEW_STAGES.includes(stageId)
        ? "get_sparse_preview_pack"
        : "inspect_ply";
    try {
      await loadPreview(
        requestKey,
        async (): Promise<StagePreview> => {
          if (FRAME_PREVIEW_STAGES.includes(stageId)) {
            return {
    requestKey,
    stageId,
    kind: "frame",
    value: await desktopApi.getFramePreview(projectPath,
    projectId),
  };
          }
          if (SPARSE_PREVIEW_STAGES.includes(stageId)) {
            return {
    requestKey,
    stageId,
    kind: "sparse",
    value: await desktopApi.getSparsePreviewPack(projectPath),
  };
          }
          throw new Error(t("该阶段没有可显示的产物。"));
        },
        (error) => normalizeCommandError(error, previewCommand),
      );
    } catch {
      // AsyncResource keeps the last valid preview and exposes the normalized error.
    }
  }, [loadPreview, previewRequestKey, projectId, projectPath, resetPreview, selectedStage]);

  useEffect(() => {
    void loadSelectedPreview();
  }, [loadSelectedPreview]);

  const currentPreviewRequest = previewRequestKey !== null
    && previewResource.resource.requestKey === previewRequestKey;
  const selectedPreview = currentPreviewRequest
    && previewResource.resource.data?.requestKey === previewRequestKey
    ? previewResource.resource.data
    : null;

  const openOutputDirectory = async () => {
    if (qualityAction) return;
    setQualityAction("output");
    try {
      const result = await desktopApi.openProjectLocation({
        projectId,
        projectPath,
        targetType: "output_directory",
      });
      if (result.missing) throw new Error(result.message ?? t("项目目录已移动或删除。"));
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: t("无法打开输出目录：{0}", String(error)) });
    } finally {
      setQualityAction(null);
    }
  };

  const openScenePly = async () => {
    if (qualityAction) return;
    const availability = plyActionState(artifacts?.scene_ply);
    if (!availability.ready || !artifacts) {
      dispatch({ type: "SET_ERROR", error: availability.message });
      return;
    }
    setQualityAction("ply");
    setPreviewRelativePath(artifacts.scene_ply.relative_path);
    setSelectedStage("Export");
    setQualityAction(null);
  };

  const previewCheckpoint = (checkpoint: CheckpointSummary) => {
    setFollowStage(false);
    setPreviewRelativePath(checkpoint.relative_path);
    setSelectedStage("BrushTraining");
  };

  const revealCheckpoint = async (checkpoint: CheckpointSummary) => {
    try {
      const result = await desktopApi.openProjectLocation({
        projectId,
        projectPath,
        targetType: "artifact",
        relativePath: checkpoint.relative_path,
      });
      if (result.missing) throw new Error(result.message ?? t("项目目录已移动或删除。"));
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: t("无法定位 Checkpoint：{0}", String(error)) });
    }
  };
  const currentStageLabel = (liveSnapshot?.status ?? project?.status) === "completed" ? t("全部阶段已完成") : currentStage ? getStageLabel(currentStage) : t("尚未开始");
  const moveStageFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    stages: readonly PipelineStageId[],
    stage: PipelineStageId,
  ) => {
    const index = stages.indexOf(stage);
    let nextIndex = -1;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % stages.length;
    if (event.key === "ArrowUp") nextIndex = (index - 1 + stages.length) % stages.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = stages.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = stages[nextIndex];
    setStageFocus(next);
    const element = document.getElementById(`stage-button-${next}`);
    if (element) element.focus();
    else window.requestAnimationFrame(() => document.getElementById(`stage-button-${next}`)?.focus());
  };
  const pipelineBusy = ["starting", "running", "pausing", "cancelling", "recovering"].includes(
    liveSnapshot?.status ?? project?.status ?? "ready",
  );
  const workspacePaused = workspaceStatus === "paused" || workspaceStatus === "cancelled";
  const workspaceFailed = workspaceStatus === "failed";
  const overallPercent = pipelineState && Number.isFinite(pipelineState.overall_progress)
    ? Math.max(0, Math.min(100, Math.round(pipelineState.overall_progress * 100)))
    : null;
  const failedStage = failedStageId(pipelineState ?? project?.pipeline_state);
  const failureMessage = failedStage ? (pipelineState ?? project?.pipeline_state)?.stages[failedStage]?.error : null;
  const gpuPercent = Math.max(0, Math.min(100, metrics?.gpu?.utilization_percent ?? 0));
  const memory = resourceMemory(metrics);
  const vramPercent = memory.total && memory.used != null
    ? Math.max(0, Math.min(100, memory.used / memory.total * 100)) : 0;
  const cpuPercent = metrics?.cpu_usage_percent != null && Number.isFinite(metrics.cpu_usage_percent)
    ? Math.max(0, Math.min(100, metrics.cpu_usage_percent)) : null;
  const blockForActiveProject = () => {
    if (!activePipeline || activePipeline.project_id === projectId) return false;
    dispatch({
      type: "SET_PIPELINE_CONFLICT",
      requestedProjectId: projectId,
      activeProjectId: activePipeline.project_id,
    });
    dispatch({
      type: "SET_ERROR",
      error: t("当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。当前项目未启动，也未进入队列。"),
    });
    return true;
  };
  const captureRaceConflict = async (error: unknown) => {
    if (!isActivePipelineConflict(error)) return false;
    const active = await desktopApi.getActivePipelineSummary().catch(() => null);
    if (active) {
      dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot: active });
      dispatch({
        type: "SET_PIPELINE_CONFLICT",
        requestedProjectId: projectId,
        activeProjectId: active.project_id,
      });
    }
    dispatch({
      type: "SET_ERROR",
      error: t("活动任务在操作前发生变化；当前项目未启动，也未进入队列。"),
    });
    return true;
  };

  const completeWorkspaceAction = async (receipt: ActionReceiptModel) => {
    const completedAction = workspaceAction;
    setActionReceipt(receipt);
    try {
      await refreshWorkspaceResources();
      const reset = await desktopApi.getPipelineState(projectPath);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: reset });

      if (completedAction?.action === "rerun_stage") {
        const running = await desktopApi.startPipeline(projectPath);
        dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: running });
        setProject((current) => current ? {
          ...current,
          status: running.status,
          pipeline_state: running.state,
          current_stage: running.state.current_stage,
        } : current);
      } else {
        setProject((current) => current ? {
          ...current,
          status: reset.status,
          pipeline_state: reset.state,
          current_stage: reset.state.current_stage,
        } : current);
      }
    } catch (error) {
      if (!(await captureRaceConflict(error))) {
        dispatch({ type: "SET_ERROR", error: String(error) });
      }
    } finally {
      setWorkspaceAction(null);
      setRecoveringStage(null);
    }
  };

  const recoverFromStage = async (stage: PipelineStageId, status: string) => {
    if (recoveringStage || pipelineBusy) return;
    if (blockForActiveProject()) return;
    if (["completed", "skipped"].includes(status)) {
      setRecoveringStage(stage);
      setWorkspaceAction({
        projectId,
        projectPath,
        action: "rerun_stage",
        stageId: stage,
      });
      return;
    }
    setRecoveringStage(stage);
    try {
      const reset = await desktopApi.retryStage(projectPath, stage);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: reset });
      const running = await desktopApi.startPipeline(projectPath);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: running });
      const recentProject = state.recentProjects.find(
        (item) => item.id === projectId || item.path === projectPath,
      );
      if (recentProject) {
        dispatch({
          type: "ADD_RECENT_PROJECT",
          project: {
            ...recentProject,
            status: running.status,
            stage_label: running.state.current_stage ?? undefined,
            updated_at: new Date().toISOString(),
          },
        });
      }
      setProject((current) => current ? {
        ...current,
        status: running.status,
        pipeline_state: running.state,
        current_stage: running.state.current_stage,
      } : current);
    } catch (error) {
      if (await captureRaceConflict(error)) return;
      dispatch({ type: "SET_ERROR", error: t("无法从“{0}”重新运行：{1}", getStageLabel(stage), String(error)) });
    } finally {
      setRecoveringStage(null);
    }
  };
  const acceptQualityRisk = async () => {
    if (qualityAccepting || pipelineBusy) return;
    if (blockForActiveProject()) return;
    setQualityAccepting(true);
    try {
      const reset = await desktopApi.acceptColmapQualityRisk(projectPath);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: reset });
      setQualityDialogOpen(false);
      const running = await desktopApi.startPipeline(projectPath);
      dispatch({ type: "SET_PIPELINE_SNAPSHOT", snapshot: running });
      setProject((current) => current ? {
        ...current,
        status: running.status,
        pipeline_state: running.state,
        current_stage: running.state.current_stage,
      } : current);
    } catch (error) {
      if (await captureRaceConflict(error)) return;
      dispatch({ type: "SET_ERROR", error: t("无法确认 COLMAP 质量风险：{0}", String(error)) });
    } finally {
      setQualityAccepting(false);
    }
  };
  return {
    state,
    previewMode,
    openCmd,
    project,
    expandedPhase,
    setExpandedPhase,
    selectedStage,
    setSelectedStage,
    stageFocus,
    setStageFocus,
    previewRelativePath,
    setPreviewRelativePath,
    setFollowStage,
    artifactResource,
    checkpointResource,
    previewResource,
    artifacts,
    checkpoints,
    checkpointOpen,
    setCheckpointOpen,
    inspectorOpen,
    setInspectorOpen,
    activityOpen,
    setActivityOpen,
    qualityAction,
    recoveringStage,
    setRecoveringStage,
    qualityDialogOpen,
    setQualityDialogOpen,
    qualityAccepting,
    activityRefreshSignal,
    workspaceAction,
    setWorkspaceAction,
    actionReceipt,
    setActionReceipt,
    inspectorCloseRef,
    refreshWorkspaceResources,
    pipelineState,
    currentStage,
    workspaceStatus,
    workspaceComplete,
    latestCheckpointPath,
    followedStage,
    gaussianSourceMissing,
    loadSelectedPreview,
    currentPreviewRequest,
    selectedPreview,
    openOutputDirectory,
    openScenePly,
    previewCheckpoint,
    revealCheckpoint,
    currentStageLabel,
    moveStageFocus,
    pipelineBusy,
    workspacePaused,
    workspaceFailed,
    overallPercent,
    failedStage,
    failureMessage,
    gpuPercent,
    memory,
    vramPercent,
    cpuPercent,
    completeWorkspaceAction,
    recoverFromStage,
    acceptQualityRisk,
  };
}
