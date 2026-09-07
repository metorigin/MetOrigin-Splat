export interface AppSettings {
  engine_directory: string | null;
  engine_executables: Record<string, string>;
  default_project_root: string | null;
  default_preset: string;
  create_and_start: boolean;
  log_retention_mb: number;
  thumbnail_cache_mb: number;
}

export interface GpuMetrics {
  name: string;
  driver_version: string | null;
  memory_total_bytes: number;
  memory_used_bytes: number;
  utilization_percent: number | null;
  temperature_celsius: number | null;
}

export interface ResourceMetrics {
  timestamp: string;
  operating_system: string;
  cpu_name: string | null;
  cpu_usage_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  project_disk_available_bytes: number | null;
  disk_path: string | null;
  gpu: GpuMetrics | null;
  warnings: string[];
}

export interface DiagnosticExport {
  path: string;
  size_bytes: number;
}
