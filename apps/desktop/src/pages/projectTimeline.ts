import type { ArtifactItem, PipelineStageId, Project, StageStatus } from "../types";

export interface PhaseDefinition {
  id: string;
  label: string;
  description: string;
  stages: PipelineStageId[];
}

export const PHASES: PhaseDefinition[] = [
  { id: "media", label: "素材准备", description: "视频抽帧或图片标准化、图像预处理", stages: ["MediaValidation", "FrameExtraction", "ImagePreprocessing"] },
  { id: "camera", label: "相机重建", description: "COLMAP 相机轨迹与稀疏点云", stages: ["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"] },
  { id: "training", label: "模型训练", description: "3D Gaussian Splat 优化与验证", stages: ["TrainingPreparation", "BrushTraining", "ModelValidation"] },
  { id: "export", label: "结果导出", description: "生成 scene.ply 与预览清单", stages: ["Export", "PreviewGeneration"] },
];

export function phaseStatus(pipelineState: Project["pipeline_state"], phase: PhaseDefinition): StageStatus {
  const states = phase.stages.map((stage) => pipelineState.stages[stage]?.status ?? "pending");
  if (states.includes("failed")) return "failed";
  if (states.includes("cancelling")) return "cancelling";
  if (states.includes("pausing")) return "pausing";
  if (states.includes("running") || states.includes("preparing")) return "running";
  if (states.includes("paused")) return "paused";
  if (states.every((status) => status === "completed" || status === "skipped")) return "completed";
  if (states.includes("cancelled")) return "cancelled";
  return "pending";
}

export function stageStatusLabel(status: StageStatus, progress: number): string {
  switch (status) {
    case "preparing": return "准备中";
    case "running": return progress > 0 ? `运行中 · ${Math.round(progress * 100)}%` : "运行中";
    case "pausing": return "正在暂停";
    case "paused": return "已暂停";
    case "cancelling": return "正在取消";
    case "cancelled": return "已取消";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "skipped": return "已跳过（缓存）";
    default: return "等待中";
  }
}

export function phaseStatusLabel(status: StageStatus): string {
  return stageStatusLabel(status, 0);
}

export function plyActionState(artifact: ArtifactItem | null | undefined): { ready: boolean; message: string } {
  if (!artifact?.exists) return { ready: false, message: "PLY 尚未生成，结果导出完成后即可打开。" };
  if (!artifact.validated) return { ready: false, message: artifact.error ?? "PLY 未通过完整性校验，请查看结果导出日志。" };
  return { ready: true, message: "在应用内预览最终 PLY" };
}
