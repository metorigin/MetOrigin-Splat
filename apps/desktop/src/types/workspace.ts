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
  splat_count: number | null;
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
