import {
  CaretDown,
  CaretUp,
  Check,
  Circle,
  Cube,
  Database,
  Eye,
  FolderOpen,
  ImageSquare,
  Info,
  PauseCircle,
  Play,
  ArrowClockwise,
  SpinnerGap,
  StopCircle,
  Warning,
  X,
  XCircle,
} from "../components/primitives/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";

import { ActionReceipt, AsyncStatus } from "../components";
import { ModalSurface } from "../components/primitives";
import {
  ActivityWorkbench,
  CheckpointDrawer,
  PointCloudPreview,
  WorkspaceActionDialog,
} from "../components/workspace";
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
import { PHASES, failedStageId, phaseProgressPercent, phaseStatus, phaseStatusLabel, plyActionState, stageStatusLabel } from "./projectTimeline";
import type {
  ArtifactSummary,
  ActionReceipt as ActionReceiptModel,
  CheckpointSummary,
  FramePreview,
  PipelineEventEnvelope,
  PipelineStageId,
  Project,
  ProjectStatus,
  ResourceMetrics,
  SparsePreviewPack,
  WorkspaceActionRequest,
} from "../types";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
  metrics?: ResourceMetrics | null;
  activityOpenSignal?: number;
}

type StagePreview =
  | { stageId: PipelineStageId; kind: "frame"; value: FramePreview }
  | { stageId: PipelineStageId; kind: "sparse"; value: SparsePreviewPack };

const GAUSSIAN_STAGES: readonly string[] = ["TrainingPreparation", "BrushTraining", "ModelValidation", "Export", "PreviewGeneration"];
const TRAINING_PREVIEW_STAGES: readonly string[] = ["TrainingPreparation", "BrushTraining", "ModelValidation"];
const GaussianSplatPreview = lazy(() => import("../components/workspace/GaussianSplatPreview").then((module) => ({ default: module.GaussianSplatPreview })));

function ResponsiveInspectorSurface({
  open,
  onClose,
  closeRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLElement>;
  children: ReactNode;
}) {
  if (!open) return <>{children}</>;
  return (
    <ModalSurface
      id="mobile-project-inspector"
      title="预览与质量"
      titleHidden
      className="mobile-inspector-surface"
      onClose={onClose}
      initialFocusRef={closeRef}
    >
      {children}
    </ModalSurface>
  );
}

function normalizeStatus(status: string): ProjectStatus {
  const value = status.toLowerCase() as ProjectStatus;
  return ["creating", "starting", "ready", "running", "pausing", "paused", "cancelling", "cancelled", "recovering", "completed", "failed"].includes(value)
    ? value
    : "ready";
}

export function ProjectDetailPage({ projectId, projectPath, metrics = null, activityOpenSignal = 0 }: ProjectDetailPageProps) {
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
  const qualityCancelRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activityOpenSignal > 0) setActivityOpen(true);
  }, [activityOpenSignal]);

  useEffect(() => {
    void openProject({ path: projectPath })
      .then((loadedProject) => {
        if (!loadedProject) return;
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
            ["帧清单", data.frames_manifest],
            ["相机重建", data.colmap_result],
            ["最终 Splat", data.scene_ply],
            ["导出清单", data.output_manifest],
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
      ),
      loadCheckpoints(
        `${projectPath}:checkpoints:${requestId}`,
        () => desktopApi.listCheckpoints(projectPath),
        (error) => normalizeCommandError(error, "list_checkpoints"),
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
  const currentStage = pipelineState?.current_stage ?? project?.current_stage ?? null;
  const latestCheckpointPath = checkpoints[checkpoints.length - 1]?.relative_path ?? null;
  useEffect(() => {
    if (currentStage && followStage) {
      setPreviewRelativePath(null);
      setSelectedStage(currentStage as PipelineStageId);
    }
  }, [currentStage, followStage]);

  const loadSelectedPreview = useCallback(async () => {
    if (!selectedStage || GAUSSIAN_STAGES.includes(selectedStage)) return;
    const stageId = selectedStage;
    const previewCommand = ["MediaValidation", "FrameExtraction", "ImagePreprocessing"].includes(stageId)
      ? "get_frame_preview"
      : ["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"].includes(stageId)
        ? "get_sparse_preview_pack"
        : "inspect_ply";
    try {
      await previewResource.load(
        `${projectPath}:preview:${stageId}:${previewRelativePath ?? latestCheckpointPath ?? "output"}`,
        async (): Promise<StagePreview> => {
          if (["MediaValidation", "FrameExtraction", "ImagePreprocessing"].includes(stageId)) {
            return { stageId, kind: "frame", value: await desktopApi.getFramePreview(projectPath) };
          }
          if (["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"].includes(stageId)) {
            return { stageId, kind: "sparse", value: await desktopApi.getSparsePreviewPack(projectPath) };
          }
          throw new Error("该阶段没有可显示的产物。");
        },
        (error) => normalizeCommandError(error, previewCommand),
      );
    } catch {
      // AsyncResource keeps the last valid preview and exposes the normalized error.
    }
  }, [latestCheckpointPath, previewRelativePath, previewResource, projectPath, selectedStage]);
  const loadSelectedPreviewRef = useRef(loadSelectedPreview);
  loadSelectedPreviewRef.current = loadSelectedPreview;

  useEffect(() => {
    void loadSelectedPreviewRef.current();
  }, [latestCheckpointPath, previewRelativePath, projectPath, selectedStage]);

  const selectedPreview = previewResource.resource.data?.stageId === selectedStage
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
      if (result.missing) throw new Error(result.message ?? "项目目录已移动或删除。");
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: `无法打开输出目录：${String(error)}` });
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
      if (result.missing) throw new Error(result.message ?? "项目目录已移动或删除。");
    } catch (error) {
      dispatch({ type: "SET_ERROR", error: `无法定位 Checkpoint：${String(error)}` });
    }
  };
  const currentStageLabel = (liveSnapshot?.status ?? project?.status) === "completed" ? "全部阶段已完成" : currentStage ? getStageLabel(currentStage) : "尚未开始";
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
  const workspaceStatus = liveSnapshot?.status ?? project?.status ?? "ready";
  const workspacePaused = workspaceStatus === "paused" || workspaceStatus === "cancelled";
  const workspaceFailed = workspaceStatus === "failed";
  const workspaceComplete = workspaceStatus === "completed";
  const overallPercent = pipelineState && Number.isFinite(pipelineState.overall_progress)
    ? Math.max(0, Math.min(100, Math.round(pipelineState.overall_progress * 100)))
    : null;
  const failedStage = failedStageId(pipelineState ?? project?.pipeline_state);
  const failureMessage = failedStage ? (pipelineState ?? project?.pipeline_state)?.stages[failedStage]?.error : null;
  const gpuPercent = Math.max(0, Math.min(100, metrics?.gpu?.utilization_percent ?? 0));
  const vramPercent = metrics?.gpu?.memory_total_bytes
    ? Math.max(0, Math.min(100, metrics.gpu.memory_used_bytes / metrics.gpu.memory_total_bytes * 100))
    : 0;
  const cpuPercent = Math.max(0, Math.min(100, metrics?.cpu_usage_percent ?? 0));
  const blockForActiveProject = () => {
    if (!activePipeline || activePipeline.project_id === projectId) return false;
    dispatch({
      type: "SET_PIPELINE_CONFLICT",
      requestedProjectId: projectId,
      activeProjectId: activePipeline.project_id,
    });
    dispatch({
      type: "SET_ERROR",
      error: "当前有重建任务尚未结束，请先暂停或结束任务后再开始新的重建。当前项目未启动，也未进入队列。",
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
      error: "活动任务在操作前发生变化；当前项目未启动，也未进入队列。",
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
      dispatch({ type: "SET_ERROR", error: `无法从“${getStageLabel(stage)}”重新运行：${String(error)}` });
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
      dispatch({ type: "SET_ERROR", error: `无法确认 COLMAP 质量风险：${String(error)}` });
    } finally {
      setQualityAccepting(false);
    }
  };
  if (openCmd.loading && !project) {
    return (
      <div className="workspace-loading">
        <SpinnerGap size={24} className="spin" /> 正在加载项目…
      </div>
    );
  }

  if (openCmd.error || !project) {
    return (
      <div className="workspace-empty-state">
        <Info size={28} />
        <h2>无法打开项目</h2>
        <p>{openCmd.error ?? "项目数据不可用。"}</p>
      </div>
    );
  }

  return (
    <div className={`project-workspace-grid workspace-state-${workspaceStatus}`}>
      <div className="mobile-workspace-actions">
        <button type="button" className="button button-secondary" onClick={() => setInspectorOpen(true)}>
          <Eye size={16} /> 预览与质量
        </button>
        <button type="button" className="button button-secondary" onClick={() => setCheckpointOpen(true)}>
          <Database size={16} /> Checkpoint ({checkpoints.length})
        </button>
      </div>
      <div className="project-resource-feedback">
        <AsyncStatus
          resource={artifactResource.resource}
          label="项目产物"
          onRetry={() => void refreshWorkspaceResources()}
        />
        <AsyncStatus
          resource={checkpointResource.resource}
          label="恢复点"
          empty={checkpoints.length === 0}
          onRetry={() => void refreshWorkspaceResources()}
        />
      </div>
      <section className="timeline-panel panel" tabIndex={-1}>
        {state.pipelineError && (
          <div className="pipeline-stale-warning" role="status">
            <Warning size={16} weight="fill" />
            <span>Pipeline 状态更新失败，正在显示最后一次成功获取的数据{state.pipelineUpdatedAt ? `（${new Date(state.pipelineUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}）` : ""}。</span>
          </div>
        )}
        <div className="panel-heading-row">
          <span>里程碑 / 阶段</span>
          <span>状态 / 进度</span>
        </div>
        <div className="pipeline-timeline">
          {PHASES.map((phase, index) => {
            const status = phaseStatus(pipelineState ?? project.pipeline_state, phase);
            const expanded = expandedPhase === phase.id;
            const phaseProgress = phaseProgressPercent(pipelineState ?? project.pipeline_state, phase);
            return (
              <article
                className={`timeline-phase status-${status} ${expanded ? "is-expanded" : ""}`}
                key={phase.id}
              >
                <button
                  id={`phase-summary-${phase.id}`}
                  type="button"
                  className="phase-summary"
                  aria-label={`${index + 1}. ${["素材准备", "相机重建", "模型训练", "结果导出"][index]} · ${phase.label} · ${phaseStatusLabel(status)}`}
                  aria-expanded={expanded}
                  aria-controls={`phase-stage-list-${phase.id}`}
                  onClick={() => {
                    setExpandedPhase(expanded ? null : phase.id);
                    if (!expanded) {
                      const preferred = currentStage && phase.stages.includes(currentStage as PipelineStageId)
                        ? currentStage as PipelineStageId
                        : phase.stages[0];
                      setStageFocus(preferred);
                    }
                  }}
                >
                  <span className="phase-index-icon" aria-hidden="true">
                    {status === "completed" ? (
                      <Check size={16} weight="bold" />
                    ) : ["running", "pausing", "cancelling"].includes(status) ? (
                      <SpinnerGap size={17} className="spin" />
                    ) : status === "failed" ? (
                      <XCircle size={17} weight="fill" />
                    ) : status === "paused" ? (
                      <PauseCircle size={17} weight="fill" />
                    ) : status === "cancelled" ? (
                      <StopCircle size={17} />
                    ) : (
                      <Circle size={17} weight="fill" />
                    )}
                  </span>
                  <span className="phase-copy">
                    <strong><em className="phase-number">{String(index + 1).padStart(2, "0")}</em>{phase.label}</strong>
                    <span>{phase.description}</span>
                  </span>
                  <span className="phase-status-copy">
                    {phaseStatusLabel(status)} · {phaseProgress}%
                  </span>
                  <span className="phase-progress-track" aria-hidden="true"><i style={{ width: `${phaseProgress}%` }} /></span>
                  {expanded ? <CaretUp size={16} /> : <CaretDown size={16} />}
                </button>

                {expanded && (
                  <div id={`phase-stage-list-${phase.id}`} className="stage-list" role="list" aria-labelledby={`phase-summary-${phase.id}`}>
                    {phase.stages.map((stage) => {
                      const stageState = pipelineState?.stages[stage] ?? project.pipeline_state.stages[stage];
                      const stageStatus = stageState?.status ?? "pending";
                      const canRecover = ["failed", "cancelled", "completed", "skipped"].includes(stageStatus);
                      return (
                        <div role="listitem" className={`stage-list-item ${selectedStage === stage ? "is-selected" : ""}`} key={stage}>
                          <button
                            id={`stage-button-${stage}`}
                            type="button"
                            tabIndex={stageFocus === stage || (!stageFocus && phase.stages[0] === stage) ? 0 : -1}
                            aria-current={currentStage === stage ? "step" : undefined}
                            aria-pressed={selectedStage === stage}
                            className={`stage-list-row ${selectedStage === stage ? "is-selected" : ""}`}
                            onFocus={() => setStageFocus(stage)}
                            onKeyDown={(event) => moveStageFocus(event, phase.stages, stage)}
                            onClick={() => { setFollowStage(false); setPreviewRelativePath(null); setSelectedStage(stage); }}
                          >
                            <span className={`stage-dot status-${stageStatus}`} />
                            <span>{getStageLabel(stage)}</span>
                            <span className="stage-list-progress">
                              {stageStatusLabel(stageStatus, stageState?.progress ?? 0)}
                            </span>
                          </button>
                          {selectedStage === stage && canRecover && (
                            <div className="stage-recovery-panel">
                              {stageState?.error && <p role="alert">{stageState.error}</p>}
                              <button
                                type="button"
                                className="button button-secondary"
                                disabled={pipelineBusy || recoveringStage !== null}
                                onClick={() => void recoverFromStage(stage, stageStatus)}
                              >
                                {recoveringStage === stage ? <SpinnerGap size={15} className="spin" />
                                  : ["failed", "cancelled"].includes(stageStatus) ? <ArrowClockwise size={15} /> : <Play size={15} />}
                                {recoveringStage === stage
                                  ? "正在重置并启动…"
                                  : ["failed", "cancelled"].includes(stageStatus)
                                    ? "重试并开始"
                                    : "从此阶段重新运行"}
                              </button>
                              {pipelineBusy && <span>Pipeline 运行期间不可重置阶段</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <ResponsiveInspectorSurface open={inspectorOpen} onClose={() => setInspectorOpen(false)} closeRef={inspectorCloseRef}>
      <aside className={`inspector-column ${inspectorOpen ? "is-mobile-open" : ""}`}>
        <div className="mobile-inspector-heading">
          <strong>预览与质量</strong>
          <button ref={inspectorCloseRef} type="button" className="icon-button" aria-label="关闭预览与质量" onClick={() => setInspectorOpen(false)}><X size={18} /></button>
        </div>
        <section className="preview-panel panel" tabIndex={-1}>
          {!workspaceComplete && <div className="panel-title">
            <span className="panel-subtitle">{selectedStage ? getStageLabel(selectedStage) : currentStageLabel}</span>
            <button type="button" className="preview-reset-button" onClick={() => { setFollowStage(true); setPreviewRelativePath(null); setSelectedStage((currentStage ?? (artifacts?.scene_ply.validated ? "Export" : selectedStage)) as PipelineStageId | null); }}>跟随当前阶段</button>
          </div>}
          {selectedStage && GAUSSIAN_STAGES.includes(selectedStage) ? previewMode ? <div className="preview-empty"><Cube size={40} /><strong>高斯场景预览</strong><p>当前为界面设计示例。请在桌面应用中打开项目查看真实模型与训练预览。</p></div> : <Suspense fallback={<div className="preview-empty">正在启动高斯渲染器…</div>}><GaussianSplatPreview
            key={projectId}
            projectId={projectId}
            projectPath={projectPath}
            relativePath={previewRelativePath ?? (TRAINING_PREVIEW_STAGES.includes(selectedStage) ? latestCheckpointPath : "output/scene.ply")}
            live={TRAINING_PREVIEW_STAGES.includes(selectedStage) && previewRelativePath === null}
            running={pipelineBusy}
          /></Suspense> : <>{previewResource.resource.status !== "stale" && <AsyncStatus
            resource={previewResource.resource}
            label="真实产物预览"
            empty={selectedPreview?.kind === "frame" && selectedPreview.value.items.length === 0}
            onRetry={() => void loadSelectedPreview()}
          />}
          {previewResource.resource.status === "loading" ? <div className="preview-empty"><SpinnerGap size={35} className="spin" /><strong>正在读取真实产物</strong><span>解析完成后将上传到 GPU。</span></div>
            : selectedPreview?.kind === "sparse" && selectedPreview.value.points.length > 0 ? <PointCloudPreview points={selectedPreview.value.points} cameras={selectedPreview.value.cameras} label={`${selectedPreview.value.point_count.toLocaleString()} 稀疏点 · ${selectedPreview.value.registered_images} 相机`} />
              : selectedPreview?.kind === "frame" && selectedPreview.value.items.length > 0 ? <div className="frame-contact-sheet">{selectedPreview.value.items.map((path) => <img key={path} src={convertFileSrc(path)} alt="抽取帧缩略图" />)}<span>从 {selectedPreview.value.total_frames} 帧中均匀显示 {selectedPreview.value.items.length} 帧</span></div>
                : <div className="preview-empty preview-scene-placeholder"><span className="empty-scene-icon"><Cube size={36} /></span><strong>预览尚未生成</strong><span>选择已完成阶段后，将在此读取真实产物。</span></div>}</>}
        </section>

        <div className="workspace-inspector-stack">
        <section className="task-status-card panel" aria-labelledby="task-status-heading">
          <div className="task-status-heading">
            <div><h2 id="task-status-heading">{workspaceFailed ? "错误与恢复" : workspaceComplete ? "重建完成" : "任务监控"}</h2><p>{currentStageLabel}</p></div>
            <span className={`status-pill status-${workspaceStatus}`}><i />{workspaceFailed ? "已阻塞" : workspaceComplete ? "已完成" : workspacePaused ? "已暂停" : pipelineBusy ? "处理中" : "等待中"}</span>
          </div>
          {workspaceFailed ? (
            <div className="task-error-card" role="alert">
              <div className="task-error-message">
                <strong>{failureMessage ?? "任务执行失败，请查看日志了解详情。"}</strong>
                <p>{failedStage ? `${getStageLabel(failedStage)}阶段中断。修复问题后可从此阶段重试。` : "未收到失败阶段信息，请先查看活动记录。"}</p>
                <span>{`失败阶段 · ${failedStage ?? "未知"}`}</span>
              </div>
              <div className="task-error-actions">
                <button type="button" className="button button-primary" onClick={() => failedStage && void recoverFromStage(failedStage, "failed")} disabled={!failedStage || pipelineBusy || recoveringStage !== null}>重试失败阶段</button>
                <button type="button" className="button button-secondary" onClick={() => setCheckpointOpen(true)} disabled={checkpoints.length === 0}>查看可用检查点</button>
              </div>
            </div>
          ) : (
            <div className="task-progress-card">
              <strong>{workspaceComplete ? "重建已完成" : workspacePaused ? "任务已暂停" : currentStageLabel}</strong>
              <b>{overallPercent == null ? "—" : `${overallPercent}%`}</b>
              <span className="progress-track" aria-hidden="true"><span style={{ width: `${overallPercent ?? 0}%` }} /></span>
              <p>{workspaceComplete ? "处理阶段已完成，可查看产物与质量报告。" : workspacePaused ? `已保留 ${checkpoints.length} 个检查点，继续前将重新校验产物。` : `${currentStageLabel} · ${overallPercent == null ? "等待进度更新" : `已完成 ${overallPercent}%`}`}</p>
            </div>
          )}
        </section>

        <section className="quality-panel panel">
          <div className="panel-title">当前质量</div>
          {artifacts?.colmap_validation && (
            <div className={`colmap-quality-decision decision-${artifacts.colmap_validation.decision}`} role="status">
              <div>
                <strong>
                  {artifacts.colmap_validation.decision === "pass" && "COLMAP 质量通过"}
                  {artifacts.colmap_validation.decision === "accepted_with_warning" && "已接受 COLMAP 质量风险"}
                  {artifacts.colmap_validation.decision === "requires_confirmation" && "模型可训练，但需要确认风险"}
                  {artifacts.colmap_validation.decision === "blocked" && "模型不满足训练硬条件"}
                </strong>
                <span>
                  最大匹配连通分量 {(artifacts.colmap_validation.largest_component_coverage * 100).toFixed(1)}%
                  {artifacts.colmap_validation.automatic_fallbacks_exhausted ? " · 自动回退已用尽" : ""}
                </span>
              </div>
              {artifacts.colmap_validation.decision === "requires_confirmation" && (
                <button
                  type="button"
                  className="button button-warning"
                  disabled={pipelineBusy || qualityAccepting}
                  onClick={() => setQualityDialogOpen(true)}
                >
                  <Warning size={16} weight="fill" /> 仍然开始训练
                </button>
              )}
              {artifacts.colmap_validation.decision === "blocked" && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={pipelineBusy || recoveringStage !== null}
                  onClick={() => void recoverFromStage(
                    "FrameExtraction",
                    pipelineState?.stages.FrameExtraction?.status ?? "completed",
                  )}
                >
                  <ArrowClockwise size={16} /> 重新准备素材并重建
                </button>
              )}
            </div>
          )}
          {artifacts?.colmap_attempts && artifacts.colmap_attempts.length > 0 && (
            <details className="colmap-attempts">
              <summary>自动重建尝试（{artifacts.colmap_attempts.length}）</summary>
              <ol>
                {artifacts.colmap_attempts.map((attempt) => (
                  <li key={attempt.id} className={`attempt-${attempt.status}`}>
                    <strong>{attempt.id}</strong>
                    <span>{attempt.matching_strategy} · {attempt.mapper}</span>
                    <span>
                      {attempt.model_info
                        ? `${attempt.model_info.registered_images} 张注册 · ${attempt.model_info.point_count.toLocaleString()} 点 · ${attempt.model_info.mean_reprojection_error.toFixed(3)} px`
                        : attempt.error ?? "未生成可分析模型"}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <div className="quality-metric-grid">
            <div><strong>{artifacts?.registered_images != null && artifacts.total_images ? `${(artifacts.registered_images / artifacts.total_images * 100).toFixed(1)}%` : "—"}</strong><span>图像注册率</span></div>
            <div><strong>{(artifacts?.splat_count ?? artifacts?.sparse_points)?.toLocaleString() ?? "—"}</strong><span>场景点数</span></div>
            <div><strong>{artifacts?.mean_reprojection_error != null ? `${artifacts.mean_reprojection_error.toFixed(3)} px` : "—"}</strong><span>重投影误差</span></div>
          </div>
          <div className="quality-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void openOutputDirectory()}
              disabled={qualityAction !== null}
              title="打开项目的输出目录"
            >
              {qualityAction === "output" ? <SpinnerGap size={17} className="spin" /> : <FolderOpen size={17} />} 打开输出目录
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={!artifacts?.scene_ply.validated}
              disabled={qualityAction !== null}
              title={plyActionState(artifacts?.scene_ply).message}
              onClick={() => void openScenePly()}
            >
              {qualityAction === "ply" ? <SpinnerGap size={17} className="spin" /> : <ImageSquare size={17} />} 打开 PLY
            </button>
            <button type="button" className="button button-secondary" title={checkpoints.length === 0 ? "Brush 训练开始后将在这里生成恢复点" : `查看 ${checkpoints.length} 个 Checkpoint`} onClick={() => setCheckpointOpen(true)}><Database size={17} /> Checkpoint ({checkpoints.length})</button>
          </div>
        </section>
        <section className="resource-monitor-card panel" aria-labelledby="resource-monitor-heading">
          <div className="task-status-heading"><h3 id="resource-monitor-heading">资源占用</h3></div>
          <div className="resource-meter"><span>GPU { `${metrics?.gpu?.utilization_percent?.toFixed(0) ?? "—"}%${metrics?.gpu?.temperature_celsius != null ? ` · ${metrics.gpu.temperature_celsius.toFixed(0)}°C` : ""}`}</span><span className="progress-track"><span style={{ width: `${gpuPercent}%` }} /></span></div>
          <div className="resource-meter"><span>VRAM { metrics?.gpu ? `${(metrics.gpu.memory_used_bytes / 1024 / 1024 / 1024).toFixed(1)} / ${(metrics.gpu.memory_total_bytes / 1024 / 1024 / 1024).toFixed(0)} GB` : "尚未测量"}</span><span className="progress-track is-vram"><span style={{ width: `${vramPercent}%` }} /></span></div>
          <div className="resource-meter"><span>CPU { metrics ? `${metrics.cpu_usage_percent.toFixed(0)}%` : "尚未测量"}</span><span className="progress-track is-cpu"><span style={{ width: `${cpuPercent}%` }} /></span></div>
        </section>
        {artifacts?.latest_checkpoint ? <div className="recent-checkpoint-card"><span>最近检查点</span><strong>{artifacts.latest_checkpoint.iteration.toLocaleString()} step</strong><small>{new Date(artifacts.latest_checkpoint.created_at).toLocaleString("zh-CN")}</small></div> : null}
        <div className="workspace-background-note">{!workspaceComplete && <p>任务可在应用内后台运行。关闭应用前，请先暂停并确认恢复点。</p>}<button type="button" className="button button-secondary" onClick={() => setActivityOpen(true)}>查看日志与活动</button><button type="button" className="button button-subtle" onClick={() => setQualityDialogOpen(true)}>质量检查详情</button></div>
        </div>
      </aside>
      </ResponsiveInspectorSurface>

      {activityOpen && <ModalSurface id="workspace-activity" title="训练日志与活动" titleHidden className="workspace-activity-drawer" onClose={() => setActivityOpen(false)}>
        <header><div><strong>训练日志与活动</strong><span>保留当前项目的真实事件、诊断与错误上下文</span></div><button type="button" className="icon-button" onClick={() => setActivityOpen(false)} aria-label="关闭日志"><X size={18} /></button></header>
        <ActivityWorkbench
          projectPath={projectPath}
          selectedStage={selectedStage}
          onSelectStage={(stageId) => { setFollowStage(false); setPreviewRelativePath(null); setSelectedStage(stageId as PipelineStageId); }}
          refreshSignal={activityRefreshSignal}
        />
      </ModalSurface>}
      {qualityDialogOpen && (
        <ModalSurface
          id="quality-risk-dialog"
          title="质量评估结果"
          titleHidden
          className="quality-risk-dialog"
          ariaDescribedBy="quality-risk-description"
          busy={qualityAccepting}
          onClose={() => setQualityDialogOpen(false)}
          initialFocusRef={qualityCancelRef}
        >
            <h2 aria-hidden="true">质量评估结果</h2>
            <p id="quality-risk-description" className="sr-only">
              查看当前模型的已测量指标、检查结果与继续训练前的风险。
            </p>
            <section className="quality-result-metrics" aria-label="质量指标">
              <div><span>已注册图像</span><strong>{artifacts?.registered_images ?? "—"} / {artifacts?.total_images ?? "—"}</strong></div>
              <div><span>场景点数</span><strong>{(artifacts?.splat_count ?? artifacts?.sparse_points)?.toLocaleString() ?? "—"}</strong></div>
              <div><span>重投影误差</span><strong>{artifacts?.mean_reprojection_error != null ? `${artifacts.mean_reprojection_error.toFixed(3)} px` : "—"}</strong></div>
            </section>
            <section className="quality-recommendations">
              <h3>模型检查</h3>
              {artifacts?.colmap_validation?.checks.length ? artifacts.colmap_validation.checks.map((check) => <article key={check.name}><div><strong>{check.name}</strong><span>{check.detail}</span></div><span className={`status-pill ${check.passed ? "status-completed" : "status-failed"}`}><i />{check.passed ? "通过" : "需处理"}</span></article>) : <p>质量报告尚未生成。完成相机重建后会在这里显示实际检查结果。</p>}
            </section>
            <div className="dialog-actions">
              <button
                ref={qualityCancelRef}
                type="button"
                className="button button-secondary"
                disabled={qualityAccepting}
                onClick={() => setQualityDialogOpen(false)}
              >
                关闭
              </button>
              {artifacts?.colmap_validation?.decision === "requires_confirmation" ? <button
                type="button"
                className="button button-primary"
                disabled={qualityAccepting || pipelineBusy}
                onClick={() => void acceptQualityRisk()}
              >
                {qualityAccepting ? <SpinnerGap size={16} className="spin" /> : <Warning size={16} />}
                确认风险并继续
              </button> : null}
            </div>
        </ModalSurface>
      )}
      {checkpointOpen && (
        <CheckpointDrawer
          checkpoints={checkpoints}
          onClose={() => setCheckpointOpen(false)}
          onPreview={(checkpoint) => void previewCheckpoint(checkpoint)}
          onRestore={(checkpoint) => setWorkspaceAction({
            projectId,
            projectPath,
            action: "restore_checkpoint",
            checkpointIteration: checkpoint.iteration,
          })}
          onDelete={(checkpoint) => setWorkspaceAction({
            projectId,
            projectPath,
            action: "delete_checkpoint",
            checkpointIteration: checkpoint.iteration,
          })}
          onOpen={(checkpoint) => void revealCheckpoint(checkpoint)}
        />
      )}
      {workspaceAction && (
        <WorkspaceActionDialog
          request={workspaceAction}
          onClose={() => {
            setWorkspaceAction(null);
            setRecoveringStage(null);
          }}
          onCompleted={completeWorkspaceAction}
        />
      )}
      {actionReceipt ? (
        <ActionReceipt receipt={actionReceipt} onDismiss={() => setActionReceipt(null)} />
      ) : null}
    </div>
  );
}
