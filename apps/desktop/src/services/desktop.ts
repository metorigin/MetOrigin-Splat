import { t } from "../i18n";
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
  GaussianPreviewSource,
  SavedModel,
  EditorSession,
  GaussianCamera,
  LivePreviewMode,
  LivePreviewStatus,
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
import { isUiPreviewMode, resolveUiPreviewCommand } from "./uiPreview";

export { isUiPreviewMode } from "./uiPreview";

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
    if (isUiPreviewMode()) {
      return resolveUiPreviewCommand(command, args) as T;
    }
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
    throw new Error(t("此操作需要在 MetOrigin Splat 桌面应用中使用。"));
  }
}

export async function selectVideoFile(): Promise<string | null> {
  if (isUiPreviewMode()) return "D:\\Captures\\courtyard_walkthrough.mp4";
  ensureDesktopRuntime();
  return open({
    title: t("选择重建视频"),
    multiple: false,
    directory: false,
    filters: [
      {
        name: t("视频文件"),
        extensions: ["mp4", "mov", "avi", "mkv"],
      },
    ],
  });
}

export async function selectImageDirectory(): Promise<string | null> {
  if (isUiPreviewMode()) return "D:\\Captures\\courtyard_images";
  ensureDesktopRuntime();
  // Windows' folder-only dialog hides files. Browse images, then use the
  // selected image's parent as the existing recursive folder import source.
  const imagePath = await open({
    title: t("选择任意一张图片，导入其所在文件夹"),
    multiple: false,
    directory: false,
    filters: [{ name: t("图片文件"), extensions: ["jpg", "jpeg", "png"] }],
  });
  if (!imagePath) return null;
  const separator = Math.max(imagePath.lastIndexOf("/"), imagePath.lastIndexOf("\\"));
  if (separator < 0) throw new Error(t("无法确定图片所在文件夹，请重新选择图片。"));
  // Preserve filesystem roots (C:\\, /) and UNC share paths.
  const end = separator === 2 && imagePath[1] === ":" ? 3 : Math.max(separator, 1);
  return imagePath.slice(0, end);
}

export async function selectProjectDirectory(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: t("打开 MetOrigin Splat 项目"),
    multiple: false,
    directory: true,
  });
}

export async function selectProjectRoot(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: t("选择项目保存位置"),
    multiple: false,
    directory: true,
    recursive: true,
  });
}

export async function selectEngineDirectory(): Promise<string | null> {
  ensureDesktopRuntime();
  return open({ title: t("选择引擎目录"), multiple: false, directory: true, recursive: true });
}

export async function selectEngineExecutable(name: string): Promise<string | null> {
  ensureDesktopRuntime();
  return open({
    title: t("选择 {0} 可执行文件", name),
    multiple: false,
    directory: false,
    filters: [{ name: t("Windows 可执行文件"), extensions: ["exe"] }],
  });
}

export async function confirmSafeCancel(stageLabel: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(
    t("将停止{0}并保留已验证阶段与合法检查点。当前阶段下次可能需要重新执行。", stageLabel),
    {
      title: t("安全取消重建"),
      kind: "warning",
      okLabel: t("安全取消"),
      cancelLabel: t("继续运行"),
    },
  );
}

export async function confirmRerunStage(stageLabel: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(
    t("将从“{0}”重新运行，并重置该阶段及后续阶段的状态。已验证的更早阶段会保留。", stageLabel),
    {
      title: t("从指定阶段重新运行"),
      kind: "warning",
      okLabel: t("重置并开始"),
      cancelLabel: t("取消"),
    },
  );
}

export async function confirmRemoveRecentProject(projectName: string): Promise<boolean> {
  ensureDesktopRuntime();
  return confirm(t("仅从最近项目列表移除“{0}”，磁盘中的项目文件会保留。", projectName), {
    title: t("从最近项目移除"),
    kind: "warning",
    okLabel: t("移除记录"),
    cancelLabel: t("取消"),
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
  getGaussianPreview: (projectId: string, projectPath: string, relativePath?: string | null) =>
    invoke<GaussianPreviewSource>("get_gaussian_preview", { projectId, projectPath, relativePath: relativePath ?? null }),
  openModelEditor: (projectId: string, projectPath: string) =>
    invoke<EditorSession>("open_model_editor", { projectId, projectPath }),
  closeModelEditor: (sessionId: string) => invoke<void>("close_model_editor", { sessionId }),
  saveEditedPly: async (sessionId: string, bytes: ArrayBuffer): Promise<SavedModel> => {
    try { return await tauriInvoke<SavedModel>("save_edited_ply", new Uint8Array(bytes), { headers: { "x-editor-session": sessionId } }); }
    catch (error) { throw new DesktopCommandError("save_edited_ply", error); }
  },
  getGaussianCamera: (projectId: string, projectPath: string) =>
    invoke<GaussianCamera | null>("get_gaussian_camera", { projectId, projectPath }),
  readGaussianPly: (projectId: string, projectPath: string, source: GaussianPreviewSource) =>
    invoke<ArrayBuffer>("read_gaussian_ply", { projectId, projectPath, relativePath: source.relative_path, expectedRevision: source.revision }),
  pollLivePreview: (projectId: string, projectPath: string, mode: LivePreviewMode, afterRevision: number, sessionId: string | null) =>
    invoke<LivePreviewStatus>("poll_live_preview", { projectId, projectPath, mode, afterRevision, sessionId }),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  saveAppSettings: (settings: AppSettings) => invoke<AppSettings>("save_app_settings", { settings }),
  setEngineDirectory: (path: string) => invoke<AppSettings>("set_engine_directory", { path }),
  setEngineExecutable: (name: string, path: string) => invoke<AppSettings>("set_engine_executable", { name, path }),
  clearEngineOverride: (name?: string) => invoke<AppSettings>("clear_engine_override", { name: name ?? null }),
  getResourceMetrics: (projectPath?: string) => invoke<ResourceMetrics>("get_resource_metrics", { projectPath: projectPath ?? null }),
  exportDiagnostics: (projectPath: string) => invoke<DiagnosticExport>("export_diagnostics", { projectPath }),
};
