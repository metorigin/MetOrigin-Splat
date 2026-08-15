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
} from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { PHASES, phaseStatus, phaseStatusLabel, plyActionState, stageStatusLabel } from "./projectTimeline";
import type {
  ArtifactSummary,
  ActionReceipt as ActionReceiptModel,
  CheckpointSummary,
  FramePreview,
  PipelineEventEnvelope,
  PipelineStageId,
  PlyPreview,
  Project,
  ProjectStatus,
  SparsePreviewPack,
  WorkspaceActionRequest,
} from "../types";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
}

type StagePreview =
  | { stageId: PipelineStageId; kind: "frame"; value: FramePreview }
  | { stageId: PipelineStageId; kind: "sparse"; value: SparsePreviewPack }
  | { stageId: PipelineStageId; kind: "ply"; value: PlyPreview };

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

export function ProjectDetailPage({ projectId, projectPath }: ProjectDetailPageProps) {
  const { state, dispatch } = useAppContext();
  const activePipeline = selectActivePipelineSnapshot(state);
  const openCmd = useTauriCommand<Project>("open_project");
  const openProject = openCmd.execute;
  const [project, setProject] = useState<Project | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<PipelineStageId | null>(null);
  const [stageFocus, setStageFocus] = useState<PipelineStageId | null>(null);
  const [previewRelativePath, setPreviewRelativePath] = useState<string | null>(null);
  const artifactResource = useAsyncResource<ArtifactSummary>();
  const checkpointResource = useAsyncResource<CheckpointSummary[]>();
  const previewResource = useAsyncResource<StagePreview>();
  const artifacts = artifactResource.resource.data;
  const checkpoints = checkpointResource.resource.data ?? [];
  const resourceRequest = useRef(0);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [qualityAction, setQualityAction] = useState<"output" | "ply" | null>(null);
  const [recoveringStage, setRecoveringStage] = useState<PipelineStageId | null>(null);
  const [qualityDialogOpen, setQualityDialogOpen] = useState(false);
  const [qualityAccepting, setQualityAccepting] = useState(false);
  const [activityRefreshSignal, setActivityRefreshSignal] = useState(0);
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceActionRequest | null>(null);
  const [actionReceipt, setActionReceipt] = useState<ActionReceiptModel | null>(null);
  const qualityCancelRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);

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
    if (!currentStage) return;
    const current = PHASES.find((phase) =>
      phase.stages.includes(currentStage as PipelineStageId),
    );
    setExpandedPhase(current?.id ?? null);
    setStageFocus(currentStage as PipelineStageId);
  }, [currentStage]);

  useEffect(() => {
    if (currentStage) {
      setPreviewRelativePath(null);
      setSelectedStage(currentStage as PipelineStageId);
    }
  }, [currentStage]);

  const loadSelectedPreview = useCallback(async () => {
    if (!selectedStage) return;
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
          if (["TrainingPreparation", "BrushTraining", "ModelValidation"].includes(stageId)) {
            const checkpointPath = previewRelativePath ?? latestCheckpointPath;
            if (!checkpointPath) throw new Error("训练 Checkpoint 尚未生成。");
            return { stageId, kind: "ply", value: await desktopApi.inspectPly(projectPath, checkpointPath) };
          }
          return {
            stageId,
            kind: "ply",
            value: await desktopApi.inspectPly(projectPath, previewRelativePath ?? undefined),
          };
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
  const currentStageLabel = currentStage ? getStageLabel(currentStage) : "尚未开始";
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
  const blockForActiveProject = () => {
    if (!activePipeline || activePipeline.project_id === projectId) return false;
    dispatch({
      type: "SET_PIPELINE_CONFLICT",
      requestedProjectId: projectId,
      activeProjectId: activePipeline.project_id,
    });
    dispatch({
      type: "SET_ERROR",
      error: "另一个项目正在运行；当前项目未启动，也未进入队列。请返回活动项目查看状态。",
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
    <div className="project-workspace-grid">
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
      <section className="timeline-panel panel">
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
            return (
              <article
                className={`timeline-phase status-${status} ${expanded ? "is-expanded" : ""}`}
                key={phase.id}
              >
                <button
                  id={`phase-summary-${phase.id}`}
                  type="button"
                  className="phase-summary"
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
                    <strong>{index + 1}. {phase.label}</strong>
                    <span>{phase.description}</span>
                  </span>
                  <span className="phase-status-copy">
                    {phaseStatusLabel(status)}
                  </span>
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
                            onClick={() => { setPreviewRelativePath(null); setSelectedStage(stage); }}
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
        <section className="preview-panel panel">
          <div className="panel-title">
            <span>真实产物预览</span>
            <span className="panel-subtitle">{selectedStage ? getStageLabel(selectedStage) : currentStageLabel}</span>
          </div>
          <AsyncStatus
            resource={previewResource.resource}
            label="真实产物预览"
            empty={selectedPreview?.kind === "frame" && selectedPreview.value.items.length === 0}
            onRetry={() => void loadSelectedPreview()}
          />
          {previewResource.resource.status === "loading" ? <div className="preview-empty"><SpinnerGap size={35} className="spin" /><strong>正在读取真实产物</strong><span>解析完成后将上传到 GPU。</span></div>
            : selectedPreview?.kind === "sparse" ? <PointCloudPreview points={selectedPreview.value.points} cameras={selectedPreview.value.cameras} label={`${selectedPreview.value.point_count.toLocaleString()} 稀疏点 · ${selectedPreview.value.registered_images} 相机`} />
              : selectedPreview?.kind === "ply" ? <PointCloudPreview points={selectedPreview.value.points} label={`${selectedPreview.value.vertex_count.toLocaleString()} splats · 点模式`} />
                : selectedPreview?.kind === "frame" && selectedPreview.value.items.length > 0 ? <div className="frame-contact-sheet">{selectedPreview.value.items.map((path) => <img key={path} src={convertFileSrc(path)} alt="抽取帧缩略图" />)}<span>从 {selectedPreview.value.total_frames} 帧中均匀显示 {selectedPreview.value.items.length} 帧</span></div>
                  : <div className="preview-empty"><Cube size={42} weight="thin" /><strong>预览尚未生成</strong><span>选择已完成阶段后，将在此读取真实产物。</span></div>}
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
                  <ArrowClockwise size={16} /> 使用增强策略重新重建
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
            <div><span>注册图像</span><strong>{artifacts?.registered_images != null && artifacts.total_images != null ? `${artifacts.registered_images} / ${artifacts.total_images}` : "尚未测量"}</strong></div>
            <div><span>注册率</span><strong>{artifacts?.registered_images != null && artifacts.total_images ? `${(artifacts.registered_images / artifacts.total_images * 100).toFixed(1)}%` : "尚未测量"}</strong></div>
            <div><span>稀疏点</span><strong>{artifacts?.sparse_points?.toLocaleString() ?? "尚未测量"}</strong></div>
            <div><span>重投影误差</span><strong>{artifacts?.mean_reprojection_error != null ? `${artifacts.mean_reprojection_error.toFixed(3)} px` : "尚未测量"}</strong></div>
            <div><span>Checkpoint</span><strong>{artifacts?.latest_checkpoint ? `${artifacts.latest_checkpoint.iteration.toLocaleString()} step` : "尚未生成"}</strong></div>
            <div><span>最终 Splat</span><strong>{artifacts?.splat_count?.toLocaleString() ?? "尚未测量"}</strong></div>
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
      </aside>
      </ResponsiveInspectorSurface>

      <ActivityWorkbench
        projectPath={projectPath}
        selectedStage={selectedStage}
        onSelectStage={(stageId) => { setPreviewRelativePath(null); setSelectedStage(stageId as PipelineStageId); }}
        refreshSignal={activityRefreshSignal}
      />
      {qualityDialogOpen && (
        <ModalSurface
          id="quality-risk-dialog"
          title="仍然使用低于建议质量的重建？"
          titleHidden
          className="quality-risk-dialog"
          ariaDescribedBy="quality-risk-description"
          busy={qualityAccepting}
          onClose={() => setQualityDialogOpen(false)}
          initialFocusRef={qualityCancelRef}
        >
            <Warning size={28} weight="fill" />
            <h2 aria-hidden="true">仍然使用低于建议质量的重建？</h2>
            <p id="quality-risk-description">
              当前模型满足最低训练条件，但可能只覆盖场景的一部分。确认只绑定当前稀疏模型；模型变化后会自动失效，报告会永久保留“已接受风险”状态。
            </p>
            <ul>
              {artifacts?.colmap_validation?.checks
                .filter((check) => !check.passed)
                .map((check) => <li key={check.name}>{check.detail}</li>)}
            </ul>
            <div className="dialog-actions">
              <button
                ref={qualityCancelRef}
                type="button"
                className="button button-secondary"
                disabled={qualityAccepting}
                onClick={() => setQualityDialogOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button button-warning"
                disabled={qualityAccepting}
                onClick={() => void acceptQualityRisk()}
              >
                {qualityAccepting ? <SpinnerGap size={16} className="spin" /> : <Warning size={16} />}
                确认风险并继续
              </button>
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
