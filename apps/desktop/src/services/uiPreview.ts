import { t } from "../i18n";
import { PIPELINE_STAGE_IDS } from "../types";
import type {
  AppSettings,
  ActionImpactPreview,
  ArtifactSummary,
  CheckpointSummary,
  EngineInfo,
  EventPage,
  ImagePreview,
  MediaAnalysis,
  PipelineSnapshot,
  PlyPreview,
  Project,
  ProjectAvailabilityResult,
  ProjectInfo,
  ProjectPreflight,
  ProjectStatus,
  ResourceMetrics,
  StageState,
  WorkspaceAction,
  WorkspaceActionRequest,
} from "../types";

const previewProjectPath = "D:\\MetOrigin\\courtyard-scan";
const previewVideoPath = "D:\\Captures\\courtyard_walkthrough.mp4";
const previewImagePath = "D:\\Captures\\courtyard_images";
const now = "2026-08-18T09:42:00+08:00";

const previewStages = Object.fromEntries(
  PIPELINE_STAGE_IDS.map((stageId, index) => {
    const isComplete = index < 8;
    const isCurrent = stageId === "BrushTraining";
    const state: StageState = {
      stage_id: stageId,
      status: isComplete ? "completed" : isCurrent ? "running" : "pending",
      progress: isComplete ? 1 : isCurrent ? 0.68 : 0,
      started_at: isComplete || isCurrent ? now : null,
      ended_at: isComplete ? now : null,
      retry_count: 0,
      error: null,
      log_path: isComplete || isCurrent ? `logs/${stageId}.log` : null,
    };
    return [stageId, state];
  }),
);

export const previewPipeline: PipelineSnapshot = {
  project_id: "preview-courtyard-scan",
  project_path: previewProjectPath,
  status: "running",
  state: {
    stages: previewStages,
    current_stage: "BrushTraining",
    overall_progress: 0.68,
  },
  sequence: 42,
  accepted_at: now,
  started_at: now,
  control_intent: "none",
};

const previewProjectInfo: ProjectInfo = {
  id: previewPipeline.project_id,
  name: "Courtyard Scan",
  path: previewProjectPath,
  status: "running",
  updated_at: now,
  stage_label: "BrushTraining",
};

const previewProject: Project = {
  schema_version: 1,
  id: previewProjectInfo.id,
  name: previewProjectInfo.name,
  created_at: "2026-08-18T08:06:00+08:00",
  updated_at: now,
  source: { type: "ImageFolder", folder_name: "courtyard-capture", image_count: 286, copied_to_project: true },
  settings: {
    preset: "balanced",
    max_frames: 500,
    max_long_edge: 1920,
    colmap_max_long_edge: 1600,
    frame_fps: null,
    iterations: 30_000,
    sh_degree: 3,
    checkpoint_interval: 5_000,
  },
  status: "running",
  current_stage: "BrushTraining",
  pipeline_state: previewPipeline.state,
};

const previewProjects: ProjectInfo[] = [
  previewProjectInfo,
  {
    id: "preview-museum-hall",
    name: "Museum Hall",
    path: "D:\\MetOrigin\\museum-hall",
    status: "completed",
    updated_at: "2026-08-18T18:42:00+08:00",
    stage_label: "Export",
  },
  {
    id: "preview-product-turntable",
    name: "Product Turntable",
    path: "D:\\MetOrigin\\turntable",
    status: "paused",
    updated_at: "2026-08-17T14:08:00+08:00",
    stage_label: "ColmapValidation",
  },
  {
    id: "preview-rooftop-garden",
    name: "Rooftop Garden",
    path: "E:\\Projects\\rooftop",
    status: "ready",
    updated_at: "2026-08-12T15:12:00+08:00",
    stage_label: "MediaValidation",
  },
  { id: "preview-old-factory", name: "Old Factory", path: "D:\\MetOrigin\\old-factory", status: "completed", updated_at: "2026-08-09T12:00:00+08:00", stage_label: "Export" },
  { id: "preview-stone-bench", name: "Stone Bench", path: "D:\\MetOrigin\\stone-bench", status: "completed", updated_at: "2026-08-06T11:12:00+08:00", stage_label: "Export" },
  { id: "preview-lobby", name: "Lobby Test", path: "D:\\MetOrigin\\lobby", status: "ready", updated_at: "2026-08-03T09:38:00+08:00", stage_label: "MediaValidation" },
  { id: "preview-small-studio", name: "Small Studio", path: "D:\\MetOrigin\\studio", status: "cancelled", updated_at: "2026-08-01T17:20:00+08:00", stage_label: "FrameExtraction" },
];

function requestedPreviewStatus(): ProjectStatus {
  if (typeof window === "undefined") return "running";
  const value = new URLSearchParams(window.location.search).get("preview-state") as ProjectStatus | null;
  return value && ["running", "paused", "completed", "failed"].includes(value) ? value : "running";
}

function currentPreviewPipeline(): PipelineSnapshot {
  const status = requestedPreviewStatus();
  if (status === "running") return previewPipeline;
  const stages = Object.fromEntries(Object.entries(previewStages).map(([stageId, stage]) => {
    if (status === "completed") return [stageId, { ...stage, status: "completed", progress: 1, ended_at: now }];
    if (stageId === "BrushTraining") {
      return [stageId, {
        ...stage,
        status: status === "failed" ? "failed" : "paused",
        progress: 0.68,
        error: status === "failed" ? "CUDA out of memory" : null,
      }];
    }
    return [stageId, stage];
  })) as Record<string, StageState>;
  return {
    ...previewPipeline,
    status,
    state: {
      ...previewPipeline.state,
      stages,
      current_stage: status === "completed" ? "Export" : "BrushTraining",
      overall_progress: status === "completed" ? 1 : 0.68,
    },
  };
}

function currentPreviewProjectInfo(): ProjectInfo {
  const pipeline = currentPreviewPipeline();
  return { ...previewProjectInfo, status: pipeline.status, stage_label: pipeline.state.current_stage ?? undefined };
}

function previewProjectInfoForPath(path: unknown): ProjectInfo {
  if (path == null || path === previewProjectPath) return currentPreviewProjectInfo();
  const project = previewProjects.find((item) => item.path === path);
  if (!project) throw new Error(`UI preview does not provide project: ${String(path)}`);
  return project;
}

function previewPipelineForProject(project: ProjectInfo): PipelineSnapshot {
  if (project.id === previewProjectInfo.id) return currentPreviewPipeline();
  const currentStage = PIPELINE_STAGE_IDS.find((stageId) => stageId === project.stage_label) ?? null;
  const currentIndex = currentStage ? PIPELINE_STAGE_IDS.indexOf(currentStage) : 0;
  const stages = Object.fromEntries(PIPELINE_STAGE_IDS.map((stageId, index) => {
    const completed = project.status === "completed" || (project.status !== "ready" && index < currentIndex);
    const stage: StageState = {
      ...previewStages[stageId],
      status: completed ? "completed" : stageId === currentStage && (project.status === "paused" || project.status === "cancelled") ? project.status : "pending",
      progress: completed ? 1 : 0,
      started_at: completed || (stageId === currentStage && project.status !== "ready") ? project.updated_at : null,
      ended_at: completed ? project.updated_at : null,
      log_path: completed ? `logs/${stageId}.log` : null,
    };
    return [stageId, stage];
  }));
  return {
    ...previewPipeline,
    project_id: project.id,
    project_path: project.path,
    status: project.status,
    sequence: 0,
    accepted_at: null,
    started_at: null,
    state: {
      stages,
      current_stage: currentStage,
      overall_progress: project.status === "completed" ? 1 : project.status === "ready" ? 0 : currentIndex / PIPELINE_STAGE_IDS.length,
    },
  };
}

function previewProjectForPath(path: unknown): Project {
  const project = previewProjectInfoForPath(path);
  const pipeline = previewPipelineForProject(project);
  return {
    ...previewProject,
    id: project.id,
    name: project.name,
    updated_at: project.updated_at,
    status: pipeline.status,
    current_stage: pipeline.state.current_stage,
    pipeline_state: pipeline.state,
  };
}

const previewEngines: EngineInfo[] = ["FFmpeg", "COLMAP", "Brush"].map((name) => ({
  name,
  version: name === "FFmpeg" ? "7.1" : name === "COLMAP" ? "3.11" : "0.8.2",
  path: `C:\\MetOrigin\\engines\\${name.toLowerCase()}\\${name.toLowerCase()}.exe`,
  available: true,
  source: "resource",
  pack_version: "2026.08",
  integrity_status: "valid",
  expected_version: null,
  actual_version: null,
  diagnostic: null,
  checked_at: now,
}));

const previewMetrics: ResourceMetrics = {
  timestamp: now,
  operating_system: "Windows 11",
  cpu_name: "AMD Ryzen 9 7900X",
  cpu_usage_percent: 42,
  memory_total_bytes: 64 * 1024 ** 3,
  memory_used_bytes: 22.4 * 1024 ** 3,
  project_disk_available_bytes: 428.6 * 1024 ** 3,
  disk_path: "C:\\MetOrigin",
  gpu: {
    name: "NVIDIA GeForce RTX 4090",
    driver_version: "581.08",
    memory_total_bytes: 24 * 1024 ** 3,
    memory_used_bytes: 15.4 * 1024 ** 3,
    utilization_percent: 76,
    temperature_celsius: 63,
  },
  warnings: [],
};

const previewSettings: AppSettings = {
  engine_directory: "C:\\MetOrigin\\engines",
  engine_executables: {},
  default_project_root: "D:\\MetOrigin Projects",
  default_preset: "balanced",
  create_and_start: true,
  prevent_idle_sleep: false,
  log_retention_mb: 512,
  thumbnail_cache_mb: 1024,
};

const previewCheckpoint: CheckpointSummary = {
  iteration: 20_000,
  relative_path: "checkpoints/iteration_20000.ply",
  size_bytes: 268 * 1024 ** 2,
  created_at: now,
  vertex_count: 1_284_600,
  valid: true,
  current: true,
  brush_version: "0.2.0",
};
const previewPreviousCheckpoint: CheckpointSummary = {
  ...previewCheckpoint,
  iteration: 15_000,
  relative_path: "checkpoints/iteration_15000.ply",
  current: false,
};

const artifact = (relativePath: string, validated = true) => ({
  relative_path: relativePath,
  exists: true,
  validated,
  size_bytes: 42 * 1024 ** 2,
  updated_at: now,
  error: null,
});

const previewArtifacts: ArtifactSummary = {
  get frames_manifest() { return artifact("frames/manifest.json"); },
  get colmap_result() { return artifact("colmap/sparse/0"); },
  latest_checkpoint: previewCheckpoint,
  get scene_ply() { return artifact("output/scene.ply", false); },
  get output_manifest() { return artifact("output/manifest.json", false); },
  registered_images: 281,
  total_images: 286,
  sparse_points: 1_284_600,
  mean_reprojection_error: 0.43,
  colmap_validation: null,
  colmap_attempts: [],
  splat_count: null,
};

const previewAnalysis: MediaAnalysis = {
  source_kind: "video",
  source_path: previewVideoPath,
  display_name: "courtyard_walkthrough.mp4",
  size_bytes: 6.8 * 1024 ** 3,
  valid: true,
  video_metadata: {
    width: 3840,
    height: 2160,
    fps: 30,
    duration_seconds: 61.53,
    codec: "h264",
    frame_count: 1846,
    rotation: 0,
  },
  image_set_metadata: null,
  preset_estimates: [
    { id: "fast", get name() { return t("快速"); }, get description() { return t("快速检查构图和覆盖"); }, fps: 2, max_frames: 220, target_long_edge: 1440, colmap_long_edge: 1280, iterations: 12_000, sh_degree: 2, checkpoint_interval: 3_000, estimated_frames: 220, estimated_disk_bytes: 1.8 * 1024 ** 3 },
    { id: "balanced", get name() { return t("均衡"); }, get description() { return t("推荐用于大多数桌面场景"); }, fps: 7, max_frames: 500, target_long_edge: 1920, colmap_long_edge: 1600, iterations: 30_000, sh_degree: 3, checkpoint_interval: 5_000, estimated_frames: 428, estimated_disk_bytes: 4.6 * 1024 ** 3 },
    { id: "quality", get name() { return t("高质量"); }, get description() { return t("保留更多几何纹理细节"); }, fps: 12, max_frames: 800, target_long_edge: 2560, colmap_long_edge: 1920, iterations: 45_000, sh_degree: 3, checkpoint_interval: 5_000, estimated_frames: 738, estimated_disk_bytes: 9.8 * 1024 ** 3 },
  ],
  preview_items: [],
  warnings: [t("18 帧存在轻微运动模糊"), t("3 段亮度变化，可自动校正")],
  blockers: [],
};

const previewPreflight: ProjectPreflight = {
  can_continue: true,
  engine_checks: previewEngines.map((engine) => ({
    name: engine.name,
    available: true,
    path: engine.path,
    expected_version: engine.expected_version,
    actual_version: engine.version,
    diagnostic: null,
    source: engine.source,
    integrity_status: engine.integrity_status,
  })),
  estimated_frames: 428,
  estimated_disk_bytes: 4.6 * 1024 ** 3,
  available_disk_bytes: previewMetrics.project_disk_available_bytes ?? 0,
  recommended_preset: "balanced",
  warnings: [],
  blockers: [],
};

function previewAnalysisForPath(path: unknown): MediaAnalysis {
  if (path == null || path === previewVideoPath) return previewAnalysis;
  if (path !== previewImagePath) throw new Error(`UI preview does not provide media: ${String(path)}`);
  return {
    ...previewAnalysis,
    source_kind: "images",
    source_path: previewImagePath,
    display_name: "courtyard_images",
    size_bytes: 1.2 * 1024 ** 3,
    video_metadata: null,
    image_set_metadata: { image_count: 286, ignored_count: 3, invalid_count: 0, total_size_bytes: 1.2 * 1024 ** 3, formats: { jpg: 280, png: 6 } },
    preset_estimates: previewAnalysis.preset_estimates.map((preset) => ({ ...preset, fps: 0, estimated_frames: Math.min(286, preset.max_frames) })),
    warnings: [],
  };
}

// Offline, synthetic checkerboard PNG. It is sample UI content, never user media
// or a claim that a photograph was loaded. Dimensions match the encoded raster.
const previewImageData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAgklEQVR42u3ZMQ0AQAgDQPzLQwBa3kIXFv4Q0ITbmlYHN8FdzSlAgAABAgQIECBAgAABWgD6+fkkBxAgQIAAAQIECBAgQIA2gJRVbR4QIECAAAECBAgQIEB2MW0eECBAgAABAgQIECBAdjFlFRAgQIAAAQIECBAgQIDsYto8IEDHch4ae8OFz+/oKwAAAABJRU5ErkJggg==";
function previewImagesForPath(path: unknown): ImagePreview[] {
  const analysis = previewAnalysisForPath(path);
  return analysis.source_kind !== "images" ? [] : Array.from({ length: 6 }, (_, index) => ({
    relative_path: `preview/frame-${index + 1}.png`,
    display_name: `${t("界面预览 · 示例数据")} ${index + 1}.png`,
    width: 96,
    height: 64,
    data_url: previewImageData,
  }));
}

function previewPreflightForRequest(value: unknown): ProjectPreflight {
  const request = value as { sourcePath?: unknown; preset?: string } | undefined;
  const analysis = previewAnalysisForPath(request?.sourcePath);
  const preset = analysis.preset_estimates.find((item) => item.id === request?.preset) ?? analysis.preset_estimates[1];
  return { ...previewPreflight, estimated_frames: preset.estimated_frames, estimated_disk_bytes: preset.estimated_disk_bytes };
}

const previewPly: PlyPreview = {
  relative_path: previewCheckpoint.relative_path,
  format: "binary_little_endian",
  vertex_count: previewCheckpoint.vertex_count,
  size_bytes: previewCheckpoint.size_bytes,
  gaussian_compatible: true,
  points: [],
};

const previewEvents: EventPage = {
  items: [
    { event_id: "evt-42", project_id: previewProject.id, sequence: 42, timestamp: now, kind: "stage_progress", severity: "info", phase_id: "training", stage_id: "BrushTraining", get user_message() { return t("训练稳定进行中，当前已完成 20,400 / 30,000 次迭代。"); }, technical_message: null, metrics: { loss: 0.0138 }, source_log: "logs/BrushTraining.log" },
  ],
  next_cursor: null,
  total: 1,
};

export function isUiPreviewMode(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).has("ui-preview");
}

const previewScenarios = ["engines-error", "workspace-stale", "activity-error", "checkpoints-empty", "preflight-blocked", "quality-confirmation", "quality-blocked"] as const;
type PreviewScenario = typeof previewScenarios[number];
const scenarioSession = { key: "", artifactReads: new Map<string, number>() };

function requestedPreviewScenario(): PreviewScenario | null {
  // These fixtures cannot alter commands outside the existing development-only
  // preview gate. Unknown query values do not create another command surface.
  const value = isUiPreviewMode() ? new URLSearchParams(window.location.search).get("preview-scenario") : null;
  const scenario = previewScenarios.includes(value as PreviewScenario) ? value as PreviewScenario : null;
  const key = scenario ? window.location.href : "";
  if (scenarioSession.key !== key) {
    scenarioSession.key = key;
    scenarioSession.artifactReads.clear();
  }
  return scenario;
}

function previewQualityArtifacts(scenario: "quality-confirmation" | "quality-blocked"): ArtifactSummary {
  const blocked = scenario === "quality-blocked";
  const registered = blocked ? 48 : 181;
  const reprojection = blocked ? 3.14 : 1.83;
  const sample = t("界面预览 · 示例数据");
  return {
    ...previewArtifacts, registered_images: registered, sparse_points: blocked ? 3_200 : 64_000, mean_reprojection_error: reprojection,
    colmap_validation: {
      passed: false, decision: blocked ? "blocked" : "requires_confirmation",
      checks: [
        { name: t("已注册图像"), passed: false, detail: `${sample} · ${registered} / 286`, severity: blocked ? "Critical" : "Warning" },
        { name: t("重投影误差"), passed: !blocked, detail: `${sample} · ${reprojection.toFixed(3)} px`, severity: blocked ? "Critical" : "Info" },
      ],
      largest_component_images: registered, largest_component_coverage: registered / 286, largest_missing_segment: blocked ? 148 : 40,
      automatic_fallbacks_exhausted: true, model_hash: `ui-preview-only:${scenario}`,
    },
  };
}

function failPreviewScenario(code: string, message: string): never {
  return rejectPreviewCommand(`UI-PREVIEW-${code}`, message, true);
}

function rejectPreviewCommand(code: string, message: string, retryable = false): never {
  // Mirror the serialized structured errors returned by the existing IPC edge.
  const payload = JSON.stringify({
    code,
    category: "environment",
    title: t("操作未完成"),
    user_message: `${t("界面预览 · 示例数据")} · ${message}`,
    retryable,
  });
  throw payload;
}

const previewActionSession = { key: "", next: 0, tokens: new Map<string, { request: WorkspaceActionRequest; expiresAt: number }>() };
function requirePreviewActionSession() {
  if (!isUiPreviewMode()) throw new Error("UI preview action requires development preview mode");
  if (previewActionSession.key !== window.location.href) {
    previewActionSession.key = window.location.href;
    previewActionSession.tokens.clear();
  }
}

function previewWorkspaceAction(value: unknown, scenario: PreviewScenario | null): ActionImpactPreview {
  requirePreviewActionSession();
  const request = value as Partial<WorkspaceActionRequest> | null;
  const actions: WorkspaceAction[] = ["pause", "cancel", "rerun_stage", "restore_checkpoint", "delete_checkpoint", "delete_project"];
  if (!request || typeof request.projectPath !== "string" || !request.projectPath || typeof request.projectId !== "string" || !request.action || !actions.includes(request.action)) {
    rejectPreviewCommand("UI-PREVIEW-ACTION-REQUEST", t("操作确认请求包含缺失或不适用的目标字段。"));
  }
  const project = previewProjectInfoForPath(request.projectPath);
  if (request.projectId !== project.id) rejectPreviewCommand("UI-PREVIEW-ACTION-IDENTITY", t("项目身份已变化，已拒绝生成操作确认。"));
  const isStageAction = request.action === "rerun_stage";
  const isCheckpointAction = request.action === "restore_checkpoint" || request.action === "delete_checkpoint";
  if ((isStageAction && !PIPELINE_STAGE_IDS.includes(request.stageId as typeof PIPELINE_STAGE_IDS[number])) || (!isStageAction && request.stageId != null)
    || (isCheckpointAction && (!Number.isInteger(request.checkpointIteration) || Number(request.checkpointIteration) <= 0)) || (!isCheckpointAction && request.checkpointIteration != null)) {
    rejectPreviewCommand("UI-PREVIEW-ACTION-REQUEST", t("操作确认请求包含缺失或不适用的目标字段。"));
  }
  const active = currentPreviewPipeline();
  const hasActive = ["starting", "running", "pausing", "cancelling", "recovering"].includes(active.status);
  const targetsActive = hasActive && active.project_id === project.id;
  let targetLabel = "";
  let allowed = true;
  let blockedReason: string | null = null;
  let irreversible = false;
  let preserved: string[] = [];
  let invalidated: string[] = [];
  let regenerated: string[] = [];
  let warnings: string[] = [];
  let sizeBytes: number | null = null;
  if (request.action === "pause" || request.action === "cancel") {
    targetLabel = request.action === "pause" ? t("暂停当前处理") : t("安全取消当前处理");
    allowed = targetsActive && active.control_intent === "none";
    blockedReason = allowed ? null : targetsActive ? t("已有控制操作正在执行，请等待完成。") : t("该项目当前没有活动处理任务。");
    preserved = [t("已完成阶段"), t("已验证产物"), t("合法 Checkpoint")];
    invalidated = request.action === "cancel" ? [t("当前未完成阶段的临时结果")] : [];
    warnings = [t("继续处理时会从可恢复边界重新验证状态。")];
  } else if (request.action === "rerun_stage") {
    targetLabel = t("从 {0} 阶段重新运行", request.stageId);
    allowed = !hasActive;
    blockedReason = allowed ? null : t("存在活动处理任务，请先暂停或安全取消。");
    preserved = [t("所选阶段之前的已验证产物"), t("原始素材")];
    regenerated = PIPELINE_STAGE_IDS.slice(PIPELINE_STAGE_IDS.indexOf(request.stageId as typeof PIPELINE_STAGE_IDS[number]));
    invalidated = regenerated.map((stage) => t("{0} 的现有状态与下游产物", stage));
    warnings = [t("重新运行不会修改原始素材。")];
  } else if (isCheckpointAction) {
    const iteration = request.checkpointIteration!;
    const checkpoint = scenario === "checkpoints-empty" ? undefined : [previewPreviousCheckpoint, previewCheckpoint].find((item) => item.iteration === iteration);
    const restoring = request.action === "restore_checkpoint";
    targetLabel = `Checkpoint ${iteration} step`;
    allowed = !!checkpoint && !hasActive && (restoring || !checkpoint.current);
    blockedReason = !checkpoint ? t("未找到指定 Checkpoint。")
      : !restoring && checkpoint.current ? t("不能删除当前使用或唯一合法的 Checkpoint。")
        : hasActive ? t("存在活动处理任务，请先暂停或安全取消。") : null;
    irreversible = !restoring;
    preserved = restoring ? [targetLabel, t("原始素材与相机重建")] : [t("其他合法 Checkpoint")];
    invalidated = [restoring ? t("{0} step 之后的 Checkpoint 与训练下游产物", iteration) : t("Checkpoint {0} step 文件", iteration)];
    regenerated = restoring ? [t("预览与导出")] : [];
    warnings = [restoring ? t("仅恢复几何状态，不恢复优化器状态。") : t("删除后不能通过应用恢复该文件。")];
    sizeBytes = checkpoint?.size_bytes ?? null;
  } else {
    targetLabel = t("永久删除项目“{0}”", project.name);
    allowed = !targetsActive;
    blockedReason = allowed ? null : t("项目仍在处理或创建中，请先安全停止。");
    irreversible = true;
    preserved = [t("应用设置与其他项目")];
    invalidated = [t("项目素材副本"), t("重建产物"), t("日志与导出")];
    warnings = [t("项目目录将从磁盘永久移除，此操作不可撤销。")];
  }
  const created = Date.now();
  const expiresAt = created + 5 * 60_000;
  const previewToken = `ui-preview-only:${project.id}:${request.action}:${++previewActionSession.next}`;
  if (previewActionSession.tokens.size >= 128) previewActionSession.tokens.delete(previewActionSession.tokens.keys().next().value!);
  previewActionSession.tokens.set(previewToken, { request: { ...request } as WorkspaceActionRequest, expiresAt });
  return { action: request.action, targetLabel: `${project.name} · ${targetLabel}`, allowed, blockedReason, irreversible, preserved, invalidated, regenerated,
    warnings: [t("界面预览 · 示例数据"), ...warnings], sizeBytes, previewToken,
    createdAt: new Date(created).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

function rejectPreviewActionExecution(token: unknown): never {
  requirePreviewActionSession();
  const record = typeof token === "string" ? previewActionSession.tokens.get(token) : undefined;
  if (!record) rejectPreviewCommand("UI-ACTION-PREVIEW-INVALID", t("操作确认已使用或无效，尚未执行任何操作。"));
  previewActionSession.tokens.delete(String(token));
  if (record.expiresAt <= Date.now()) rejectPreviewCommand("UI-ACTION-PREVIEW-EXPIRED", t("操作影响说明已过期，尚未执行任何操作，请重新确认。"));
  // This surface is only for inspecting and cancelling influence previews. It
  // cannot produce a fake receipt or mutate fixture/real project state.
  rejectPreviewCommand("UI-PREVIEW-EXECUTION-DISABLED", t("当前操作没有完成。"));
}

export function resolveUiPreviewCommand(command: string, args?: Record<string, unknown>): unknown {
  const scenario = requestedPreviewScenario();
  switch (command) {
    case "app_version": return "0.1.0-preview";
    case "check_engines":
      if (scenario === "engines-error") failPreviewScenario("ENGINES-ERROR", t("部分引擎需要处理"));
      return previewEngines;
    case "list_recent_projects":
    case "list_recent_project_index": return [currentPreviewProjectInfo(), ...previewProjects.slice(1)];
    case "check_recent_project_availability": {
      const projectId = String(args?.projectId ?? previewProjectInfo.id);
      const projects = [currentPreviewProjectInfo(), ...previewProjects.slice(1)];
      const project = projects.find((item) => item.id === projectId);
      if (!project || (args?.projectPath != null && args.projectPath !== project.path)) throw new Error("UI preview does not provide requested project identity");
      return {
        project_id: project.id,
        checked_path: project.path,
        availability: "available",
        checked_at: now,
        reason_code: null,
        refreshed_project: project,
      } satisfies ProjectAvailabilityResult;
    }
    case "get_project_thumbnail": {
      const project = previewProjectInfoForPath(args?.projectPath);
      if (args?.projectId !== project.id) throw new Error("UI preview does not provide requested project identity");
      // Preview fixtures do not contain user photographs.
      return null;
    }
    case "get_app_settings":
    case "save_app_settings": return previewSettings;
    case "get_resource_metrics": return previewMetrics;
    case "get_active_pipeline_summary":
      return new URLSearchParams(window.location.search).get("preview-page") === "new-project"
        ? null
        : currentPreviewPipeline();
    case "get_pipeline_state": {
      const project = previewProjectInfoForPath(args?.projectPath);
      if (scenario === "workspace-stale") failPreviewScenario("PIPELINE-STALE", t("无法刷新处理状态"));
      return previewPipelineForProject(project);
    }
    case "open_project": return previewProjectForPath(args?.path);
    case "get_project_artifacts": {
      const project = previewProjectInfoForPath(args?.projectPath);
      if (scenario === "workspace-stale") {
        // React StrictMode performs two development warm-up reads. Install valid
        // data for both, then fail the normal 10s refresh so this scenario
        // exercises retained-data feedback instead of a first-load error.
        const reads = scenarioSession.artifactReads.get(project.path) ?? 0;
        scenarioSession.artifactReads.set(project.path, reads + 1);
        if (reads > 1) failPreviewScenario("ARTIFACTS-STALE", t("无法刷新项目产物"));
      }
      if (scenario === "quality-confirmation" || scenario === "quality-blocked") return previewQualityArtifacts(scenario);
      return scenario === "checkpoints-empty" ? { ...previewArtifacts, latest_checkpoint: null } : previewArtifacts;
    }
    case "list_checkpoints":
      previewProjectInfoForPath(args?.projectPath);
      return scenario === "checkpoints-empty" ? [] : [previewPreviousCheckpoint, previewCheckpoint];
    case "preview_workspace_action": return previewWorkspaceAction(args?.request, scenario);
    case "execute_workspace_action": return rejectPreviewActionExecution(args?.previewToken);
    case "inspect_ply": return previewPly;
    case "get_pipeline_events": {
      const project = previewProjectInfoForPath(args?.projectPath);
      if (scenario === "activity-error") failPreviewScenario("ACTIVITY-ERROR", t("无法刷新活动记录"));
      return { ...previewEvents, items: previewEvents.items.map((event) => ({ ...event, project_id: project.id })) };
    }
    case "analyze_media": return previewAnalysisForPath(args?.path);
    case "get_image_previews": return previewImagesForPath(args?.path);
    case "preflight_project": {
      const preflight = previewPreflightForRequest(args?.request);
      return scenario === "preflight-blocked" ? {
      ...preflight,
      can_continue: false,
      available_disk_bytes: 256 * 1024 ** 2,
      engine_checks: preflight.engine_checks.map((engine) => engine.name === "COLMAP" ? {
        ...engine, available: false, diagnostic: `${t("界面预览 · 示例数据")} · ${t("未通过组件检查")}`,
      } : engine),
      blockers: [`${t("界面预览 · 示例数据")} · ${t("项目磁盘空间不足，还需要约 {0} GiB。", "4.4")}`],
    } satisfies ProjectPreflight : preflight;
    }
    case "open_project_location": return { opened_path: previewProjectPath, missing: false, message: null };
    case "ensure_output_directory": return `${previewProjectPath}\\output`;
    case "cancel_project_creation":
    case "remove_recent_project": return undefined;
    default:
      throw new Error(`UI preview does not provide command: ${command}`);
  }
}
