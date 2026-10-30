export interface AppSettings {
  engine_directory: string | null;
  engine_executables: Record<string, string>;
  default_project_root: string | null;
  default_preset: string;
  create_and_start: boolean;
  prevent_idle_sleep: boolean;
  log_retention_mb: number;
  thumbnail_cache_mb: number;
}

export interface GpuMetrics {
  name: string;
  driver_version: string | null;
  memory_total_bytes: number | null;
  memory_used_bytes: number | null;
  utilization_percent: number | null;
  temperature_celsius: number | null;
}

export interface ResourceMetrics {
  timestamp: string;
  operating_system: string;
  cpu_name: string | null;
  cpu_usage_percent: number | null;
  memory_total_bytes: number;
  memory_used_bytes: number;
  project_disk_available_bytes: number | null;
  disk_path: string | null;
  gpu: GpuMetrics | null;
  memory?: MemoryObservation;
  processes?: ProcessMemory[];
  runtime?: RuntimeResourceSummary | null;
  preview_policy?: PreviewResourcePolicy;
  warnings: string[];
}

export interface DiagnosticExport {
  path: string;
  size_bytes: number;
}

export type MemoryPressure = "normal" | "warning" | "critical";
export interface MemoryObservation {
  kind: "unified" | "system";
  available_bytes: number | null;
  available_source?: string | null;
  available_is_estimate?: boolean;
  free_bytes?: number | null;
  inactive_bytes?: number | null;
  compressed_bytes?: number | null;
  pressure: MemoryPressure | null;
  pressure_source: string | null;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
}
export interface PreviewResourcePolicy {
  action: "allow" | "pause" | "release";
  reason: string | null;
  memory_pressure: MemoryPressure | null;
  poll_interval_ms: number;
  max_snapshot_bytes: number;
}
export interface ProcessMemory {
  pid: number;
  role: "application" | "brush" | "colmap" | "webkit";
  resident_bytes: number;
}
export interface RuntimeResourceSummary {
  requested_preset: string | null;
  colmap_backend: string;
  brush_backend: string;
  device_name: string | null;
  training_budget_bytes: number | null;
  recommended_working_set_bytes: number | null;
  effective_training: {
    iterations: number;
    sh_degree: number;
    resolution?: number | null;
    image_cache_budget_bytes?: number | null;
    max_splats?: number | null;
    threads: number;
    lod_levels?: number | null;
  };
}
