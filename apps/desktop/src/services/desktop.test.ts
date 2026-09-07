import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { DesktopCommandError, desktopApi, selectImageDirectory } from "./desktop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));

describe("image folder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["D:\\datasets\\自行车\\images\\DSC06134.JPG", "D:\\datasets\\自行车\\images"],
    ["D:/captures/frame.png", "D:/captures"],
    ["C:\\image.jpg", "C:\\"],
    ["/image.jpeg", "/"],
    ["\\\\server\\share\\image.JPG", "\\\\server\\share"],
  ])("browses images and imports their containing folder: %s", async (image, folder) => {
    vi.mocked(open).mockResolvedValue(image);
    await expect(selectImageDirectory()).resolves.toBe(folder);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      directory: false,
      multiple: false,
      filters: [{ name: "图片文件", extensions: ["jpg", "jpeg", "png"] }],
    }));
  });

  it("keeps the existing source when the image browser is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(selectImageDirectory()).resolves.toBeNull();
  });
});

describe("desktop invoke boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes structured and legacy command failures once", async () => {
    vi.mocked(invoke).mockRejectedValue(JSON.stringify({
      code: "E-ENGINES",
      title: "引擎不可用",
      message: "需要修复",
      retryable: false,
    }));
    await expect(desktopApi.checkEngines()).rejects.toMatchObject({
      name: "DesktopCommandError",
      code: "E-ENGINES",
      message: "需要修复",
    });

    vi.mocked(invoke).mockRejectedValue("legacy failure");
    await expect(desktopApi.appVersion()).rejects.toBeInstanceOf(DesktopCommandError);
  });

  it("keeps raw Tauri invoke imports out of pages, components, and hooks", () => {
    const modules = import.meta.glob("../**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const violations = Object.entries(modules)
      .filter(([path]) => !path.includes(".test.") && path !== "./desktop.ts")
      .filter(([, source]) => source.includes('import { invoke } from "@tauri-apps/api/core"'))
      .map(([path]) => path);
    expect(violations).toEqual([]);
  });

  it("exposes preview and guarded execution through the additive command boundary", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ previewToken: "opaque-token" })
      .mockResolvedValueOnce({ kind: "completed", receipt: { id: "receipt-1" } });

    await desktopApi.previewWorkspaceAction({
      projectId: "project-a",
      projectPath: "D:\\projects\\project-a",
      action: "cancel",
    });
    await desktopApi.executeWorkspaceAction("opaque-token");

    expect(invoke).toHaveBeenNthCalledWith(1, "preview_workspace_action", {
      request: {
        projectId: "project-a",
        projectPath: "D:\\projects\\project-a",
        action: "cancel",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "execute_workspace_action", {
      previewToken: "opaque-token",
    });
  });

  it("keeps high-impact UI surfaces from invoking legacy mutations directly", () => {
    const modules = import.meta.glob([
      "../App.tsx",
      "../pages/ProjectDetailPage.tsx",
      "../components/shell/TitleRunBar.tsx",
      "../components/shell/DeleteProjectDialog.tsx",
      "../components/workspace/CheckpointDrawer.tsx",
    ], {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const legacyCalls = [
      ".pausePipeline(",
      ".cancelPipeline(",
      ".rerunFromStage(",
      ".restoreCheckpoint(",
      ".deleteCheckpoint(",
      ".deleteProject(",
    ];
    const violations = Object.entries(modules).flatMap(([path, source]) =>
      legacyCalls.filter((call) => source.includes(call)).map((call) => `${path}:${call}`),
    );
    expect(violations).toEqual([]);
  });

  it("uses additive recent-index, availability, and relink commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({
        project_id: "project-a",
        checked_path: "D:\\projects\\project-a",
        availability: "available",
        checked_at: "2026-08-14T08:00:00Z",
        reason_code: null,
        refreshed_project: null,
      })
      .mockResolvedValueOnce({ id: "project-a", path: "D:\\moved\\project-a" });

    await desktopApi.listRecentProjectIndex();
    await desktopApi.checkRecentProjectAvailability("project-a", "D:\\projects\\project-a");
    await desktopApi.relinkRecentProject({
      projectId: "project-a",
      previousPath: "D:\\projects\\project-a",
      candidatePath: "D:\\moved\\project-a",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "list_recent_project_index", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "check_recent_project_availability", {
      projectId: "project-a",
      projectPath: "D:\\projects\\project-a",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "relink_recent_project", {
      request: {
        projectId: "project-a",
        previousPath: "D:\\projects\\project-a",
        candidatePath: "D:\\moved\\project-a",
      },
    });
  });
});
