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
import { useEffect, useRef, useState } from "react";

import { ActivityWorkbench, CheckpointDrawer, PointCloudPreview } from "../components/workspace";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { getStageLabel } from "../localization";
import { confirmRerunStage, desktopApi } from "../services/desktop";
import { PHASES, phaseStatus, phaseStatusLabel, plyActionState, stageStatusLabel } from "./projectTimeline";
import type {
  ArtifactSummary,
  CheckpointSummary,
  FramePreview,
  PipelineStageId,
  PlyPreview,
  Project,
  ProjectStatus,
  SparsePreviewPack,
} from "../types";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
}

function normalizeStatus(status: string): ProjectStatus {
  const value = status.toLowerCase() as ProjectStatus;
  return ["creating", "starting", "ready", "running", "pausing", "paused", "cancelling", "cancelled", "recovering", "completed", "failed"].includes(value)
    ? value
    : "ready";
}

export function ProjectDetailPage({ projectId, projectPath }: ProjectDetailPageProps) {
  const { state, dispatch } = useAppContext();
  const openCmd = useTauriCommand<Project>("open_project");
  const openProject = openCmd.execute;
  const [project, setProject] = useState<Project | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<PipelineStageId | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactSummary | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null);
  const [sparsePreview, setSparsePreview] = useState<SparsePreviewPack | null>(null);
  const [plyPreview, setPlyPreview] = useState<PlyPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [qualityAction, setQualityAction] = useState<"output" | "ply" | null>(null);
  const [recoveringStage, setRecoveringStage] = useState<PipelineStageId | null>(null);
  const [qualityDialogOpen, setQualityDialogOpen] = useState(false);
  const [qualityAccepting, setQualityAccepting] = useState(false);
  const qualityCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!qualityDialogOpen) return;
    const frame = window.requestAnimationFrame(() => qualityCancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [qualityDialogOpen]);

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

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const [artifactResult, checkpointResult] = await Promise.allSettled([
        desktopApi.getProjectArtifacts(projectPath),
        desktopApi.listCheckpoints(projectPath),
      ]);
      if (disposed) return;
      if (artifactResult.status === "fulfilled") {
        setArtifacts(artifactResult.value);
        setSelectedStage((current) => current
          ?? (artifactResult.value.scene_ply.validated
            ? "Export"
            : artifactResult.value.colmap_result.validated
              ? "ColmapValidation"
              : artifactResult.value.frames_manifest.validated
                ? "FrameExtraction"
                : "MediaValidation"));
      }
      if (checkpointResult.status === "fulfilled") setCheckpoints(checkpointResult.value);
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projectPath]);

  const liveSnapshot = project && state.pipelineSnapshot?.project_id === project.id
    ? state.pipelineSnapshot
    : null;
  const pipelineState = liveSnapshot?.state ?? project?.pipeline_state;
  const currentStage = pipelineState?.current_stage ?? project?.current_stage ?? null;
  const latestCheckpointPath = checkpoints[checkpoints.length - 1]?.relative_path ?? null;
  useEffect(() => {
    if (!currentStage) return;
    const current = PHASES.find((phase) =>
      phase.stages.includes(currentStage as PipelineStageId),
    );
    setExpandedPhase(current?.id ?? null);
  }, [currentStage]);

  useEffect(() => {
    if (currentStage) setSelectedStage(currentStage as PipelineStageId);
  }, [currentStage]);

  useEffect(() => {
    if (!selectedStage) return;
    let disposed = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setFramePreview(null);
    setSparsePreview(null);
    setPlyPreview(null);
    const load = async () => {
      try {
        if (["MediaValidation", "FrameExtraction", "ImagePreprocessing"].includes(selectedStage)) {
          const preview = await desktopApi.getFramePreview(projectPath);
          if (!disposed) setFramePreview(preview);
        } else if (["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"].includes(selectedStage)) {
          const preview = await desktopApi.getSparsePreviewPack(projectPath);
          if (!disposed) setSparsePreview(preview);
        } else if (["TrainingPreparation", "BrushTraining", "ModelValidation"].includes(selectedStage)) {
          if (!latestCheckpointPath) throw new Error("训练 Checkpoint 尚未生成。");
          const preview = await desktopApi.inspectPly(projectPath, latestCheckpointPath);
          if (!disposed) setPlyPreview(preview);
        } else {
          const preview = await desktopApi.inspectPly(projectPath);
          if (!disposed) setPlyPreview(preview);
        }
      } catch (error) {
        if (!disposed) setPreviewError(String(error));
      } finally {
        if (!disposed) setPreviewLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [latestCheckpointPath, projectPath, selectedStage]);

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
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const preview = await desktopApi.inspectPly(projectPath, artifacts.scene_ply.relative_path);
      setSelectedStage("Export");
      setFramePreview(null);
      setSparsePreview(null);
      setPlyPreview(preview);
    } catch (error) {
      setPreviewError(String(error));
      dispatch({ type: "SET_ERROR", error: `无法打开 PLY：${String(error)}` });
    } finally {
      setPreviewLoading(false);
      setQualityAction(null);
    }
  };

  const previewCheckpoint = async (checkpoint: CheckpointSummary) => {
    setSelectedStage("BrushTraining");
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPlyPreview(await desktopApi.inspectPly(projectPath, checkpoint.relative_path));
    } catch (error) {
      setPreviewError(String(error));
      dispatch({ type: "SET_ERROR", error: `无法预览 Checkpoint：${String(error)}` });
    } finally {
      setPreviewLoading(false);
    }
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
  const pipelineBusy = ["starting", "running", "pausing", "cancelling", "recovering"].includes(
    liveSnapshot?.status ?? project?.status ?? "ready",
  );

  const recoverFromStage = async (stage: PipelineStageId, status: string) => {
    if (recoveringStage || pipelineBusy) return;
    if (["completed", "skipped"].includes(status)) {
      const confirmed = await confirmRerunStage(getStageLabel(stage));
      if (!confirmed) return;
    }
    setRecoveringStage(stage);
    try {
      const reset = ["failed", "cancelled"].includes(status)
        ? await desktopApi.retryStage(projectPath, stage)
        : await desktopApi.rerunFromStage(projectPath, stage);
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
      dispatch({ type: "SET_ERROR", error: `无法从“${getStageLabel(stage)}”重新运行：${String(error)}` });
    } finally {
      setRecoveringStage(null);
    }
  };
  const acceptQualityRisk = async () => {
    if (qualityAccepting || pipelineBusy) return;
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
                  type="button"
                  className="phase-summary"
                  onClick={() => setExpandedPhase(expanded ? null : phase.id)}
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
                  <div className="stage-list">
                    {phase.stages.map((stage) => {
                      const stageState = pipelineState?.stages[stage] ?? project.pipeline_state.stages[stage];
                      const stageStatus = stageState?.status ?? "pending";
                      const canRecover = ["failed", "cancelled", "completed", "skipped"].includes(stageStatus);
                      return (
                        <div className={`stage-list-item ${selectedStage === stage ? "is-selected" : ""}`} key={stage}>
                          <button type="button" className={`stage-list-row ${selectedStage === stage ? "is-selected" : ""}`} onClick={() => setSelectedStage(stage)}>
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

      {inspectorOpen && <button type="button" className="mobile-drawer-backdrop" aria-label="关闭预览与质量" onClick={() => setInspectorOpen(false)} />}
      <aside className={`inspector-column ${inspectorOpen ? "is-mobile-open" : ""}`}>
        <div className="mobile-inspector-heading">
          <strong>预览与质量</strong>
          <button type="button" className="icon-button" aria-label="关闭预览与质量" onClick={() => setInspectorOpen(false)}><X size={18} /></button>
        </div>
        <section className="preview-panel panel">
          <div className="panel-title">
            <span>真实产物预览</span>
            <span className="panel-subtitle">{selectedStage ? getStageLabel(selectedStage) : currentStageLabel}</span>
          </div>
          {previewLoading ? <div className="preview-empty"><SpinnerGap size={35} className="spin" /><strong>正在读取真实产物</strong><span>解析完成后将上传到 GPU。</span></div>
            : sparsePreview ? <PointCloudPreview points={sparsePreview.points} cameras={sparsePreview.cameras} label={`${sparsePreview.point_count.toLocaleString()} 稀疏点 · ${sparsePreview.registered_images} 相机`} />
              : plyPreview ? <PointCloudPreview points={plyPreview.points} label={`${plyPreview.vertex_count.toLocaleString()} splats · 点模式`} />
                : framePreview && framePreview.items.length > 0 ? <div className="frame-contact-sheet">{framePreview.items.map((path) => <img key={path} src={convertFileSrc(path)} alt="抽取帧缩略图" />)}<span>从 {framePreview.total_frames} 帧中均匀显示 {framePreview.items.length} 帧</span></div>
                  : <div className="preview-empty"><Cube size={42} weight="thin" /><strong>预览尚未生成</strong><span>{previewError ?? "选择已完成阶段后，将在此读取真实产物。"}</span></div>}
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

      <ActivityWorkbench projectPath={projectPath} />
      {qualityDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !qualityAccepting) setQualityDialogOpen(false);
        }}>
          <section
            className="quality-risk-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quality-risk-title"
            aria-describedby="quality-risk-description"
          >
            <Warning size={28} weight="fill" />
            <h2 id="quality-risk-title">仍然使用低于建议质量的重建？</h2>
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
          </section>
        </div>
      )}
      {checkpointOpen && <CheckpointDrawer checkpoints={checkpoints} onClose={() => setCheckpointOpen(false)} onPreview={(checkpoint) => void previewCheckpoint(checkpoint)} onRestore={(checkpoint) => void desktopApi.restoreCheckpoint(projectPath, checkpoint.iteration).then(setCheckpoints).catch((error) => dispatch({ type: "SET_ERROR", error: String(error) }))} onDelete={(checkpoint) => void desktopApi.deleteCheckpoint(projectPath, checkpoint.iteration).then(() => desktopApi.listCheckpoints(projectPath).then(setCheckpoints)).catch((error) => dispatch({ type: "SET_ERROR", error: String(error) }))} onOpen={(checkpoint) => void revealCheckpoint(checkpoint)} />}
    </div>
  );
}
