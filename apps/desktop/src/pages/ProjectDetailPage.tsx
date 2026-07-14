import {
  CaretDown,
  CaretUp,
  Check,
  CheckCircle,
  Circle,
  Cube,
  FolderOpen,
  ImageSquare,
  Info,
  SpinnerGap,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { useAppContext } from "../context";
import { useTauriCommand } from "../hooks";
import { getPresetLabel, getStageLabel } from "../localization";
import { openDirectory } from "../services/desktop";
import type {
  MediaAnalysis,
  PipelineStageId,
  Project,
  ProjectStatus,
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
  return ["creating", "ready", "running", "paused", "completed", "failed"].includes(value)
    ? value
    : "ready";
}

function phaseStatus(project: Project, phase: PhaseDefinition): StageStatus {
  const states = phase.stages.map(
    (stage) => project.pipeline_state.stages[stage]?.status ?? "pending",
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
  const { dispatch } = useAppContext();
  const openCmd = useTauriCommand<Project>("open_project");
  const analyzeCmd = useTauriCommand<MediaAnalysis>("analyze_media");
  const openProject = openCmd.execute;
  const analyzeMedia = analyzeCmd.execute;
  const [project, setProject] = useState<Project | null>(null);
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);

  useEffect(() => {
    void openProject({ path: projectPath })
      .then((loadedProject) => {
        if (!loadedProject) return;
        const normalizedProject = {
          ...loadedProject,
          status: normalizeStatus(loadedProject.status),
        };
        setProject(normalizedProject);
        dispatch({ type: "SET_PIPELINE_STATE", state: normalizedProject.pipeline_state });
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
    if (project?.source?.type !== "Video") return;
    const sourcePath = `${projectPath}\\source\\${project.source.filename}`;
    void analyzeMedia({ path: sourcePath }).catch(() => undefined);
  }, [analyzeMedia, project?.source, projectPath]);

  useEffect(() => {
    if (!project?.current_stage) return;
    const current = PHASES.find((phase) =>
      phase.stages.includes(project.current_stage as PipelineStageId),
    );
    setExpandedPhase(current?.id ?? null);
  }, [project?.current_stage]);

  const currentStage = project?.current_stage ?? null;
  const currentStageLabel = currentStage ? getStageLabel(currentStage) : "尚未开始";
  const sourceLabel = useMemo(() => {
    if (!project?.source) return "尚未导入";
    return project.source.type === "Video"
      ? project.source.filename
      : `${project.source.folder_name}（${project.source.image_count} 张）`;
  }, [project?.source]);
  const videoMetadata = analyzeCmd.data?.video_metadata;

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
      <section className="timeline-panel panel">
        <div className="panel-heading-row">
          <span>里程碑 / 阶段</span>
          <span>状态 / 进度</span>
        </div>
        <div className="pipeline-timeline">
          {PHASES.map((phase, index) => {
            const status = phaseStatus(project, phase);
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
                      const stageState = project.pipeline_state.stages[stage];
                      const stageStatus = stageState?.status ?? "pending";
                      return (
                        <button type="button" className="stage-list-row" key={stage}>
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

      <aside className="inspector-column">
        <section className="preview-panel panel">
          <div className="panel-title">
            <span>实时重建预览</span>
            <span className="panel-subtitle">{currentStageLabel}</span>
          </div>
          <div className="preview-empty">
            <Cube size={42} weight="thin" />
            <strong>预览尚未生成</strong>
            <span>完成相机重建后，将在此显示真实点云与相机轨迹。</span>
          </div>
        </section>

        <section className="quality-panel panel">
          <div className="panel-title">当前质量</div>
          <div className="quality-metric-grid">
            <div><span>输入素材</span><strong>{sourceLabel}</strong></div>
            <div>
              <span>视频规格</span>
              <strong>
                {videoMetadata
                  ? `${videoMetadata.width}×${videoMetadata.height} · ${videoMetadata.fps.toFixed(1)} fps`
                  : "尚未测量"}
              </strong>
            </div>
            <div>
              <span>视频时长</span>
              <strong>
                {videoMetadata
                  ? `${videoMetadata.duration_seconds.toFixed(1)} 秒`
                  : "尚未测量"}
              </strong>
            </div>
            <div><span>质量预设</span><strong>{getPresetLabel(project.settings.preset)}</strong></div>
          </div>
          <div className="quality-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void openDirectory(`${projectPath}\\output`)}
            >
              <FolderOpen size={17} /> 打开输出目录
            </button>
            <button type="button" className="button button-secondary" disabled>
              <ImageSquare size={17} /> 打开 PLY
            </button>
          </div>
        </section>
      </aside>

      <section className="activity-panel panel">
        <div className="activity-tabs">
          <button type="button" className="is-active">活动日志</button>
          <button type="button">事件</button>
          <button type="button">警告 (0)</button>
          <button type="button">错误 (0)</button>
        </div>
        <div className="activity-content">
          <div className="activity-table-header">
            <span>时间</span><span>级别</span><span>阶段</span><span>消息</span>
          </div>
          <div className="activity-empty-row">
            <CheckCircle size={17} weight="fill" />
            <span>项目已就绪</span>
            <span>当前阶段：{currentStageLabel}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
