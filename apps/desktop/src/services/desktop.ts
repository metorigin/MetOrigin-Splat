import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";

import type {
  CreateProjectRequest,
  CreateProjectResult,
  DeleteProjectRequest,
  DeleteProjectResult,
  EngineInfo,
  MediaAnalysis,
  ImagePreview,
  PipelineControlResult,
  PipelineSnapshot,
  Project,
  ProjectInfo,
  ProjectAvailabilityResult,
  RelinkRecentProjectRequest,
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
  OpenProjectLocationRequest,
  OpenProjectLocationResult,
  OpenEngineLocationResult,
  ActivePipelineSummary,
  ActionImpactPreview,
  WorkspaceActionExecution,
  WorkspaceActionRequest,
} from "../types";
import { normalizeCommandError } from "./errors";

export class DesktopCommandError extends Error {
  readonly code: string;
  readonly uiError: ReturnType<typeof normalizeCommandError>;

  constructor(command: string, cause: unknown) {
    const uiError = normalizeCommandError(cause, command);
    super(uiError.message);
    this.name = "DesktopCommandError";
    this.code = uiError.code;
    this.uiError = uiError;
  }
}

export async function invokeDesktopCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw error instanceof DesktopCommandError
      ? error
      : new DesktopCommandError(command, error);
  }
}

const invoke = invokeDesktopCommand;

export const ACTIVE_PIPELINE_CONFLICT_CODE = "UI-PIPELINE-ACTIVE-CONFLICT";

export function isActivePipelineConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code) === ACTIVE_PIPELINE_CONFLICT_CODE;
  }
  const message = String(error);
  if (message.includes(ACTIVE_PIPELINE_CONFLICT_CODE)) return true;
  try {
    const payload = JSON.parse(message) as { code?: string };
    return payload.code === ACTIVE_PIPELINE_CONFLICT_CODE;
  } catch {
    return false;
  }
}

export function isDesktopRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function ensureDesktopRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error("此操作需要在 MetOrigin Splat 桌面应用中使用。");
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
    title: "打开 MetOrigin Splat 项目",
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

export async function confirmRerunStage(stageLabel: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(
    `将从“${stageLabel}”重新运行，并重置该阶段及后续阶段的状态。已验证的更早阶段会保留。`,
    {
      title: "从指定阶段重新运行",
      kind: "warning",
      okLabel: "重置并开始",
      cancelLabel: "取消",
    },
  );
}

export async function confirmDiscardProjectDraft(): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm("尚未提交的素材选择、方案和项目名称将会丢失。是否退出创建向导？", {
    title: "退出项目创建",
    kind: "warning",
    okLabel: "退出并放弃",
    cancelLabel: "继续编辑",
  });
}

export async function confirmCancelProjectCreationExit(): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm("素材仍在复制。将先请求安全取消并清理未完成目录，确认取消吗？", {
    title: "取消项目创建",
    kind: "warning",
    okLabel: "安全取消",
    cancelLabel: "继续创建",
  });
}

export async function confirmRemoveRecentProject(projectName: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(`仅从最近项目列表移除“${projectName}”，磁盘中的项目文件会保留。`, {
    title: "从最近项目移除",
    kind: "warning",
    okLabel: "移除记录",
    cancelLabel: "取消",
  });
}

export const desktopApi = {
  appVersion: () => invoke<string>("app_version"),
  checkEngines: () => invoke<EngineInfo[]>("check_engines"),
  listRecentProjects: () =>
    invoke<ProjectInfo[]>("list_recent_projects"),
  listRecentProjectIndex: () =>
    invoke<ProjectInfo[]>("list_recent_project_index"),
  checkRecentProjectAvailability: (projectId: string, projectPath: string) =>
    invoke<ProjectAvailabilityResult>("check_recent_project_availability", { projectId, projectPath }),
  relinkRecentProject: (request: RelinkRecentProjectRequest) =>
    invoke<ProjectInfo>("relink_recent_project", { request }),
  removeRecentProject: (projectId: string, projectPath: string) =>
    invoke<void>("remove_recent_project", { projectId, projectPath }),
  deleteProject: (request: DeleteProjectRequest) =>
    invoke<DeleteProjectResult>("delete_project", { request }),
  openProjectLocation: (request: OpenProjectLocationRequest) =>
    invoke<OpenProjectLocationResult>("open_project_location", { request }),
  openEngineLocation: (engineName: string) =>
    invoke<OpenEngineLocationResult>("open_engine_location", { engineName }),
  analyzeMedia: (path: string) =>
    invoke<MediaAnalysis>("analyze_media", { path }),
  getImagePreviews: (path: string) =>
    invoke<ImagePreview[]>("get_image_previews", { path }),
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
  getActivePipelineSummary: () =>
    invoke<ActivePipelineSummary | null>("get_active_pipeline_summary"),
  previewWorkspaceAction: (request: WorkspaceActionRequest) =>
    invoke<ActionImpactPreview>("preview_workspace_action", { request }),
  executeWorkspaceAction: (previewToken: string) =>
    invoke<WorkspaceActionExecution>("execute_workspace_action", { previewToken }),
  retryStage: (projectPath: string, stageId: string) =>
    invoke<PipelineSnapshot>("retry_stage", { projectPath, stageId }),
  rerunFromStage: (projectPath: string, stageId: string) =>
    invoke<PipelineSnapshot>("rerun_from_stage", { projectPath, stageId }),
  acceptColmapQualityRisk: (projectPath: string) =>
    invoke<PipelineSnapshot>("accept_colmap_quality_risk", { projectPath }),
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
  ensureOutputDirectory: (projectPath: string) =>
    invoke<string>("ensure_output_directory", { projectPath }),
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
