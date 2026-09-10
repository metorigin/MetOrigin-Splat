export interface PipelineEventRecord {
  event_id: string;
  project_id: string;
  sequence: number;
  timestamp: string;
  kind: string;
  severity: "info" | "warning" | "error" | string;
  phase_id: string | null;
  stage_id: string | null;
  user_message: string;
  technical_message: string | null;
  metrics: unknown;
  source_log: string | null;
}

export interface EventPage {
  items: PipelineEventRecord[];
  next_cursor: number | null;
  total: number;
}

export interface CheckpointSummary {
  iteration: number;
  relative_path: string;
  size_bytes: number;
  created_at: string;
  vertex_count: number;
  valid: boolean;
  current: boolean;
  brush_version: string;
}

export interface ArtifactItem {
  relative_path: string;
  exists: boolean;
  validated: boolean;
  size_bytes: number;
  updated_at: string | null;
  error: string | null;
}

export interface ArtifactSummary {
  frames_manifest: ArtifactItem;
  colmap_result: ArtifactItem;
  latest_checkpoint: CheckpointSummary | null;
  scene_ply: ArtifactItem;
  output_manifest: ArtifactItem;
  registered_images: number | null;
  total_images: number | null;
  sparse_points: number | null;
  mean_reprojection_error: number | null;
  colmap_validation: ColmapValidationReport | null;
  colmap_attempts: ColmapAttemptResult[];
  splat_count: number | null;
}

export type ColmapQualityDecision =
  | "pass"
  | "requires_confirmation"
  | "blocked"
  | "accepted_with_warning";

export interface ColmapValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: "Info" | "Warning" | "Critical" | string;
}

export interface ColmapValidationReport {
  passed: boolean;
  decision: ColmapQualityDecision;
  checks: ColmapValidationCheck[];
  largest_component_images: number;
  largest_component_coverage: number;
  largest_missing_segment: number;
  automatic_fallbacks_exhausted: boolean;
  model_hash: string | null;
}

export interface ColmapAttemptResult {
  id: string;
  matching_strategy: string;
  mapper: string;
  status: "completed" | "failed";
  model_path: string | null;
  model_info: {
    cameras: number;
    images: number;
    registered_images: number;
    point_count: number;
    observations: number;
    mean_track_length: number;
    mean_reprojection_error: number;
  } | null;
  error: string | null;
}

export interface FramePreview {
  items: string[];
  total_frames: number;
}

export interface PreviewPoint {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

export interface PreviewCamera {
  x: number;
  y: number;
  z: number;
  forward_x?: number;
  forward_y?: number;
  forward_z?: number;
  up_x?: number;
  up_y?: number;
  up_z?: number;
  name: string;
}

export interface SparsePreviewPack {
  model_path: string;
  registered_images: number;
  total_images: number;
  point_count: number;
  mean_reprojection_error: number | null;
  points: PreviewPoint[];
  cameras: PreviewCamera[];
}

export interface PlyPreview {
  relative_path: string;
  format: string;
  vertex_count: number;
  size_bytes: number;
  gaussian_compatible: boolean;
  points: PreviewPoint[];
}

export type LivePreviewMode = "live" | "low" | "off";

export interface SavedModel {
  source: GaussianPreviewSource;
  saved_at: string;
}

export interface EditorSession {
  session_id: string;
  project_id: string;
  project_path: string;
  project_name: string;
  source: GaussianPreviewSource;
}

export interface GaussianCamera {
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  fov_y_degrees: number;
}

export interface GaussianPreviewSource {
  relative_path: string;
  revision: string;
  vertex_count: number;
  size_bytes: number;
  iteration: number | null;
}

export interface LivePreviewStatus {
  session_id: string | null;
  available: boolean;
  running: boolean;
  revision: number;
  frame: GaussianPreviewSource | null;
}

export type ProjectLocationTarget = "project_root" | "output_directory" | "artifact";

export interface OpenProjectLocationRequest {
  projectId: string;
  projectPath: string;
  targetType: ProjectLocationTarget;
  relativePath?: string;
}

export interface OpenProjectLocationResult {
  opened: boolean;
  missing: boolean;
  target_type: ProjectLocationTarget;
  message: string | null;
}

export interface OpenEngineLocationResult {
  opened: boolean;
  engine_name: string;
}
