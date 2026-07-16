/// <reference types="../vite-env" />

/** Project lifecycle status, matching `splat_domain::project::ProjectStatus`. */
export type ProjectStatus =
  | "creating"
  | "starting"
  | "ready"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "recovering"
  | "completed"
  | "failed";

/** Source media for a project, matching `splat_domain::project::ProjectSource`. */
export type ProjectSource =
  | { type: "Video"; filename: string; copied_to_project: boolean }
  | {
      type: "ImageFolder";
      folder_name: string;
      image_count: number;
      copied_to_project: boolean;
    };

/** Project settings, matching `splat_domain::project::ProjectSettings`. */
export interface ProjectSettings {
  preset: string;
  max_frames: number;
  max_long_edge: number;
  colmap_max_long_edge: number;
  frame_fps: number | null;
  iterations: number | null;
  sh_degree: number | null;
  checkpoint_interval: number | null;
}

/** Full project data, matching `splat_domain::project::Project`. */
export interface Project {
  schema_version: number;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  source: ProjectSource | null;
  settings: ProjectSettings;
  status: ProjectStatus;
  current_stage: string | null;
  pipeline_state: import("./pipeline").PipelineState;
}

/** Lightweight project info for the recent projects list. */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  updated_at: string;
  stage_label?: string;
}

/** Result returned by the `create_project` Tauri command. */
export interface CreateProjectResult {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  start_after_create: boolean;
}

export interface DeleteProjectRequest {
  projectId: string;
  projectPath: string;
}

export interface DeleteProjectResult {
  project_id: string;
  deleted_path: string;
  removed_from_recent: boolean;
}

/** Preset option presented in the UI. */
export interface PresetEstimate {
  id: string;
  name: string;
  description: string;
  fps: number;
  max_frames: number;
  target_long_edge: number;
  colmap_long_edge: number;
  iterations: number;
  sh_degree: number;
  checkpoint_interval: number;
  estimated_frames: number;
  estimated_disk_bytes: number;
}

/** Video metadata from FFprobe, matching `splat_engine_ffmpeg::probe::VideoMetadata`. */
export interface VideoMetadata {
  width: number;
  height: number;
  fps: number;
  frame_count: number;
  duration_seconds: number;
  codec: string;
  rotation: number | null;
}

/** Result of media analysis before project creation. */
export interface MediaAnalysis {
  source_kind: "video" | "images";
  source_path: string;
  display_name: string;
  size_bytes: number;
  valid: boolean;
  video_metadata: VideoMetadata | null;
  image_set_metadata: ImageSetMetadata | null;
  preset_estimates: PresetEstimate[];
  preview_items: string[];
  warnings: string[];
  blockers: string[];
}

export interface ImageSetMetadata {
  image_count: number;
  ignored_count: number;
  invalid_count: number;
  total_size_bytes: number;
  formats: Record<string, number>;
}

export interface ImagePreview {
  relative_path: string;
  display_name: string;
  width: number;
  height: number;
  data_url: string;
}

export interface EngineCheck {
  name: string;
  available: boolean;
  path: string | null;
  expected_version: string | null;
  actual_version: string | null;
  diagnostic: string | null;
  source: string | null;
  integrity_status: string | null;
}

export interface ProjectPreflight {
  can_continue: boolean;
  engine_checks: EngineCheck[];
  estimated_frames: number;
  estimated_disk_bytes: number;
  available_disk_bytes: number;
  recommended_preset: string;
  warnings: string[];
  blockers: string[];
}

export interface CreateProjectRequest {
  name: string;
  sourcePath: string;
  preset: string;
  projectRoot: string | null;
  startAfterCreate: boolean;
}

export interface ProjectCopyProgress {
  project_id: string;
  copied_bytes: number;
  total_bytes: number;
  percent: number;
  completed: boolean;
}
