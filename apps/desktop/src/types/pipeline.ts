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

export interface PipelineSnapshot {
  project_id: string;
  project_path: string;
  status: import("./project").ProjectStatus;
  state: PipelineState;
  sequence: number;
  accepted_at: string | null;
  started_at: string | null;
  control_intent: "none" | "pause" | "cancel";
}

export interface PipelineControlResult {
  project_id: string;
  status: import("./project").ProjectStatus;
  stopped: boolean;
  preserved_checkpoint: string | null;
}

export interface PipelineEventEnvelope {
  project_id: string;
  sequence: number;
  timestamp: string;
  event: {
    kind: string;
    stage_id?: PipelineStageId;
    progress?: TaskProgress;
  };
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
  source?: "environment" | "resource" | "configured_or_path" | "missing";
  checked_at?: string;
}
