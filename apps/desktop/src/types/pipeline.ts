/// <reference types="../vite-env" />

/** All 12 pipeline stage IDs. */
export const PIPELINE_STAGE_IDS = [
  "MediaValidation",
  "FrameExtraction",
  "ImagePreprocessing",
  "ColmapFeatureExtraction",
  "ColmapMatching",
  "ColmapMapping",
  "ColmapValidation",
  "TrainingPreparation",
  "BrushTraining",
  "ModelValidation",
  "PreviewGeneration",
  "Export",
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

/** Human-readable label for each stage ID. */
export const STAGE_LABELS: Record<PipelineStageId, string> = {
  MediaValidation: "Media Validation",
  FrameExtraction: "Frame Extraction",
  ImagePreprocessing: "Image Preprocessing",
  ColmapFeatureExtraction: "COLMAP Feature Extraction",
  ColmapMatching: "COLMAP Matching",
  ColmapMapping: "COLMAP Mapping",
  ColmapValidation: "COLMAP Validation",
  TrainingPreparation: "Training Preparation",
  BrushTraining: "Brush Training",
  ModelValidation: "Model Validation",
  PreviewGeneration: "Preview Generation",
  Export: "Export",
};

/** Emoji / icon for each stage status. */
export const STAGE_ICONS: Record<StageStatus, string> = {
  pending: "○",
  preparing: "◐",
  running: "●",
  pausing: "◒",
  paused: "⊘",
  cancelling: "◐",
  cancelled: "✕",
  completed: "✓",
  failed: "✗",
  skipped: "→",
};

/** Stage status, matching `splat_domain::pipeline::StageStatus`. */
export type StageStatus =
  | "pending"
  | "preparing"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "skipped";

/** State of a single pipeline stage, matching `splat_domain::pipeline::StageState`. */
export interface StageState {
  stage_id: PipelineStageId;
  status: StageStatus;
  progress: number;
  started_at: string | null;
  ended_at: string | null;
  retry_count: number;
  error: string | null;
  log_path: string | null;
}

/** Progress update, matching `splat_domain::progress::TaskProgress`. */
export interface TaskProgress {
  stage_id: string;
  percent: number;
  message: string;
  current_item: number;
  total_items: number;
}

/** Full pipeline state snapshot, matching `splat_domain::pipeline::PipelineState`. */
export interface PipelineState {
  stages: Record<string, StageState>;
  current_stage: PipelineStageId | null;
  overall_progress: number;
}

/** Events emitted by the pipeline orchestrator. */
export type PipelineEvent =
  | { type: "stage_started"; stage_id: PipelineStageId }
  | { type: "stage_completed"; stage_id: PipelineStageId }
  | { type: "stage_failed"; stage_id: PipelineStageId; error: string }
  | { type: "stage_skipped"; stage_id: PipelineStageId }
  | { type: "stage_progress"; progress: TaskProgress }
  | { type: "pipeline_completed" }
  | { type: "pipeline_failed"; error: string }
  | { type: "pipeline_cancelled" };

/** Engine info, matching `splat_domain::hardware::EngineInfo`. */
export interface EngineInfo {
  name: string;
  version: string | null;
  path: string | null;
  available: boolean;
}
