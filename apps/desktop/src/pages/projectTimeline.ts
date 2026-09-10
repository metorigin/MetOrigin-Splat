import { t, localizeMessage } from "../i18n";
import type { ArtifactItem, PipelineStageId, Project, StageStatus } from "../types";

export interface PhaseDefinition {
  id: string;
  label: string;
  description: string;
  stages: PipelineStageId[];
}

export const PHASES: PhaseDefinition[] = [
  { id: "media", get label() { return t("预处理"); }, get description() { return t("素材标准化与有效帧筛选"); }, stages: ["MediaValidation", "FrameExtraction", "ImagePreprocessing"] },
  { id: "camera", get label() { return t("特征提取"); }, get description() { return t("相机轨迹与稀疏点云"); }, stages: ["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"] },
  { id: "training", get label() { return t("训练重建"); }, get description() { return t("Gaussian Splat 优化"); }, stages: ["TrainingPreparation", "BrushTraining", "ModelValidation"] },
  { id: "export", get label() { return t("质量评估"); }, get description() { return t("验证模型并生成结果"); }, stages: ["Export", "PreviewGeneration"] },
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
    case "preparing": return t("准备中");
    case "running": return progress > 0 ? t("运行中 · {0}%", Math.round(progress * 100)) : t("运行中");
    case "pausing": return t("正在暂停");
    case "paused": return t("已暂停");
    case "cancelling": return t("正在取消");
    case "cancelled": return t("已取消");
    case "completed": return t("已完成");
    case "failed": return t("失败");
    case "skipped": return t("已跳过（缓存）");
    default: return t("等待中");
  }
}

export function phaseStatusLabel(status: StageStatus): string {
  return stageStatusLabel(status, 0);
}

export function plyActionState(artifact: ArtifactItem | null | undefined): { ready: boolean; message: string } {
  if (!artifact?.exists) return { ready: false, message: t("PLY 尚未生成，结果导出完成后即可打开。") };
  if (!artifact.validated) return { ready: false, message: localizeMessage(artifact.error) ?? t("PLY 未通过完整性校验，请查看结果导出日志。") };
  return { ready: true, message: t("在应用内预览最终 PLY") };
}

export function phaseProgressPercent(pipelineState: Project["pipeline_state"], phase: PhaseDefinition): number {
  if (!phase.stages.length) return 0;
  const completed = phase.stages.reduce((total, stage) => {
    const item = pipelineState.stages[stage];
    if (!item) return total;
    if (item.status === "completed" || item.status === "skipped") return total + 1;
    return total + (Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : 0);
  }, 0);
  return Math.round(completed / phase.stages.length * 100);
}

export function failedStageId(pipelineState: Project["pipeline_state"] | null | undefined): PipelineStageId | null {
  const current = pipelineState?.current_stage as PipelineStageId | null;
  if (current && pipelineState?.stages[current]?.status === "failed") return current;
  return (Object.keys(pipelineState?.stages ?? {}) as PipelineStageId[]).find((stage) => pipelineState?.stages[stage]?.status === "failed") ?? null;
}
