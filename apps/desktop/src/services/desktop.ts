import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

import type {
  CreateProjectRequest,
  CreateProjectResult,
  EngineInfo,
  MediaAnalysis,
  PipelineControlResult,
  PipelineSnapshot,
  Project,
  ProjectInfo,
  ProjectPreflight,
  ArtifactSummary,
  CheckpointSummary,
  EventPage,
  FramePreview,
  PlyPreview,
  SparsePreviewPack,
  AppSettings,
  DiagnosticExport,
  ResourceMetrics,
} from "../types";

function ensureDesktopRuntime(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("此操作需要在 MetaOrigin Splat 桌面应用中使用。");
  }
}

export async function selectVideoFile(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: "选择重建视频",
    multiple: false,
    directory: false,
    filters: [
      {
        name: "视频文件",
        extensions: ["mp4", "mov", "avi", "mkv"],
      },
    ],
  });
}

export async function selectImageDirectory(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: "选择图片文件夹",
    multiple: false,
    directory: true,
    recursive: true,
  });
}

export async function selectProjectDirectory(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: "打开 MetaOrigin Splat 项目",
    multiple: false,
    directory: true,
  });
}

export async function selectProjectRoot(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: "选择项目保存位置",
    multiple: false,
    directory: true,
    recursive: true,
  });
}

export async function selectEngineDirectory(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({ title: "选择引擎目录", multiple: false, directory: true, recursive: true });
}

export async function selectEngineExecutable(name: string): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: `选择 ${name} 可执行文件`,
    multiple: false,
    directory: false,
    filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
  });
}

export async function openDirectory(path: string): Promise<void> {
  ensureDesktopRuntime();
  await openPath(path);
}

export async function confirmSafeCancel(stageLabel: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(
    `将停止${stageLabel}并保留已验证阶段与合法检查点。当前阶段下次可能需要重新执行。`,
    {
      title: "安全取消重建",
      kind: "warning",
      okLabel: "安全取消",
      cancelLabel: "继续运行",
    },
  );
}

export const desktopApi = {
  appVersion: () => invoke<string>("app_version"),
  checkEngines: () => invoke<EngineInfo[]>("check_engines"),
  listRecentProjects: () =>
    invoke<ProjectInfo[]>("list_recent_projects"),
  analyzeMedia: (path: string) =>
    invoke<MediaAnalysis>("analyze_media", { path }),
  preflightProject: (request: {
    sourcePath: string;
    projectRoot: string | null;
    preset: string;
  }) => invoke<ProjectPreflight>("preflight_project", { request }),
  createProject: (request: CreateProjectRequest) =>
    invoke<CreateProjectResult>("create_project", { request }),
  cancelProjectCreation: () => invoke<void>("cancel_project_creation"),
  openProject: (path: string) => invoke<Project>("open_project", { path }),
  startPipeline: (projectPath: string) =>
    invoke<PipelineSnapshot>("start_pipeline", { projectPath }),
  cancelPipeline: () => invoke<void>("cancel_pipeline"),
  pausePipeline: () => invoke<PipelineControlResult>("pause_pipeline"),
  resumePipeline: (projectPath: string) =>
    invoke<PipelineSnapshot>("resume_pipeline", { projectPath }),
  getPipelineState: (projectPath?: string) =>
    invoke<PipelineSnapshot>("get_pipeline_state", { projectPath: projectPath ?? null }),
  retryStage: (projectPath: string, stageId: string) =>
    invoke<PipelineSnapshot>("retry_stage", { projectPath, stageId }),
  rerunFromStage: (projectPath: string, stageId: string) =>
    invoke<PipelineSnapshot>("rerun_from_stage", { projectPath, stageId }),
  getPipelineEvents: (projectPath: string, filters?: { stageId?: string; severity?: string; search?: string; cursor?: number }) =>
    invoke<EventPage>("get_pipeline_events", {
      projectPath,
      cursor: filters?.cursor ?? null,
      limit: 200,
      stageId: filters?.stageId ?? null,
      severity: filters?.severity ?? null,
      search: filters?.search ?? null,
    }),
  listCheckpoints: (projectPath: string) =>
    invoke<CheckpointSummary[]>("list_checkpoints", { projectPath }),
  restoreCheckpoint: (projectPath: string, iteration: number) =>
    invoke<CheckpointSummary[]>("restore_checkpoint", { projectPath, iteration }),
  deleteCheckpoint: (projectPath: string, iteration: number) =>
    invoke<void>("delete_checkpoint", { projectPath, iteration }),
  getProjectArtifacts: (projectPath: string) =>
    invoke<ArtifactSummary>("get_project_artifacts", { projectPath }),
  getFramePreview: (projectPath: string) =>
    invoke<FramePreview>("get_frame_preview", { projectPath }),
  getSparsePreviewPack: (projectPath: string) =>
    invoke<SparsePreviewPack>("get_sparse_preview_pack", { projectPath }),
  inspectPly: (projectPath: string, relativePath?: string) =>
    invoke<PlyPreview>("inspect_ply", { projectPath, relativePath: relativePath ?? null }),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  saveAppSettings: (settings: AppSettings) => invoke<AppSettings>("save_app_settings", { settings }),
  setEngineDirectory: (path: string) => invoke<AppSettings>("set_engine_directory", { path }),
  setEngineExecutable: (name: string, path: string) => invoke<AppSettings>("set_engine_executable", { name, path }),
  clearEngineOverride: (name?: string) => invoke<AppSettings>("clear_engine_override", { name: name ?? null }),
  getResourceMetrics: (projectPath?: string) => invoke<ResourceMetrics>("get_resource_metrics", { projectPath: projectPath ?? null }),
  exportDiagnostics: (projectPath: string) => invoke<DiagnosticExport>("export_diagnostics", { projectPath }),
};
