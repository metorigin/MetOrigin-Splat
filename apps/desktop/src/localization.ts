import type {
  PipelineStageId,
  ProjectStatus,
  StageStatus,
  TaskProgress,
} from "./types";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  creating: "创建中",
  starting: "正在启动",
  ready: "就绪",
  running: "运行中",
  pausing: "正在暂停",
  paused: "已暂停",
  cancelling: "正在取消",
  cancelled: "已取消",
  recovering: "正在恢复",
  completed: "已完成",
  failed: "失败",
};

export const PRESET_LABELS: Record<string, string> = {
  fast: "快速预览",
  balanced: "均衡",
  quality: "高质量",
};

export const STAGE_LABELS: Record<PipelineStageId, string> = {
  MediaValidation: "媒体校验",
  FrameExtraction: "帧提取",
  ImagePreprocessing: "图像预处理",
  ColmapFeatureExtraction: "COLMAP 特征提取",
  ColmapMatching: "COLMAP 特征匹配",
  ColmapMapping: "COLMAP 稀疏重建",
  ColmapValidation: "COLMAP 结果校验",
  TrainingPreparation: "训练准备",
  BrushTraining: "Brush 训练",
  ModelValidation: "模型校验",
  PreviewGeneration: "预览生成",
  Export: "导出",
};

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: "待处理",
  preparing: "准备中",
  running: "运行中",
  pausing: "正在暂停",
  paused: "已暂停",
  cancelling: "正在取消",
  cancelled: "已取消",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const LEGACY_STAGE_LABELS: Record<string, string> = {
  "Media Validation": STAGE_LABELS.MediaValidation,
  "Frame Extraction": STAGE_LABELS.FrameExtraction,
  "Image Preprocessing": STAGE_LABELS.ImagePreprocessing,
  "COLMAP Feature Extraction": STAGE_LABELS.ColmapFeatureExtraction,
  "COLMAP Matching": STAGE_LABELS.ColmapMatching,
  "COLMAP Mapping": STAGE_LABELS.ColmapMapping,
  "COLMAP Validation": STAGE_LABELS.ColmapValidation,
  "Training Preparation": STAGE_LABELS.TrainingPreparation,
  "Brush Training": STAGE_LABELS.BrushTraining,
  "Model Validation": STAGE_LABELS.ModelValidation,
  "Preview Generation": STAGE_LABELS.PreviewGeneration,
  Export: STAGE_LABELS.Export,
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
  analyze_media: "媒体分析失败，请检查文件路径和格式后重试。",
  create_project: "创建项目失败，请检查项目名称、源文件和目录权限。",
  open_project: "打开项目失败，请确认项目目录完整且具有读取权限。",
  list_recent_projects: "加载最近项目失败，请稍后重试。",
  start_pipeline: "启动处理流程失败，请查看日志了解详细信息。",
  cancel_pipeline: "取消处理流程失败，请稍后重试。",
  get_pipeline_state: "获取处理进度失败，请稍后重试。",
  check_engines: "检测处理引擎失败，请稍后重试。",
};

export function getProjectStatusLabel(status: ProjectStatus): string {
  return PROJECT_STATUS_LABELS[status] ?? "未知状态";
}

export function getPresetLabel(preset: string): string {
  return PRESET_LABELS[preset] ?? "自定义";
}

export function getStageLabel(stage: string): string {
  if (stage in STAGE_LABELS) {
    return STAGE_LABELS[stage as PipelineStageId];
  }
  return LEGACY_STAGE_LABELS[stage] ?? "处理阶段";
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "未知日期";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatRelativeTime(isoString: string): string {
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) return "未知时间";
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return formatDate(isoString);
}

export function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatProgressMessage(progress: TaskProgress): string {
  const normalizedStage = normalizeProgressStageId(progress.stage_id);
  const label = getStageLabel(normalizedStage);
  if (progress.total_items > 0) {
    return `${label}：正在处理第 ${progress.current_item}/${progress.total_items} 项`;
  }
  return `${label}进行中…`;
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
  if (message && /[\u3400-\u9fff]/u.test(message)) {
    return message.replace(/^(?:Error|TypeError|RangeError):\s*/u, "");
  }
  return COMMAND_ERROR_MESSAGES[command] ?? "操作失败，请重试或查看日志。";
}
