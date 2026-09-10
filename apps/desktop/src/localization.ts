import { t, getLocale, localizeMessage } from "./i18n";
import type {
  PipelineStageId,
  ProjectStatus,
  StageStatus,
  TaskProgress,
} from "./types";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  get creating() { return t("创建中"); },
  get starting() { return t("正在启动"); },
  get ready() { return t("就绪"); },
  get running() { return t("运行中"); },
  get pausing() { return t("正在暂停"); },
  get paused() { return t("已暂停"); },
  get cancelling() { return t("正在取消"); },
  get cancelled() { return t("已取消"); },
  get recovering() { return t("正在恢复"); },
  get completed() { return t("已完成"); },
  get failed() { return t("失败"); },
};

export const PRESET_LABELS: Record<string, string> = {
  get fast() { return t("快速预览"); },
  get balanced() { return t("均衡"); },
  get quality() { return t("高质量"); },
};

export const STAGE_LABELS: Record<PipelineStageId, string> = {
  get MediaValidation() { return t("媒体校验"); },
  get FrameExtraction() { return t("帧准备"); },
  get ImagePreprocessing() { return t("图像预处理"); },
  get ColmapFeatureExtraction() { return t("COLMAP 特征提取"); },
  get ColmapMatching() { return t("COLMAP 特征匹配"); },
  get ColmapMapping() { return t("COLMAP 稀疏重建"); },
  get ColmapValidation() { return t("COLMAP 结果校验"); },
  get TrainingPreparation() { return t("训练准备"); },
  get BrushTraining() { return t("Brush 训练"); },
  get ModelValidation() { return t("模型校验"); },
  get PreviewGeneration() { return t("预览生成"); },
  get Export() { return t("导出"); },
};

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  get pending() { return t("待处理"); },
  get preparing() { return t("准备中"); },
  get running() { return t("运行中"); },
  get pausing() { return t("正在暂停"); },
  get paused() { return t("已暂停"); },
  get cancelling() { return t("正在取消"); },
  get cancelled() { return t("已取消"); },
  get completed() { return t("已完成"); },
  get failed() { return t("失败"); },
  get skipped() { return t("已跳过"); },
};

const LEGACY_STAGE_LABELS: Record<string, string> = {
  get "Media Validation"() { return STAGE_LABELS.MediaValidation; },
  get "Frame Extraction"() { return STAGE_LABELS.FrameExtraction; },
  get "Image Preprocessing"() { return STAGE_LABELS.ImagePreprocessing; },
  get "COLMAP Feature Extraction"() { return STAGE_LABELS.ColmapFeatureExtraction; },
  get "COLMAP Matching"() { return STAGE_LABELS.ColmapMatching; },
  get "COLMAP Mapping"() { return STAGE_LABELS.ColmapMapping; },
  get "COLMAP Validation"() { return STAGE_LABELS.ColmapValidation; },
  get "Training Preparation"() { return STAGE_LABELS.TrainingPreparation; },
  get "Brush Training"() { return STAGE_LABELS.BrushTraining; },
  get "Model Validation"() { return STAGE_LABELS.ModelValidation; },
  get "Preview Generation"() { return STAGE_LABELS.PreviewGeneration; },
  get Export() { return STAGE_LABELS.Export; },
};

const PROGRESS_STAGE_ALIASES: Record<string, PipelineStageId> = {
  media_validation: "MediaValidation",
  frame_extraction: "FrameExtraction",
  image_preprocessing: "ImagePreprocessing",
  colmap_feature_extraction: "ColmapFeatureExtraction",
  colmap_matching: "ColmapMatching",
  colmap_mapping: "ColmapMapping",
  colmap_validation: "ColmapValidation",
  training_preparation: "TrainingPreparation",
  brush_training: "BrushTraining",
  model_validation: "ModelValidation",
  preview: "PreviewGeneration",
  preview_generation: "PreviewGeneration",
  export: "Export",
};

const COMMAND_ERROR_MESSAGES: Record<string, string> = {
  get analyze_media() { return t("媒体分析失败，请检查文件路径和格式后重试。"); },
  get create_project() { return t("创建项目失败，请检查项目名称、源文件和目录权限。"); },
  get open_project() { return t("打开项目失败，请确认项目目录完整且具有读取权限。"); },
  get list_recent_projects() { return t("加载最近项目失败，请稍后重试。"); },
  get start_pipeline() { return t("启动处理流程失败，请查看日志了解详细信息。"); },
  get cancel_pipeline() { return t("取消处理流程失败，请稍后重试。"); },
  get get_pipeline_state() { return t("获取处理进度失败，请稍后重试。"); },
  get check_engines() { return t("检测处理引擎失败，请稍后重试。"); },
};

export function getProjectStatusLabel(status: ProjectStatus): string {
  return PROJECT_STATUS_LABELS[status] ?? t("未知状态");
}

export function getPresetLabel(preset: string): string {
  return PRESET_LABELS[preset] ?? t("自定义");
}

export function getStageLabel(stage: string): string {
  if (stage in STAGE_LABELS) {
    return STAGE_LABELS[stage as PipelineStageId];
  }
  return LEGACY_STAGE_LABELS[stage] ?? t("处理阶段");
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return t("未知日期");
  return new Intl.DateTimeFormat(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatRelativeTime(isoString: string): string {
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) return t("未知时间");
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return t("刚刚");
  if (diffMin < 60) return t("{0} 分钟前", diffMin);
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("{0} 小时前", diffHr);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t("{0} 天前", diffDay);
  return formatDate(isoString);
}

export function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return t("{0} 分 {1} 秒", minutes, seconds);
}

export function formatProgressMessage(progress: TaskProgress): string {
  const normalizedStage = normalizeProgressStageId(progress.stage_id);
  const label = getStageLabel(normalizedStage);
  if (progress.total_items > 0) {
    return t("{0}：正在处理第 {1}/{2} 项", label, progress.current_item, progress.total_items);
  }
  return t("{0}进行中…", label);
}

export function normalizeProgressStageId(stageId: string): string {
  return PROGRESS_STAGE_ALIASES[stageId] ?? stageId;
}

function extractMessage(error: unknown): string | null {
  if (typeof error === "string") {
    try {
      return extractMessage(JSON.parse(error));
    } catch {
      return error;
    }
  }
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.user_message === "string") return value.user_message;
    if (typeof value.message === "string") return value.message;
  }
  return null;
}

export function formatCommandError(error: unknown, command: string): string {
  const message = extractMessage(error);
  if (message) {
    const clean = message.replace(/^(?:Error|TypeError|RangeError):\s*/u, "");
    const translated = localizeMessage(clean);
    if (getLocale() === "en" || /[\u3400-\u9fff]/u.test(translated)) return translated;
  }
  return COMMAND_ERROR_MESSAGES[command] ?? t("操作失败，请重试或查看日志。");
}
