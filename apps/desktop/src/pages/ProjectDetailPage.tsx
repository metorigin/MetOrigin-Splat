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
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { ActivityWorkbench, CheckpointDrawer, PointCloudPreview } from "../components/workspace";
import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { getStageLabel } from "../localization";
import { desktopApi, openDirectory } from "../services/desktop";
import type {
  ArtifactSummary,
  CheckpointSummary,
  FramePreview,
  PipelineStageId,
  PlyPreview,
  Project,
  ProjectStatus,
  SparsePreviewPack,
  StageStatus,
} from "../types";

interface ProjectDetailPageProps {
  projectId: string;
  projectPath: string;
}

interface PhaseDefinition {
  id: string;
  label: string;
  description: string;
  stages: PipelineStageId[];
}

const PHASES: PhaseDefinition[] = [
  {
    id: "media",
    label: "素材准备",
    description: "视频解析、帧提取、图像预处理",
    stages: ["MediaValidation", "FrameExtraction", "ImagePreprocessing"],
  },
  {
    id: "camera",
    label: "相机重建",
    description: "COLMAP 相机轨迹与稀疏点云",
    stages: [
      "ColmapFeatureExtraction",
      "ColmapMatching",
      "ColmapMapping",
      "ColmapValidation",
    ],
  },
  {
    id: "training",
    label: "模型训练",
    description: "3D Gaussian Splat 优化与验证",
    stages: ["TrainingPreparation", "BrushTraining", "ModelValidation"],
  },
  {
    id: "export",
    label: "结果导出",
    description: "生成 scene.ply 与预览清单",
    stages: ["Export", "PreviewGeneration"],
  },
];

function normalizeStatus(status: string): ProjectStatus {
  const value = status.toLowerCase() as ProjectStatus;
  return ["creating", "starting", "ready", "running", "pausing", "paused", "cancelling", "cancelled", "recovering", "completed", "failed"].includes(value)
    ? value
    : "ready";
}

function phaseStatus(pipelineState: Project["pipeline_state"], phase: PhaseDefinition): StageStatus {
  const states = phase.stages.map(
    (stage) => pipelineState.stages[stage]?.status ?? "pending",
  );
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  if (states.includes("paused")) return "paused";
  if (states.every((status) => status === "completed" || status === "skipped")) {
    return "completed";
  }
  return "pending";
}

export function ProjectDetailPage({ projectPath }: ProjectDetailPageProps) {
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
    if (!project?.current_stage) return;
    const current = PHASES.find((phase) =>
      phase.stages.includes(project.current_stage as PipelineStageId),
    );
    setExpandedPhase(current?.id ?? null);
  }, [project?.current_stage]);

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
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projectPath]);

  const liveSnapshot = project && state.pipelineSnapshot?.project_id === project.id
    ? state.pipelineSnapshot
    : null;
  const pipelineState = liveSnapshot?.state ?? project?.pipeline_state;
  const currentStage = pipelineState?.current_stage ?? project?.current_stage ?? null;
  const latestCheckpointPath = checkpoints[checkpoints.length - 1]?.relative_path ?? null;
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
  const currentStageLabel = currentStage ? getStageLabel(currentStage) : "尚未开始";
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
        <button type="button" className="button button-secondary" disabled={checkpoints.length === 0} onClick={() => setCheckpointOpen(true)}>
          <Database size={16} /> Checkpoint
        </button>
      </div>
      <section className="timeline-panel panel">
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
                    ) : status === "running" ? (
                      <SpinnerGap size={17} className="spin" />
                    ) : (
                      <Circle size={17} weight="fill" />
                    )}
                  </span>
                  <span className="phase-copy">
                    <strong>{index + 1}. {phase.label}</strong>
                    <span>{phase.description}</span>
                  </span>
                  <span className="phase-status-copy">
                    {status === "completed"
                      ? "已完成"
                      : status === "running"
                        ? "运行中"
                        : status === "failed"
                          ? "失败"
                          : "等待中"}
                  </span>
                  {expanded ? <CaretUp size={16} /> : <CaretDown size={16} />}
                </button>

                {expanded && (
                  <div className="stage-list">
                    {phase.stages.map((stage) => {
                      const stageState = pipelineState?.stages[stage] ?? project.pipeline_state.stages[stage];
                      const stageStatus = stageState?.status ?? "pending";
                      return (
                        <button type="button" className={`stage-list-row ${selectedStage === stage ? "is-selected" : ""}`} key={stage} onClick={() => setSelectedStage(stage)}>
                          <span className={`stage-dot status-${stageStatus}`} />
                          <span>{getStageLabel(stage)}</span>
                          <span className="stage-list-progress">
                            {stageStatus === "completed"
                              ? "已完成"
                              : stageStatus === "running"
                                ? `${Math.round((stageState?.progress ?? 0) * 100)}%`
                                : "—"}
                          </span>
                        </button>
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
              onClick={() => void openDirectory(`${projectPath}\\output`)}
            >
              <FolderOpen size={17} /> 打开输出目录
            </button>
            <button type="button" className="button button-secondary" disabled={!artifacts?.scene_ply.validated} onClick={() => void openDirectory(`${projectPath}\\output\\scene.ply`)}>
              <ImageSquare size={17} /> 打开 PLY
            </button>
            <button type="button" className="button button-secondary" disabled={checkpoints.length === 0} onClick={() => setCheckpointOpen(true)}><Database size={17} /> Checkpoint</button>
          </div>
        </section>
      </aside>

      <ActivityWorkbench projectPath={projectPath} />
      {checkpointOpen && <CheckpointDrawer checkpoints={checkpoints} onClose={() => setCheckpointOpen(false)} onPreview={(checkpoint) => { setSelectedStage("BrushTraining"); void desktopApi.inspectPly(projectPath, checkpoint.relative_path).then(setPlyPreview); }} onRestore={(checkpoint) => void desktopApi.restoreCheckpoint(projectPath, checkpoint.iteration).then(setCheckpoints).catch((error) => dispatch({ type: "SET_ERROR", error: String(error) }))} onDelete={(checkpoint) => void desktopApi.deleteCheckpoint(projectPath, checkpoint.iteration).then(() => desktopApi.listCheckpoints(projectPath).then(setCheckpoints)).catch((error) => dispatch({ type: "SET_ERROR", error: String(error) }))} onOpen={(checkpoint) => void openDirectory(`${projectPath}\\${checkpoint.relative_path.replaceAll("/", "\\")}`)} />}
    </div>
  );
}
