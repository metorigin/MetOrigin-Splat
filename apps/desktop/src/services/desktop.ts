import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

import type { EngineInfo, Project, ProjectInfo } from "../types";

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
  openProject: (path: string) => invoke<Project>("open_project", { path }),
  startPipeline: (projectPath: string) =>
    invoke<void>("start_pipeline", { projectPath }),
  cancelPipeline: () => invoke<void>("cancel_pipeline"),
  getPipelineState: () => invoke<import("../types").PipelineState>("get_pipeline_state"),
};
