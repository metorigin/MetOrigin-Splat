import { PIPELINE_STAGE_IDS } from "../types";
import type {
  AppSettings,
  ArtifactSummary,
  CheckpointSummary,
  EngineInfo,
  EventPage,
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
} from "../types";

const previewProjectPath = "D:\\MetOrigin\\courtyard-scan";
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

function currentPreviewProject(): Project {
  const pipeline = currentPreviewPipeline();
  return { ...previewProject, status: pipeline.status, current_stage: pipeline.state.current_stage, pipeline_state: pipeline.state };
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

const artifact = (relativePath: string, validated = true) => ({
  relative_path: relativePath,
  exists: true,
  validated,
  size_bytes: 42 * 1024 ** 2,
  updated_at: now,
  error: null,
});

const previewArtifacts: ArtifactSummary = {
  frames_manifest: artifact("frames/manifest.json"),
  colmap_result: artifact("colmap/sparse/0"),
  latest_checkpoint: previewCheckpoint,
  scene_ply: artifact("output/scene.ply", false),
  output_manifest: artifact("output/manifest.json", false),
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
  source_path: "D:\\Captures\\courtyard_walkthrough.mp4",
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
    { id: "fast", name: "快速", description: "快速检查构图和覆盖", fps: 2, max_frames: 220, target_long_edge: 1440, colmap_long_edge: 1280, iterations: 12_000, sh_degree: 2, checkpoint_interval: 3_000, estimated_frames: 220, estimated_disk_bytes: 1.8 * 1024 ** 3 },
    { id: "balanced", name: "均衡", description: "推荐用于大多数桌面场景", fps: 7, max_frames: 500, target_long_edge: 1920, colmap_long_edge: 1600, iterations: 30_000, sh_degree: 3, checkpoint_interval: 5_000, estimated_frames: 428, estimated_disk_bytes: 4.6 * 1024 ** 3 },
    { id: "quality", name: "高质量", description: "保留更多几何纹理细节", fps: 12, max_frames: 800, target_long_edge: 2560, colmap_long_edge: 1920, iterations: 45_000, sh_degree: 3, checkpoint_interval: 5_000, estimated_frames: 738, estimated_disk_bytes: 9.8 * 1024 ** 3 },
  ],
  preview_items: [],
  warnings: ["18 帧存在轻微运动模糊", "3 段亮度变化，可自动校正"],
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
    { event_id: "evt-42", project_id: previewProject.id, sequence: 42, timestamp: now, kind: "stage_progress", severity: "info", phase_id: "training", stage_id: "BrushTraining", user_message: "训练稳定进行中，当前已完成 20,400 / 30,000 次迭代。", technical_message: null, metrics: { loss: 0.0138 }, source_log: "logs/BrushTraining.log" },
  ],
  next_cursor: null,
  total: 1,
};

export function isUiPreviewMode(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).has("ui-preview");
}

export function resolveUiPreviewCommand(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "app_version": return "0.1.0-preview";
    case "check_engines": return previewEngines;
    case "list_recent_projects":
    case "list_recent_project_index": return [currentPreviewProjectInfo(), ...previewProjects.slice(1)];
    case "check_recent_project_availability": {
      const projectId = String(args?.projectId ?? previewProjectInfo.id);
      const projects = [currentPreviewProjectInfo(), ...previewProjects.slice(1)];
      const project = projects.find((item) => item.id === projectId) ?? currentPreviewProjectInfo();
      return {
        project_id: project.id,
        checked_path: project.path,
        availability: "available",
        checked_at: now,
        reason_code: null,
        refreshed_project: project,
      } satisfies ProjectAvailabilityResult;
    }
    case "get_app_settings":
    case "save_app_settings": return previewSettings;
    case "get_resource_metrics": return previewMetrics;
    case "get_active_pipeline_summary":
      return new URLSearchParams(window.location.search).get("preview-page") === "new-project"
        ? null
        : currentPreviewPipeline();
    case "get_pipeline_state": return currentPreviewPipeline();
    case "open_project": return currentPreviewProject();
    case "get_project_artifacts": return previewArtifacts;
    case "list_checkpoints": return [previewCheckpoint];
    case "inspect_ply": return previewPly;
    case "get_pipeline_events": return previewEvents;
    case "analyze_media": return previewAnalysis;
    case "get_image_previews": return [];
    case "preflight_project": return previewPreflight;
    case "open_project_location": return { opened_path: previewProjectPath, missing: false, message: null };
    case "ensure_output_directory": return `${previewProjectPath}\\output`;
    case "cancel_project_creation":
    case "remove_recent_project": return undefined;
    default:
      throw new Error(`UI preview does not provide command: ${command}`);
  }
}
