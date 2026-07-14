/// <reference types="../vite-env" />

/** Project lifecycle status, matching `splat_domain::project::ProjectStatus`. */
export type ProjectStatus =
  | "creating"
  | "ready"
  | "running"
  | "paused"
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
}

/** Preset option presented in the UI. */
export interface PresetOption {
  id: string;
  name: string;
  description: string;
  estimated_time: string;
  iterations: number;
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
  type: "video" | "images";
  video_metadata?: VideoMetadata;
  image_count?: number;
  estimated_frames: number;
  estimated_disk_mb: number;
  valid: boolean;
  error?: string;
}
