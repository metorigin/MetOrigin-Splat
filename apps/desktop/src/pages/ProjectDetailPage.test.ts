import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProvider } from "../context";
import type { ArtifactSummary, CheckpointSummary, PipelineState, Project, StageState } from "../types";
import { desktopApi } from "../services/desktop";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { phaseStatus, plyActionState, stageStatusLabel } from "./projectTimeline";

const invokeMock = vi.hoisted(() => vi.fn());
const workspaceApi = vi.hoisted(() => ({
  getProjectArtifacts: vi.fn(),
  listCheckpoints: vi.fn(),
  getPipelineEvents: vi.fn(),
  getFramePreview: vi.fn(),
  getSparsePreviewPack: vi.fn(),
  inspectPly: vi.fn(),
  restoreCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
  previewWorkspaceAction: vi.fn(),
  executeWorkspaceAction: vi.fn(),
  getPipelineState: vi.fn(),
  startPipeline: vi.fn(),
  retryStage: vi.fn(),
  openProjectLocation: vi.fn(),
  getActivePipelineSummary: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => path,
}));

vi.mock("../services/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/desktop")>();
  return {
    ...actual,
    desktopApi: workspaceApi,
    confirmRerunStage: vi.fn().mockResolvedValue(true),
    isActivePipelineConflict: () => false,
  };
});

function stage(stageId: StageState["stage_id"], status: StageState["status"], progress = 0): StageState {
  return {
    stage_id: stageId,
    status,
    progress,
    started_at: null,
    ended_at: null,
    retry_count: 0,
    error: null,
    log_path: null,
  };
}

const mediaPhase = {
  id: "media",
  label: "素材准备",
  description: "",
  stages: ["MediaValidation", "FrameExtraction", "ImagePreprocessing"] as const,
};

describe("project timeline status", () => {
  it("marks a phase running when frame extraction is active", () => {
    const state: PipelineState = {
      stages: {
        MediaValidation: stage("MediaValidation", "completed", 1),
        FrameExtraction: stage("FrameExtraction", "running", 0.57),
        ImagePreprocessing: stage("ImagePreprocessing", "pending"),
      },
      current_stage: "FrameExtraction",
      overall_progress: 0.04,
    };
    expect(phaseStatus(state, { ...mediaPhase, stages: [...mediaPhase.stages] })).toBe("running");
    expect(stageStatusLabel("running", 0.57)).toBe("运行中 · 57%");
  });

  it("treats completed and cached stages as a completed phase", () => {
    const state: PipelineState = {
      stages: {
        MediaValidation: stage("MediaValidation", "completed", 1),
        FrameExtraction: stage("FrameExtraction", "skipped", 1),
        ImagePreprocessing: stage("ImagePreprocessing", "completed", 1),
      },
      current_stage: null,
      overall_progress: 0.08,
    };
    expect(phaseStatus(state, { ...mediaPhase, stages: [...mediaPhase.stages] })).toBe("completed");
  });
});

describe("PLY quality action", () => {
  it("explains missing and invalid PLY states", () => {
    expect(plyActionState(null).ready).toBe(false);
    expect(plyActionState({
      relative_path: "output/scene.ply",
      exists: true,
      validated: false,
      size_bytes: 10,
      updated_at: null,
      error: "文件损坏",
    })).toEqual({ ready: false, message: "文件损坏" });
  });

  it("enables a validated PLY", () => {
    expect(plyActionState({
      relative_path: "output/scene.ply",
      exists: true,
      validated: true,
      size_bytes: 10,
      updated_at: null,
      error: null,
    }).ready).toBe(true);
  });
});

const project: Project = {
  schema_version: 1,
  id: "project-1",
  name: "测试项目",
  created_at: "2026-08-14T08:00:00Z",
  updated_at: "2026-08-14T08:00:00Z",
  source: null,
  settings: {
    preset: "fast",
    max_frames: 300,
    max_long_edge: 1280,
    colmap_max_long_edge: 1600,
    frame_fps: 2,
    iterations: 3000,
    sh_degree: 0,
    checkpoint_interval: 500,
  },
  status: "ready",
  current_stage: null,
  pipeline_state: { stages: {}, current_stage: null, overall_progress: 0 },
};

function artifact(errorOverrides: Partial<Record<"frames" | "colmap" | "ply" | "output", string>> = {}): ArtifactSummary {
  const item = (relative_path: string, error: string | undefined) => ({
    relative_path,
    exists: !error,
    validated: !error,
    size_bytes: error ? 0 : 1024,
    updated_at: "2026-08-14T08:00:00Z",
    error: error ?? null,
  });
  return {
    frames_manifest: item("frames/manifest.json", errorOverrides.frames),
    colmap_result: item("colmap/sparse", errorOverrides.colmap),
    latest_checkpoint: null,
    scene_ply: item("output/scene.ply", errorOverrides.ply),
    output_manifest: item("output/manifest.json", errorOverrides.output),
    registered_images: 12,
    total_images: 12,
    sparse_points: 2400,
    mean_reprojection_error: 0.4,
    colmap_validation: null,
    colmap_attempts: [],
    splat_count: 1000,
  };
}

function checkpoint(iteration: number, current = false): CheckpointSummary {
  return {
    iteration,
    relative_path: `checkpoints/${iteration}.ply`,
    size_bytes: 1024,
    created_at: "2026-08-14T08:00:00Z",
    vertex_count: 1000,
    valid: true,
    current,
    brush_version: "0.2.0",
  };
}

function renderProject(path = "D:\\projects\\one") {
  return render(createElement(
    AppProvider,
    null,
    createElement(ProjectDetailPage, { projectId: "project-1", projectPath: path }),
  ));
}

describe("ProjectDetailPage async workspace resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "open_project") return project;
      throw new Error(`unexpected command ${command}`);
    });
    vi.mocked(desktopApi.getPipelineEvents).mockResolvedValue({ items: [], next_cursor: null, total: 0 });
    vi.mocked(desktopApi.getFramePreview).mockResolvedValue({ items: [], total_frames: 0 });
    vi.mocked(desktopApi.getSparsePreviewPack).mockRejectedValue(new Error("not generated"));
    vi.mocked(desktopApi.inspectPly).mockRejectedValue(new Error("not generated"));
    vi.mocked(desktopApi.getActivePipelineSummary).mockResolvedValue(null);
    vi.mocked(desktopApi.openProjectLocation).mockResolvedValue({ opened: true, missing: false, target_type: "artifact", message: null });
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue({
      action: "restore_checkpoint",
      targetLabel: "Checkpoint 500",
      allowed: true,
      blockedReason: null,
      irreversible: false,
      preserved: ["project source"],
      invalidated: ["later checkpoints"],
      regenerated: ["training output"],
      warnings: [],
      sizeBytes: 1024,
      previewToken: "token-restore-500",
      createdAt: "2026-08-14T08:00:00Z",
      expiresAt: "2026-08-14T08:10:00Z",
    });
    vi.mocked(desktopApi.executeWorkspaceAction).mockResolvedValue({
      kind: "completed",
      receipt: {
        id: "receipt-restore-500",
        action: "restore_checkpoint",
        status: "success",
        title: "Restore completed",
        message: "Checkpoint restored",
        completedAt: "2026-08-14T08:01:00Z",
        affectedResources: ["checkpoints"],
        dismissible: true,
      },
    });
    vi.mocked(desktopApi.getPipelineState).mockResolvedValue({
      project_id: project.id,
      project_path: "D:\\projects\\one",
      status: "ready",
      state: project.pipeline_state,
      sequence: 1,
      accepted_at: null,
      started_at: null,
      control_intent: "none",
    });
  });

  it("distinguishes complete empty checkpoints from loading", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();

    expect(await screen.findByText("暂无恢复点")).toBeInTheDocument();
    expect(screen.queryByText("恢复点加载失败")).not.toBeInTheDocument();
  });

  it("renders partial artifact issues and suppresses unsafe Retry", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact({
      frames: JSON.stringify({ code: "E-FRAMES", message: "帧清单暂时不可读", retryable: true }),
      colmap: JSON.stringify({ code: "E-COLMAP", message: "需要重新运行相机阶段", retryable: false }),
    }));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();

    expect(await screen.findByText("项目产物仅部分可用")).toBeInTheDocument();
    expect(screen.getByText(/帧清单暂时不可读/)).toBeInTheDocument();
    expect(screen.getByText(/需要重新运行相机阶段/)).toBeInTheDocument();
    const partialState = screen.getByText("项目产物仅部分可用").closest(".async-partial-state");
    expect(partialState).not.toBeNull();
    expect(within(partialState as HTMLElement).getAllByRole("button", { name: "重试" })).toHaveLength(1);
  });

  it("retains last-good artifacts with a timestamp when the next project refresh fails", async () => {
    vi.mocked(desktopApi.getProjectArtifacts)
      .mockResolvedValueOnce(artifact())
      .mockRejectedValueOnce(new Error("temporary disk error"));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    const view = renderProject();
    expect(await screen.findByText("1,000")).toBeInTheDocument();

    view.rerender(createElement(
      AppProvider,
      null,
      createElement(ProjectDetailPage, { projectId: "project-1", projectPath: "D:\\projects\\two" }),
    ));

    expect(await screen.findByText(/项目产物可能已过期，最后更新于/)).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试刷新" })).toBeInTheDocument();
  });

  it("shows a blocking total failure without inventing empty data", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockRejectedValue(new Error("unavailable"));
    vi.mocked(desktopApi.listCheckpoints).mockRejectedValue(new Error("unavailable"));
    renderProject();

    expect(await screen.findByText("项目产物加载失败")).toBeInTheDocument();
    expect(screen.getByText("恢复点加载失败")).toBeInTheDocument();
    expect(screen.queryByText("暂无恢复点")).not.toBeInTheDocument();
  });

  it("shows a safe Retry for a total preview failure and recovers to a complete empty result", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.inspectPly)
      .mockRejectedValueOnce(new Error("temporary preview read error"))
      .mockResolvedValueOnce({
        relative_path: "output/scene.ply",
        format: "ply",
        vertex_count: 0,
        size_bytes: 0,
        gaussian_compatible: true,
        points: [],
      });
    renderProject();

    expect(await screen.findByText("真实产物预览加载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(desktopApi.inspectPly).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/0 splats/)).toBeInTheDocument();
  });

  it("previews checkpoint recovery and refreshes authoritative resources only after its receipt", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints)
      .mockResolvedValueOnce([checkpoint(500), checkpoint(1000, true)])
      .mockResolvedValueOnce([checkpoint(500, true)]);
    renderProject();

    const checkpointButtons = await screen.findAllByRole("button", { name: "Checkpoint (2)" });
    fireEvent.click(checkpointButtons[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    const dialog = await screen.findByRole("alertdialog");
    const dialogButtons = within(dialog).getAllByRole("button");
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    await waitFor(() => expect(desktopApi.listCheckpoints).toHaveBeenCalledTimes(2));
    expect(desktopApi.getProjectArtifacts).toHaveBeenCalledTimes(2);
    expect(desktopApi.executeWorkspaceAction).toHaveBeenCalledWith("token-restore-500");
    expect(desktopApi.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("links phase disclosures and exposes semantic roving stage controls", async () => {
    const timelineProject: Project = {
      ...project,
      status: "running",
      current_stage: "MediaValidation",
      pipeline_state: {
        current_stage: "MediaValidation",
        overall_progress: 0.02,
        stages: {
          MediaValidation: stage("MediaValidation", "running", 0.4),
          FrameExtraction: stage("FrameExtraction", "pending"),
          ImagePreprocessing: stage("ImagePreprocessing", "pending"),
        },
      },
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "open_project") return timelineProject;
      throw new Error(`unexpected command ${command}`);
    });
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();

    const phase = await screen.findByRole("button", { name: /素材准备/ });
    await waitFor(() => expect(phase).toHaveAttribute("aria-expanded", "true"));
    const stageList = document.getElementById(phase.getAttribute("aria-controls")!);
    expect(stageList).toHaveAttribute("role", "list");
    const current = screen.getByRole("button", { name: /媒体校验/ });
    const next = screen.getByRole("button", { name: /帧准备/ });
    expect(current).toHaveAttribute("aria-current", "step");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(current).toHaveAttribute("tabindex", "0");
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(next, { key: "End" });
    const last = document.getElementById("stage-button-ImagePreprocessing")!;
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(current).toHaveFocus();
    fireEvent.click(next);
    expect(next).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the compact inspector as a focus-managed modal and restores its trigger", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();
    await screen.findByText("暂无恢复点");
    const opener = screen.getByRole("button", { name: "预览与质量" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "预览与质量" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览与质量" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "预览与质量" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
