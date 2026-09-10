import { t, localizeMessage } from "../i18n";
import type {
  UiError,
  UiErrorAction,
  UiErrorCategory,
} from "../types";

interface ErrorFallback {
  code: string;
  category: UiErrorCategory;
  title: string;
  impact: string;
  suggestion: string;
  retryable: boolean;
  actions?: UiErrorAction[];
}

const FALLBACKS: Record<string, ErrorFallback> = {
  list_recent_projects: {
    code: "UI-RECENT-PROJECTS-LOAD",
    category: "filesystem",
    get title() { return t("无法加载最近项目"); },
    get impact() { return t("项目列表暂时无法更新，已有记录保持不变。"); },
    get suggestion() { return t("稍后重试加载。"); },
    retryable: true,
  },
  get_app_settings: {
    code: "UI-SETTINGS-LOAD",
    category: "filesystem",
    get title() { return t("无法加载设置"); },
    get impact() { return t("当前设置无法显示或修改；项目数据保持不变。"); },
    get suggestion() { return t("重试加载设置；若问题持续，可导出诊断信息。"); },
    retryable: true,
    actions: [{ kind: "export_diagnostics", get label() { return t("导出诊断"); }, enabled: true }],
  },
  get_pipeline_state: {
    code: "UI-PIPELINE-REFRESH",
    category: "internal",
    get title() { return t("无法刷新处理状态"); },
    get impact() { return t("界面将保留上一次有效状态。"); },
    get suggestion() { return t("重试刷新或查看活动记录。"); },
    retryable: true,
    actions: [{ kind: "show_activity", get label() { return t("查看活动"); }, enabled: true }],
  },
  get_pipeline_events: {
    code: "UI-ACTIVITY-REFRESH",
    category: "filesystem",
    get title() { return t("无法刷新活动记录"); },
    get impact() { return t("界面将保留上一次成功加载的活动记录。"); },
    get suggestion() { return t("重试刷新，或检查项目存储是否仍可访问。"); },
    retryable: true,
    actions: [{ kind: "export_diagnostics", get label() { return t("导出诊断"); }, enabled: true }],
  },
  get_project_artifacts: {
    code: "UI-ARTIFACTS-REFRESH",
    category: "filesystem",
    get title() { return t("无法刷新项目产物"); },
    get impact() { return t("产物与质量信息可能不是最新状态。"); },
    get suggestion() { return t("重试读取项目产物。"); },
    retryable: true,
    actions: [{ kind: "show_activity", get label() { return t("查看活动"); }, enabled: true }],
  },
  list_checkpoints: {
    code: "UI-CHECKPOINTS-REFRESH",
    category: "filesystem",
    get title() { return t("无法刷新恢复点"); },
    get impact() { return t("恢复点列表可能不是最新状态。"); },
    get suggestion() { return t("重试读取恢复点列表。"); },
    retryable: true,
  },
  get_frame_preview: {
    code: "UI-FRAME-PREVIEW-REFRESH",
    category: "filesystem",
    get title() { return t("无法读取帧预览"); },
    get impact() { return t("界面将保留上一次成功读取的帧预览。"); },
    get suggestion() { return t("确认项目存储可访问后重试读取。"); },
    retryable: true,
  },
  get_sparse_preview_pack: {
    code: "UI-SPARSE-PREVIEW-REFRESH",
    category: "filesystem",
    get title() { return t("无法读取稀疏点预览"); },
    get impact() { return t("界面将保留上一次成功读取的稀疏点预览。"); },
    get suggestion() { return t("确认相机重建产物可访问后重试读取。"); },
    retryable: true,
  },
  inspect_ply: {
    code: "UI-PLY-PREVIEW-REFRESH",
    category: "filesystem",
    get title() { return t("无法读取点云预览"); },
    get impact() { return t("界面将保留上一次成功读取的点云预览。"); },
    get suggestion() { return t("确认对应产物仍然存在后重试读取。"); },
    retryable: true,
  },
  start_pipeline: {
    code: "UI-PIPELINE-START",
    category: "engine",
    get title() { return t("无法启动处理流程"); },
    get impact() { return t("项目尚未开始处理。"); },
    get suggestion() { return t("检查设置和处理引擎后重试。"); },
    retryable: false,
    actions: [{ kind: "open_settings", get label() { return t("打开设置"); }, enabled: true }],
  },
  create_project: {
    code: "UI-PROJECT-CREATE",
    category: "filesystem",
    get title() { return t("无法创建项目"); },
    get impact() { return t("项目未创建，已存在的数据保持不变。"); },
    get suggestion() { return t("检查项目名称、素材和保存目录。"); },
    retryable: false,
    actions: [{ kind: "open_settings", get label() { return t("打开设置"); }, enabled: true }],
  },
};

const DEFAULT_FALLBACK: ErrorFallback = {
  code: "UI-UNKNOWN-COMMAND",
  category: "unknown",
  get title() { return t("操作未完成"); },
  get impact() { return t("当前操作没有完成。"); },
  get suggestion() { return t("请检查当前状态后再试，或导出诊断信息。"); },
  retryable: false,
  actions: [{ kind: "export_diagnostics", get label() { return t("导出诊断"); }, enabled: true }],
};

const CATEGORIES = new Set<UiErrorCategory>([
  "user",
  "environment",
  "media",
  "engine",
  "filesystem",
  "resource",
  "internal",
  "unknown",
]);

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(token|password|secret|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/[A-Za-z]:\\\\Users\\\\[^\\\s"]+(?:\\\\[^\s,;"]*)?/gu, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s,;]*)?/gu, "[REDACTED_PATH]")
    .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\s,;]*)?/gu, "[REDACTED_PATH]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || value instanceof Error) return null;
  return value as Record<string, unknown>;
}

function parsePayload(error: unknown): Record<string, unknown> | null {
  if (typeof error !== "string") return asRecord(error);
  try {
    return asRecord(JSON.parse(error));
  } catch {
    return null;
  }
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? redactSensitiveText(value.trim())
    : null;
}

function safeSuggestions(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return [fallback];
  const suggestions = value
    .map(safeString)
    .filter((entry): entry is string => Boolean(entry));
  return suggestions.length > 0 ? suggestions : [fallback];
}

export function normalizeCommandError(error: unknown, command: string): UiError {
  const fallback = FALLBACKS[command] ?? DEFAULT_FALLBACK;
  const payload = parsePayload(error);
  const retryable = payload?.retryable === true || (!payload && fallback.retryable);
  const categoryValue = safeString(payload?.category) as UiErrorCategory | null;
  const category = categoryValue && CATEGORIES.has(categoryValue)
    ? categoryValue
    : fallback.category;
  const legacyMessage = typeof error === "string" ? safeString(error) : null;
  const actions = [
    ...(retryable
      ? [{ kind: "retry" as const, label: t("重试"), enabled: true }]
      : []),
    ...(fallback.actions ?? []),
  ];

  return {
    code: safeString(payload?.code) ?? fallback.code,
    category,
    title: safeString(payload?.title) ?? fallback.title,
    message:
      safeString(payload?.user_message) ??
      safeString(payload?.message) ??
      legacyMessage ??
      fallback.title,
    impact: safeString(payload?.impact) ?? fallback.impact,
    suggestions: safeSuggestions(payload?.suggestions, fallback.suggestion),
    retryable,
    actions,
    technicalDetails: safeString(payload?.technical_message),
    logReference: safeString(payload?.log_reference),
  };
}

export function formatUiError(error: UiError): string {
  return t("{0}：{1}", localizeMessage(error.title), localizeMessage(error.message));
}
