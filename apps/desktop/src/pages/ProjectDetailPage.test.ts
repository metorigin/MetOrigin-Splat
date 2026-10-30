import { createElement, useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProvider, useAppContext } from "../context";
import type { ArtifactSummary, CheckpointSummary, ColmapQualityDecision, FramePreview, PipelineSnapshot, PipelineState, Project, ProjectInfo, ResourceMetrics, StageState } from "../types";
import { desktopApi } from "../services/desktop";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { SettingsDrawer } from "../components/settings/SettingsDrawer";
import { useTheme } from "../hooks/useTheme";
import { PHASES, phaseStatus, plyActionState, stageStatusLabel } from "./projectTimeline";

const invokeMock = vi.hoisted(() => vi.fn());
const previewLifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
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
  acceptColmapQualityRisk: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Exercise the real page's React boundary with a stateful viewer stand-in.
// WebGL/camera behavior is covered by the preview component's integration tests.
vi.mock("../components/workspace/GaussianSplatPreview", () => ({
  GaussianSplatPreview: function Preview(props: { projectPath: string; live: boolean; relativePath: string | null }) {
    const [mountedPath] = useState(props.projectPath);
    const [navigation, setNavigation] = useState("initial");
    useEffect(() => {
      previewLifecycle.mounted(mountedPath);
      return () => { previewLifecycle.unmounted(mountedPath); };
    }, [mountedPath]);
    return createElement("div", { "data-testid": "gaussian-preview", "data-live": String(props.live), "data-path": props.relativePath },
      createElement("input", { "aria-label": "模拟预览导航", value: navigation, onChange: (event) => setNavigation(event.currentTarget.value) }));
  },
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

function qualityArtifacts(decision: ColmapQualityDecision): ArtifactSummary {
  return { ...artifact(), colmap_validation: {
    passed: decision === "pass", decision,
    checks: [{ name: "Registered coverage", passed: decision === "pass", detail: "8 / 12", severity: "Warning" }],
    largest_component_images: 8, largest_component_coverage: 8 / 12, largest_missing_segment: 4,
    automatic_fallbacks_exhausted: true, model_hash: "test-quality-model-hash",
  } };
}

function framePreview(dataUrl = "data:image/jpeg;base64,/9j/2Q=="): FramePreview {
  return {
    items: [{ relative_path: "frames/frame-001.jpg", data_url: dataUrl, width: 203, height: 360 }],
    total_frames: 1,
  };
}

function reconstructionArtifacts(sparseExists: boolean): ArtifactSummary {
  const data = artifact();
  const missing = { exists: false, validated: false, size_bytes: 0, updated_at: null, error: null };
  if (!sparseExists) data.colmap_result = { ...data.colmap_result, ...missing };
  data.scene_ply = { ...data.scene_ply, ...missing };
  data.output_manifest = { ...data.output_manifest, ...missing };
  data.splat_count = null;
  return data;
}

function reconstructingProject(stageId: StageState["stage_id"] = "ColmapMatching"): Project {
  return {
    ...project,
    status: "running",
    current_stage: stageId,
    pipeline_state: {
      current_stage: stageId,
      overall_progress: 0.17,
      stages: { [stageId]: stage(stageId, "running", 0.3) },
    },
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

async function waitForInitialCheckpointLoad() {
  await waitFor(() => expect(desktopApi.listCheckpoints).toHaveBeenCalled());
  await act(async () => {
    await vi.mocked(desktopApi.listCheckpoints).mock.results[0].value;
  });
}

const runningTrainingProject: Project = {
  ...project,
  status: "running",
  current_stage: "BrushTraining",
  pipeline_state: {
    current_stage: "BrushTraining",
    overall_progress: 0.5,
    stages: { BrushTraining: stage("BrushTraining", "running", 0.5) },
  },
};

function TrainingTransition({ status = "completed" }: { status?: "completed" | "paused" }) {
  const { dispatch } = useAppContext();
  return createElement("button", { onClick: () => dispatch({
    type: "SET_PIPELINE_SNAPSHOT",
    snapshot: {
      project_id: project.id, project_path: "D:\\projects\\one", status,
      sequence: 999, accepted_at: null, started_at: null, control_intent: "none",
      state: {
        current_stage: null,
        overall_progress: status === "completed" ? 1 : 0.5,
        stages: {
          BrushTraining: stage("BrushTraining", status, status === "completed" ? 1 : 0.5),
          ModelValidation: stage("ModelValidation", status === "completed" ? "completed" : "pending", status === "completed" ? 1 : 0),
          Export: stage("Export", status === "completed" ? "completed" : "pending", status === "completed" ? 1 : 0),
          PreviewGeneration: stage("PreviewGeneration", status === "completed" ? "completed" : "pending", status === "completed" ? 1 : 0),
        },
      },
    },
  }) }, "模拟训练结束快照");
}

function renderTrainingTransition(status: "completed" | "paused" = "completed") {
  return render(createElement(AppProvider, null,
    createElement(ProjectDetailPage, { projectId: project.id, projectPath: "D:\\projects\\one" }),
    createElement(ExportTransition),
    createElement(TrainingTransition, { status })));
}

function ExportTransition() {
  const { dispatch } = useAppContext();
  return createElement("button", { onClick: () => dispatch({
    type: "SET_PIPELINE_SNAPSHOT",
    snapshot: {
      project_id: project.id, project_path: "D:\\projects\\one", status: "running",
      sequence: 998, accepted_at: null, started_at: null, control_intent: "none",
      state: {
        current_stage: "Export", overall_progress: 0.95,
        stages: { Export: stage("Export", "running", 0.5) },
      },
    },
  }) }, "模拟导出开始快照");
}

describe("ProjectDetailPage async workspace resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopApi.acceptColmapQualityRisk).mockReset();
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

  it("ignores a late open from the prior path after remounting the same relocated project", async () => {
    const priorPath = "D:\\projects\\old-location";
    const currentPath = "E:\\projects\\relocated";
    const relocated = { ...project, name: "重新定位后的项目", updated_at: "2026-10-29T01:00:00Z" };
    let finishPriorOpen!: (value: Project) => void;
    const priorOpen = new Promise<Project>((resolve) => { finishPriorOpen = resolve; });
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      if (command !== "open_project") throw new Error(`unexpected command ${command}`);
      if (args.path === priorPath) return priorOpen;
      if (args.path === currentPath) return relocated;
      throw new Error("unexpected project path");
    });
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    const records: ProjectInfo[] = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `other-${index}`, name: `其他项目 ${index}`, path: `D:\\projects\\other-${index}`, status: "ready" as const, updated_at: project.updated_at })),
      { id: project.id, name: project.name, path: priorPath, status: project.status, updated_at: project.updated_at },
    ];
    function SeedRecentProjects() {
      const { dispatch } = useAppContext();
      useEffect(() => dispatch({ type: "SET_RECENT_PROJECTS", projects: records }), [dispatch]);
      return null;
    }
    function ProjectIdentityProbe() {
      const { state } = useAppContext();
      return createElement("output", { "data-testid": "relocated-project-state" }, JSON.stringify({
        recent: state.recentProjects.find((entry) => entry.id === project.id),
        recentOrder: state.recentProjects.map((entry) => entry.id),
        snapshot: state.pipelineSnapshots[project.id],
      }));
    }
    const tree = (path: string) => createElement(AppProvider, null,
      createElement(SeedRecentProjects),
      createElement(ProjectDetailPage, { key: JSON.stringify([project.id, path]), projectId: project.id, projectPath: path }),
      createElement(ProjectIdentityProbe));
    const view = render(tree(priorPath));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_project", { path: priorPath }));
    view.rerender(tree(currentPath));
    const installedIdentity = () => JSON.parse(screen.getByTestId("relocated-project-state").textContent ?? "{}");
    await waitFor(() => expect(installedIdentity()).toMatchObject({
      recent: { id: project.id, name: relocated.name, path: currentPath },
      recentOrder: [project.id, "other-0", "other-1", "other-2", "other-3", "other-4"],
      snapshot: { project_id: project.id, project_path: currentPath },
    }));
    const currentIdentity = installedIdentity();
    await act(async () => finishPriorOpen({ ...project, name: "旧位置返回的项目" }));
    expect(installedIdentity()).toEqual(currentIdentity);
    expect(installedIdentity().recent.path).toBe(currentPath);
    expect(installedIdentity().snapshot.project_path).toBe(currentPath);
  });

  it("retries the reported failed stage instead of assuming a training failure", async () => {
    const failed: Project = { ...project, status: "failed", current_stage: "ColmapMapping", pipeline_state: {
      stages: { ColmapMapping: { ...stage("ColmapMapping", "failed", 0.2), error: "Camera registration failed" } },
      current_stage: "ColmapMapping", overall_progress: 0.25,
    } };
    invokeMock.mockResolvedValue(failed);
    vi.mocked(desktopApi.getPipelineState).mockResolvedValue({ project_id: project.id, project_path: "D:\\projects\\one", status: "failed", state: failed.pipeline_state, sequence: 4, accepted_at: null, started_at: null, control_intent: "none" });
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.startPipeline).mockResolvedValue({ project_id: project.id, project_path: "D:\\projects\\one", status: "running", state: failed.pipeline_state, sequence: 5, accepted_at: null, started_at: null, control_intent: "none" });
    renderProject();
    expect(await screen.findByText("Camera registration failed")).toBeInTheDocument();
    expect(screen.queryByText("CUDA out of memory")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试失败阶段" }));
    await waitFor(() => expect(desktopApi.retryStage).toHaveBeenCalledWith("D:\\projects\\one", "ColmapMapping"));
    expect(desktopApi.startPipeline).toHaveBeenCalledWith("D:\\projects\\one");
  });

  it("does not offer risk acceptance when no quality report exists", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();
    await waitForInitialCheckpointLoad();
    fireEvent.click(screen.getByRole("button", { name: "质量检查详情" }));
    const dialog = screen.getByRole("dialog", { name: "质量评估结果" });
    expect(within(dialog).getByText(/质量报告尚未生成/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "确认风险并继续" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/31.42|综合质量评分|自动清理/)).not.toBeInTheDocument();
  });

  it("accepts only a requires_confirmation report once, then starts the same project after acceptance finishes", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(qualityArtifacts("requires_confirmation"));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    let finishAcceptance!: (snapshot: PipelineSnapshot) => void;
    vi.mocked(desktopApi.acceptColmapQualityRisk).mockImplementation(() => new Promise((resolve) => { finishAcceptance = resolve; }));
    const reset: PipelineSnapshot = { project_id: project.id, project_path: "D:\\projects\\one", status: "ready", state: project.pipeline_state, sequence: 2, accepted_at: null, started_at: null, control_intent: "none" };
    vi.mocked(desktopApi.startPipeline).mockResolvedValue({ ...reset, status: "running", sequence: 3 });
    renderProject();
    await waitForInitialCheckpointLoad();
    fireEvent.click(screen.getByRole("button", { name: "质量检查详情" }));
    const dialog = screen.getByRole("dialog", { name: "质量评估结果" });
    const confirm = within(dialog).getByRole("button", { name: "确认风险并继续" });
    fireEvent.click(confirm);
    expect(desktopApi.acceptColmapQualityRisk).toHaveBeenCalledOnce();
    expect(desktopApi.acceptColmapQualityRisk).toHaveBeenCalledWith("D:\\projects\\one");
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeDisabled();
    fireEvent.click(confirm);
    expect(desktopApi.acceptColmapQualityRisk).toHaveBeenCalledOnce();
    await act(async () => finishAcceptance(reset));
    await waitFor(() => expect(desktopApi.startPipeline).toHaveBeenCalledWith("D:\\projects\\one"));
    expect(desktopApi.startPipeline).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "质量评估结果" })).not.toBeInTheDocument();
  });

  it("retains the report and retry action when acceptance fails without starting training", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(qualityArtifacts("requires_confirmation"));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.acceptColmapQualityRisk).mockRejectedValue(new Error("Report no longer valid"));
    renderProject();
    await waitForInitialCheckpointLoad();
    fireEvent.click(screen.getByRole("button", { name: "质量检查详情" }));
    fireEvent.click(screen.getByRole("button", { name: "确认风险并继续" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认风险并继续" })).toBeEnabled());
    expect(desktopApi.acceptColmapQualityRisk).toHaveBeenCalledOnce();
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "质量评估结果" })).toBeVisible();
  });

  it("keeps another project's active task intact and refuses quality continuation before either API mutation", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(qualityArtifacts("requires_confirmation"));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    function ActiveTaskProbe() {
      const { state, dispatch } = useAppContext();
      useEffect(() => {
        dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot: { project_id: "other-project", project_path: "D:\\projects\\active", status: "running", state: { stages: {}, current_stage: "BrushTraining", overall_progress: .4 }, sequence: 8, accepted_at: null, started_at: null, control_intent: "none" } });
      }, [dispatch]);
      return createElement("output", { "data-testid": "quality-active-guard" }, JSON.stringify({ active: state.activePipelineProjectId, conflict: state.pipelineConflict, error: state.error }));
    }
    render(createElement(AppProvider, null, createElement(ProjectDetailPage, { projectId: project.id, projectPath: "D:\\projects\\one" }), createElement(ActiveTaskProbe)));
    await waitForInitialCheckpointLoad();
    fireEvent.click(screen.getByRole("button", { name: "质量检查详情" }));
    fireEvent.click(screen.getByRole("button", { name: "确认风险并继续" }));
    expect(desktopApi.acceptColmapQualityRisk).not.toHaveBeenCalled();
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
    expect(screen.getByTestId("quality-active-guard")).toHaveTextContent('"active":"other-project"');
    expect(screen.getByTestId("quality-active-guard")).toHaveTextContent('"requestedProjectId":"project-1"');
    expect(screen.getByTestId("quality-active-guard")).toHaveTextContent("当前项目未启动，也未进入队列");
    expect(screen.getByRole("dialog", { name: "质量评估结果" })).toBeVisible();
  });

  it("keeps checkpoint loading visible and removes the successful empty placeholder without removing task monitoring", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    let finishCheckpoints!: (value: CheckpointSummary[]) => void;
    vi.mocked(desktopApi.listCheckpoints).mockReturnValue(new Promise((resolve) => { finishCheckpoints = resolve; }));
    renderProject();

    expect(await screen.findByText("正在加载恢复点…")).toBeVisible();
    expect(screen.getByRole("region", { name: "任务监控" })).toBeInTheDocument();
    await act(async () => finishCheckpoints([]));
    expect(screen.queryByText("正在加载恢复点…")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无恢复点")).not.toBeInTheDocument();
    expect(screen.queryByText("恢复点加载失败")).not.toBeInTheDocument();
    expect(document.querySelector(".project-resource-feedback")).toBeEmptyDOMElement();
    expect(screen.getByRole("region", { name: "任务监控" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "恢复点（0）" })).toHaveLength(2);
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
    const partialState = screen.getByText("项目产物仅部分可用").closest("[role=status]");
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
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact({ ply: "not generated", colmap: "not generated" }));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.getFramePreview)
      .mockRejectedValueOnce(new Error("temporary preview read error"))
      .mockResolvedValueOnce({ items: [], total_frames: 0 });
    renderProject();

    expect(await screen.findByText("真实产物预览加载失败")).toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".preview-panel")!).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("预览尚未生成")).toBeInTheDocument();
    expect(screen.queryByRole("application")).not.toBeInTheDocument();
  });

  it("shows the waiting placeholder without stale copy or refresh when the next stage has no preview yet", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact({ ply: "not generated", colmap: "not generated" }));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.getFramePreview).mockResolvedValue(framePreview());

    function AdvanceStage() {
      const { dispatch } = useAppContext();
      return createElement("button", { onClick: () => dispatch({
        type: "SET_PIPELINE_SNAPSHOT",
        snapshot: {
          project_id: project.id, project_path: "D:\\projects\\one", status: "running",
          state: {
            stages: {
              FrameExtraction: stage("FrameExtraction", "completed", 1),
              ColmapFeatureExtraction: stage("ColmapFeatureExtraction", "running", 0.01),
            },
            current_stage: "ColmapFeatureExtraction", overall_progress: 0.08,
          },
          sequence: 2, accepted_at: null, started_at: null, control_intent: "none",
        },
      }) }, "进入特征提取");
    }
    render(createElement(AppProvider, null,
      createElement(ProjectDetailPage, { projectId: project.id, projectPath: "D:\\projects\\one" }),
      createElement(AdvanceStage),
    ));
    const thumbnail = await screen.findByRole("img", { name: "抽取帧缩略图" });
    expect(thumbnail).toHaveAttribute("src", framePreview().items[0].data_url);
    expect(thumbnail).toHaveAttribute("width", "203");
    expect(thumbnail).toHaveAttribute("height", "360");
    expect(thumbnail).toHaveStyle({ height: "auto" });
    expect(desktopApi.getFramePreview).toHaveBeenCalledWith("D:\\projects\\one", project.id);
    fireEvent.click(screen.getByRole("button", { name: "进入特征提取" }));
    const preview = within(document.querySelector(".preview-panel")!);
    expect(await preview.findByText("预览尚未生成")).toBeInTheDocument();
    expect(desktopApi.getSparsePreviewPack).not.toHaveBeenCalled();
    expect(preview.queryByText("真实产物预览加载失败")).not.toBeInTheDocument();
    expect(preview.queryByRole("img")).not.toBeInTheDocument();
    expect(preview.queryByText(/可能已过期/)).not.toBeInTheDocument();
    expect(preview.queryByRole("button", { name: "重试刷新" })).not.toBeInTheDocument();
  });

  it("refreshes thumbnails only when the frame manifest changes and clears removed frames", async () => {
    invokeMock.mockResolvedValue(reconstructingProject("FrameExtraction"));
    let artifacts = reconstructionArtifacts(false);
    artifacts.frames_manifest = { ...artifacts.frames_manifest, exists: false, validated: false, size_bytes: 0, updated_at: null };
    let checkpoints: CheckpointSummary[] = [];
    vi.mocked(desktopApi.getProjectArtifacts).mockImplementation(async () => artifacts);
    vi.mocked(desktopApi.listCheckpoints).mockImplementation(async () => checkpoints);
    vi.mocked(desktopApi.getFramePreview).mockResolvedValue(framePreview());
    const intervals = vi.spyOn(window, "setInterval");
    renderProject();
    await waitForInitialCheckpointLoad();
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    intervals.mockRestore();
    expect(typeof refresh).toBe("function");
    expect(desktopApi.getFramePreview).not.toHaveBeenCalled();

    artifacts = reconstructionArtifacts(false);
    await act(async () => { (refresh as () => void)(); });
    expect(await screen.findByRole("img", { name: "抽取帧缩略图" })).toHaveAttribute("src", framePreview().items[0].data_url);
    expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(1);

    // New summary objects and unrelated checkpoints must not decode frames again.
    artifacts = { ...artifacts, frames_manifest: { ...artifacts.frames_manifest } };
    checkpoints = [checkpoint(500)];
    await act(async () => { (refresh as () => void)(); });
    await act(async () => { (refresh as () => void)(); });
    expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(1);

    let publish!: (value: FramePreview) => void;
    vi.mocked(desktopApi.getFramePreview).mockReturnValueOnce(new Promise((resolve) => { publish = resolve; }));
    artifacts = { ...artifacts, frames_manifest: { ...artifacts.frames_manifest, size_bytes: 2048, updated_at: "2026-08-14T08:01:00Z" } };
    await act(async () => { (refresh as () => void)(); });
    await waitFor(() => expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("img", { name: "抽取帧缩略图" })).not.toBeInTheDocument();
    const replacement = framePreview("data:image/jpeg;base64,/9j/AA==");
    await act(async () => publish(replacement));
    expect(await screen.findByRole("img", { name: "抽取帧缩略图" })).toHaveAttribute("src", replacement.items[0].data_url);

    artifacts = { ...artifacts, frames_manifest: { ...artifacts.frames_manifest, exists: false, validated: false, size_bytes: 0, updated_at: null } };
    await act(async () => { (refresh as () => void)(); });
    expect(screen.queryByRole("img", { name: "抽取帧缩略图" })).not.toBeInTheDocument();
    expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(2);
    expect(within(document.querySelector(".preview-panel")!).getByText("预览尚未生成")).toBeInTheDocument();
  });

  it("ignores a delayed thumbnail response for an invalidated frame manifest", async () => {
    invokeMock.mockResolvedValue(reconstructingProject("FrameExtraction"));
    let artifacts = reconstructionArtifacts(false);
    vi.mocked(desktopApi.getProjectArtifacts).mockImplementation(async () => artifacts);
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    let publishOld!: (value: FramePreview) => void;
    vi.mocked(desktopApi.getFramePreview).mockReturnValueOnce(new Promise((resolve) => { publishOld = resolve; }));
    const intervals = vi.spyOn(window, "setInterval");
    renderProject();
    await waitFor(() => expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(1));
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    intervals.mockRestore();
    expect(typeof refresh).toBe("function");

    const replacement = framePreview("data:image/jpeg;base64,/9j/AA==");
    vi.mocked(desktopApi.getFramePreview).mockResolvedValueOnce(replacement);
    artifacts = { ...artifacts, frames_manifest: { ...artifacts.frames_manifest, updated_at: "2026-08-14T08:01:00Z" } };
    await act(async () => { (refresh as () => void)(); });
    expect(await screen.findByRole("img", { name: "抽取帧缩略图" })).toHaveAttribute("src", replacement.items[0].data_url);
    await act(async () => publishOld(framePreview()));
    expect(screen.getByRole("img", { name: "抽取帧缩略图" })).toHaveAttribute("src", replacement.items[0].data_url);
    expect(desktopApi.getFramePreview).toHaveBeenCalledTimes(2);
  });

  it.each(["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"] as const)(
    "does not request an unpublished sparse model while following %s",
    async (stageId) => {
      invokeMock.mockResolvedValue(reconstructingProject(stageId));
      vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(reconstructionArtifacts(false));
      vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
      renderProject();
      await waitForInitialCheckpointLoad();
      const preview = within(document.querySelector(".preview-panel")!);
      expect(await preview.findByText("预览尚未生成")).toBeInTheDocument();
      expect(desktopApi.getSparsePreviewPack).not.toHaveBeenCalled();
      expect(preview.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("waits for the artifact summary before requesting a sparse preview", async () => {
    invokeMock.mockResolvedValue(reconstructingProject());
    let publish!: (value: ArtifactSummary) => void;
    vi.mocked(desktopApi.getProjectArtifacts).mockReturnValue(new Promise((resolve) => { publish = resolve; }));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();
    await waitForInitialCheckpointLoad();
    expect(desktopApi.getSparsePreviewPack).not.toHaveBeenCalled();
    await act(async () => publish(reconstructionArtifacts(false)));
    expect(desktopApi.getSparsePreviewPack).not.toHaveBeenCalled();
    expect(within(document.querySelector(".preview-panel")!).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("loads a newly published or replaced sparse artifact without changing the selected stage", async () => {
    invokeMock.mockResolvedValue(reconstructingProject());
    let artifacts = reconstructionArtifacts(false);
    vi.mocked(desktopApi.getProjectArtifacts).mockImplementation(async () => artifacts);
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.getSparsePreviewPack).mockResolvedValue({
      model_path: "colmap/sparse/0", registered_images: 0, total_images: 311,
      point_count: 0, mean_reprojection_error: null, points: [], cameras: [],
    });
    const intervals = vi.spyOn(window, "setInterval");
    renderProject();
    await waitForInitialCheckpointLoad();
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    intervals.mockRestore();
    expect(typeof refresh).toBe("function");
    expect(desktopApi.getSparsePreviewPack).not.toHaveBeenCalled();

    artifacts = reconstructionArtifacts(true);
    await act(async () => { (refresh as () => void)(); });
    await waitFor(() => expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledTimes(1));
    await act(async () => { (refresh as () => void)(); });
    expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledTimes(1);

    artifacts = {
      ...artifacts,
      colmap_result: { ...artifacts.colmap_result, updated_at: "2026-08-14T08:01:00Z", size_bytes: 2048 },
    };
    await act(async () => { (refresh as () => void)(); });
    await waitFor(() => expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledTimes(2));
    const preview = within(document.querySelector(".preview-panel")!);
    expect(preview.getByText("COLMAP 特征匹配")).toBeInTheDocument();
    expect(preview.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a readable failure for an existing but invalid sparse artifact", async () => {
    invokeMock.mockResolvedValue(reconstructingProject());
    const artifacts = reconstructionArtifacts(true);
    artifacts.colmap_result.validated = false;
    artifacts.colmap_result.error = "产物存在但未通过验证。";
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifacts);
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    vi.mocked(desktopApi.getSparsePreviewPack).mockRejectedValue("existing sparse model is unreadable");
    renderProject();
    expect(await screen.findByText("真实产物预览加载失败")).toBeInTheDocument();
    expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledWith("D:\\projects\\one");
    const preview = within(document.querySelector(".preview-panel")!);
    expect(preview.getByText("existing sparse model is unreadable")).toBeInTheDocument();
    expect(preview.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("ignores a previous project's delayed sparse error after switching to a project without a model", async () => {
    const firstPath = "D:\\projects\\one";
    const nextPath = "D:\\projects\\two";
    const nextProject = { ...reconstructingProject(), id: "project-2", name: "另一个重建项目" };
    invokeMock.mockImplementation(async (_command: string, args: { path: string }) =>
      args.path === nextPath ? nextProject : reconstructingProject("ColmapValidation"));
    vi.mocked(desktopApi.getProjectArtifacts).mockImplementation(async (path) => reconstructionArtifacts(path === firstPath));
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    let rejectPrevious!: (reason: Error) => void;
    vi.mocked(desktopApi.getSparsePreviewPack).mockReturnValue(new Promise((_resolve, reject) => { rejectPrevious = reject; }));
    const view = render(createElement(AppProvider, null,
      createElement(ProjectDetailPage, { key: project.id, projectId: project.id, projectPath: firstPath })));
    await waitFor(() => expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledWith(firstPath));
    view.rerender(createElement(AppProvider, null,
      createElement(ProjectDetailPage, { key: nextProject.id, projectId: nextProject.id, projectPath: nextPath })));
    await waitFor(() => expect(document.querySelector(".preview-panel")).toHaveTextContent("COLMAP 特征匹配"));
    const preview = within(document.querySelector(".preview-panel")!);
    expect(desktopApi.getProjectArtifacts).toHaveBeenCalledWith(nextPath);
    await act(async () => rejectPrevious(new Error("previous project's delayed error")));
    expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledTimes(1);
    expect(preview.getByText("预览尚未生成")).toBeInTheDocument();
    expect(preview.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the Gaussian renderer for completed models without requesting point samples", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();
    const preview = await screen.findByTestId("gaussian-preview");
    expect(preview).toHaveAttribute("data-path", "output/scene.ply");
    expect(preview).toHaveAttribute("data-live", "false");
    expect(desktopApi.inspectPly).not.toHaveBeenCalled();
  });

  it("recreates the preview when a different directory has the same project ID and artifact metadata", async () => {
    // Both directories deliberately return the same project ID and artifact
    // metadata, as can happen when a project is copied with preserved times.
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    const originalPath = "D:\\projects\\original", copiedPath = "D:\\projects\\translated-copy";
    const view = renderProject(originalPath);
    const originalPreview = await screen.findByTestId("gaussian-preview");
    fireEvent.change(screen.getByLabelText("模拟预览导航"), { target: { value: "original orbit" } });
    expect(previewLifecycle.mounted).toHaveBeenCalledWith(originalPath);

    view.rerender(createElement(AppProvider, null,
      createElement(ProjectDetailPage, { projectId: project.id, projectPath: copiedPath })));
    await waitFor(() => expect(previewLifecycle.unmounted).toHaveBeenCalledWith(originalPath));
    expect(previewLifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(previewLifecycle.mounted).toHaveBeenLastCalledWith(copiedPath);
    expect(screen.getByTestId("gaussian-preview")).not.toBe(originalPreview);
    expect(screen.getByLabelText("模拟预览导航")).toHaveValue("initial");
    expect(desktopApi.getProjectArtifacts).toHaveBeenCalledWith(copiedPath);
    view.unmount();
    expect(previewLifecycle.unmounted).toHaveBeenLastCalledWith(copiedPath);
  });

  it.each([false, true])("follows a completed snapshot to the validated final PLY when artifact publication is delayed: %s", async (delayed) => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    let publish!: (value: ArtifactSummary) => void;
    if (delayed) vi.mocked(desktopApi.getProjectArtifacts).mockReturnValue(new Promise((resolve) => { publish = resolve; }));
    else vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(1500)]);
    renderTrainingTransition();
    const preview = await screen.findByTestId("gaussian-preview");
    await waitFor(() => expect(preview).toHaveAttribute("data-live", "true"));
    expect(preview).toHaveAttribute("data-path", "checkpoints/1500.ply");

    // Reopened training can jump directly to a terminal snapshot when the
    // short validation/export stages finish between frontend observations.
    fireEvent.click(screen.getByRole("button", { name: "模拟训练结束快照" }));
    if (delayed) {
      expect(preview).toHaveAttribute("data-path", "checkpoints/1500.ply");
      await act(async () => publish(artifact()));
    }
    await waitFor(() => expect(preview).toHaveAttribute("data-live", "false"));
    expect(preview).toHaveAttribute("data-path", "output/scene.ply");
  });

  it("preserves a manually selected training preview when the pipeline completes", async () => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(1500)]);
    renderTrainingTransition();
    const preview = await screen.findByTestId("gaussian-preview");
    await waitFor(() => expect(preview).toHaveAttribute("data-live", "true"));
    fireEvent.click(screen.getByRole("button", { name: /模型训练/ }));
    const training = screen.getByRole("button", { name: /Brush 训练/ });
    fireEvent.click(training);
    fireEvent.click(screen.getByRole("button", { name: "模拟训练结束快照" }));
    await waitFor(() => expect(training).toHaveAttribute("aria-pressed", "true"));
    expect(preview).toHaveAttribute("data-path", "checkpoints/1500.ply");
    expect(preview).toHaveAttribute("data-live", "true");
    expect(training).not.toHaveAttribute("aria-current");
  });

  it("retains the same training viewer across Export and completion until a missing final artifact is published", async () => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    let artifacts = reconstructionArtifacts(true);
    vi.mocked(desktopApi.getProjectArtifacts).mockImplementation(async () => artifacts);
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(2500)]);
    const intervals = vi.spyOn(window, "setInterval");
    renderTrainingTransition();
    const preview = await screen.findByTestId("gaussian-preview");
    await screen.findByText("2,400");
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    intervals.mockRestore();
    expect(typeof refresh).toBe("function");
    expect(preview).toHaveAttribute("data-live", "true");
    fireEvent.change(screen.getByLabelText("模拟预览导航"), { target: { value: "training orbit" } });

    fireEvent.click(screen.getByRole("button", { name: "模拟导出开始快照" }));
    expect(screen.getByTestId("gaussian-preview")).toBe(preview);
    expect(preview).toHaveAttribute("data-path", "checkpoints/2500.ply");
    fireEvent.click(screen.getByRole("button", { name: "模拟训练结束快照" }));
    expect(screen.getByTestId("gaussian-preview")).toBe(preview);
    expect(preview).toHaveAttribute("data-live", "true");

    artifacts = artifact();
    await act(async () => { (refresh as () => void)(); });
    await waitFor(() => expect(preview).toHaveAttribute("data-path", "output/scene.ply"));
    expect(screen.getByTestId("gaussian-preview")).toBe(preview);
    expect(preview).toHaveAttribute("data-live", "false");
    expect(screen.getByLabelText("模拟预览导航")).toHaveValue("training orbit");
    expect(previewLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(previewLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("honors an authoritative null current stage instead of reviving the reopened project's legacy stage", async () => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(1500)]);
    renderTrainingTransition("paused");
    await screen.findByTestId("gaussian-preview");
    fireEvent.click(screen.getByRole("button", { name: /模型训练/ }));
    const training = screen.getByRole("button", { name: /Brush 训练/ });
    expect(training).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "模拟训练结束快照" }));
    await waitFor(() => expect(training).not.toHaveAttribute("aria-current"));
  });

  it("previews checkpoint recovery and refreshes authoritative resources only after its receipt", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints)
      .mockResolvedValueOnce([checkpoint(500), checkpoint(1000, true)])
      .mockResolvedValueOnce([checkpoint(500, true)]);
    renderProject();

    const checkpointButtons = await screen.findAllByRole("button", { name: "恢复点（2）" });
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

  it.each(["follow", "export", "removed checkpoint", "retained checkpoint"] as const)(
    "revokes archived preview sources after restore while respecting %s selection",
    async (selection) => {
      const completedStages = {
        BrushTraining: stage("BrushTraining", "completed", 1),
        ModelValidation: stage("ModelValidation", "completed", 1),
        Export: stage("Export", "completed", 1),
        PreviewGeneration: stage("PreviewGeneration", "completed", 1),
      };
      invokeMock.mockResolvedValue({
        ...project, status: "completed",
        pipeline_state: { current_stage: null, overall_progress: 1, stages: completedStages },
      });
      vi.mocked(desktopApi.getProjectArtifacts)
        .mockResolvedValueOnce(artifact())
        .mockResolvedValue(reconstructionArtifacts(true));
      vi.mocked(desktopApi.listCheckpoints)
        .mockResolvedValueOnce([500, 1000, 1500, 2000, 2500, 3000].map((step) => checkpoint(step, step === 3000)))
        .mockResolvedValue([500, 1000, 1500, 2000, 2500].map((step) => checkpoint(step, step === 2500)));
      vi.mocked(desktopApi.getPipelineState).mockResolvedValue({
        project_id: project.id, project_path: "D:\\projects\\one", status: "paused",
        sequence: 1, accepted_at: null, started_at: null, control_intent: "none",
        state: {
          current_stage: null, overall_progress: 0.6,
          stages: {
            BrushTraining: stage("BrushTraining", "paused"),
            ModelValidation: stage("ModelValidation", "pending"),
            Export: stage("Export", "pending"),
            PreviewGeneration: stage("PreviewGeneration", "pending"),
          },
        },
      });
      renderProject();
      expect(await screen.findByTestId("gaussian-preview")).toHaveAttribute("data-path", "output/scene.ply");
      if (selection === "export") {
        fireEvent.click(screen.getByRole("button", { name: /结果导出/ }));
        fireEvent.click(document.getElementById("stage-button-Export")!);
      }
      fireEvent.click((await screen.findAllByRole("button", { name: "恢复点（6）" }))[0]);
      if (selection.includes("checkpoint")) {
        const step = selection === "removed checkpoint" ? "3,000 step" : "2,000 step";
        const row = screen.getByText(step).closest("article")!;
        fireEvent.click(within(row).getByRole("button", { name: "预览" }));
      }
      const restoreRow = screen.getByText("2,500 step").closest("article")!;
      fireEvent.click(within(restoreRow).getByRole("button", { name: "恢复" }));
      const dialog = await screen.findByRole("alertdialog");
      const buttons = within(dialog).getAllByRole("button");
      fireEvent.click(buttons[buttons.length - 1]);
      await waitFor(() => expect(desktopApi.getPipelineState).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "关闭 Checkpoint 管理器" }));

      if (selection === "follow") {
        await waitFor(() => expect(screen.getByTestId("gaussian-preview")).toHaveAttribute("data-path", "checkpoints/2500.ply"));
      } else if (selection === "retained checkpoint") {
        expect(screen.getByTestId("gaussian-preview")).toHaveAttribute("data-path", "checkpoints/2000.ply");
      } else {
        await waitFor(() => expect(screen.queryByTestId("gaussian-preview")).not.toBeInTheDocument());
        expect(within(document.querySelector(".preview-panel")!).getByText("预览尚未生成")).toBeInTheDocument();
        if (selection === "export") {
          fireEvent.click(screen.getByRole("button", { name: /结果导出/ }));
          expect(document.getElementById("stage-button-Export")).toHaveAttribute("aria-pressed", "true");
        }
      }
      const plyButton = screen.getByRole("button", { name: "打开 PLY" });
      expect(plyButton).toHaveTextContent("PLY 文件");
      expect(plyButton).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(screen.getByRole("button", { name: "跟随当前阶段" }));
      await waitFor(() => expect(screen.getByTestId("gaussian-preview")).toHaveAttribute("data-path", "checkpoints/2500.ply"));
      expect(screen.getByTestId("gaussian-preview")).toHaveAttribute("data-live", "true");
      expect(document.querySelector('[aria-current="step"]')).not.toBeInTheDocument();
    },
  );

  it("keeps completed and cached sub-stages selectable for previews without offering or invoking recovery", async () => {
    const stages = Object.fromEntries(PHASES.flatMap((phase) => phase.stages.map((stageId, index) =>
      [stageId, stage(stageId, index % 2 === 0 ? "completed" : "skipped", 1)]))) as PipelineState["stages"];
    invokeMock.mockResolvedValue({
      ...project, status: "completed", current_stage: null,
      pipeline_state: { stages, current_stage: null, overall_progress: 1 },
    });
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(500)]);
    vi.mocked(desktopApi.getFramePreview).mockResolvedValue(framePreview());
    vi.mocked(desktopApi.getSparsePreviewPack).mockResolvedValue({
      model_path: "colmap/sparse/0", registered_images: 0, total_images: 12,
      point_count: 0, mean_reprojection_error: null, points: [], cameras: [],
    });
    renderProject();
    await waitForInitialCheckpointLoad();
    await screen.findByTestId("gaussian-preview");

    let sparseReads = 0;
    for (const phase of PHASES) {
      const summary = document.getElementById(`phase-summary-${phase.id}`)!;
      fireEvent.click(summary);
      expect(summary).toHaveAttribute("aria-expanded", "true");
      for (const stageId of phase.stages) {
        const stageButton = document.getElementById(`stage-button-${stageId}`)!;
        fireEvent.click(stageButton);
        expect(stageButton).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByRole("button", { name: /从此阶段重新运行|重试并开始/ })).not.toBeInTheDocument();
        if (phase.id === "media") {
          expect(await screen.findByRole("img", { name: "抽取帧缩略图" })).toBeVisible();
        } else if (phase.id === "camera") {
          sparseReads += 1;
          await waitFor(() => expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledTimes(sparseReads));
        } else {
          expect(await screen.findByTestId("gaussian-preview")).toHaveAttribute("data-path", phase.id === "training" ? "checkpoints/500.ply" : "output/scene.ply");
        }
      }
    }
    expect(desktopApi.getFramePreview).toHaveBeenCalledWith("D:\\projects\\one", project.id);
    expect(desktopApi.getSparsePreviewPack).toHaveBeenCalledWith("D:\\projects\\one");
    expect(desktopApi.previewWorkspaceAction).not.toHaveBeenCalled();
    expect(desktopApi.executeWorkspaceAction).not.toHaveBeenCalled();
    expect(desktopApi.retryStage).not.toHaveBeenCalled();
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
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
    expect(phase).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /媒体校验/ })).not.toBeInTheDocument();
    fireEvent.click(phase);
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

  it("does not reopen phase contents when the running stage advances", async () => {
    function AdvanceStage() {
      const { dispatch } = useAppContext();
      return createElement("button", { onClick: () => dispatch({
        type: "SET_PIPELINE_SNAPSHOT",
        snapshot: {
          project_id: project.id, project_path: "D:\\projects\\one", status: "running",
          sequence: 999, accepted_at: null, started_at: null, control_intent: "none",
          state: { current_stage: "BrushTraining", overall_progress: 0.5, stages: { BrushTraining: stage("BrushTraining", "running", 0.5) } },
        },
      }) }, "模拟阶段推进");
    }
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    render(createElement(AppProvider, null,
      createElement(ProjectDetailPage, { projectId: project.id, projectPath: "D:\\projects\\one" }),
      createElement(AdvanceStage)));
    const phase = await screen.findByRole("button", { name: /素材准备/ });
    fireEvent.click(phase);
    expect(phase).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(phase);
    fireEvent.click(screen.getByRole("button", { name: "模拟阶段推进" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /模型训练/ })).toHaveAttribute("aria-label", expect.stringContaining("运行中")));
    expect(document.querySelectorAll(".phase-summary[aria-expanded=true]")).toHaveLength(0);
    expect(document.querySelector(".stage-list")).toBeNull();
  });

  it("distinguishes an unmeasured CPU interval from a real zero and later measured usage", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    const metrics: ResourceMetrics = {
      timestamp: "2026-10-27T08:00:00Z", operating_system: "macOS", cpu_name: "Apple M1 Pro",
      cpu_usage_percent: null, memory_total_bytes: 32 * 1024 ** 3, memory_used_bytes: 8 * 1024 ** 3,
      project_disk_available_bytes: null, disk_path: null, gpu: null, warnings: [],
    };
    const renderWithUsage = (usage: number | null) => createElement(AppProvider, null,
      createElement(ProjectDetailPage, {
        projectId: project.id, projectPath: "D:\\projects\\one", metrics: { ...metrics, cpu_usage_percent: usage },
      }));
    const view = render(renderWithUsage(null));
    await screen.findByText("CPU 尚未测量");
    expect(screen.getByRole("progressbar", { name: "CPU" })).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText("CPU 0%")).not.toBeInTheDocument();

    view.rerender(renderWithUsage(0));
    expect(screen.getByText("CPU 0%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CPU" })).toHaveAttribute("aria-valuenow", "0");

    view.rerender(renderWithUsage(63.5));
    expect(screen.getByText("CPU 64%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CPU" })).toHaveAttribute("aria-valuenow", "63.5");

    view.rerender(renderWithUsage(null));
    expect(screen.getByText("CPU 尚未测量")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CPU" })).not.toHaveAttribute("aria-valuenow");
  });

  it("keeps the same viewer and camera state while opening and closing the compact inspector", async () => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(2500)]);
    renderProject();
    const preview = await screen.findByTestId("gaussian-preview");
    fireEvent.change(screen.getByLabelText("模拟预览导航"), { target: { value: "inspection orbit" } });
    fireEvent.click(screen.getByRole("button", { name: "预览与质量" }));
    await screen.findByRole("dialog", { name: "预览与质量" });
    expect(screen.getByTestId("gaussian-preview")).toBe(preview);
    fireEvent.click(screen.getByRole("button", { name: "关闭预览与质量" }));
    expect(screen.getByTestId("gaussian-preview")).toBe(preview);
    expect(screen.getByLabelText("模拟预览导航")).toHaveValue("inspection orbit");
    expect(previewLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(previewLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("preserves viewer ownership across theme, host reflow and a sibling settings modal", async () => {
    invokeMock.mockResolvedValue(runningTrainingProject);
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([checkpoint(2500)]);
    const priorTheme = localStorage.getItem("metorigin.ui.theme");
    function WorkspaceWithSettings() {
      const { setTheme } = useTheme();
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [compact, setCompact] = useState(false);
      return createElement("div", { "data-testid": "workspace-layout-host", style: { width: compact ? 512 : 1440 } },
        createElement("button", { onClick: () => setCompact((current) => !current) }, "重排工作台宿主"),
        createElement("button", { onClick: () => setTheme("dark") }, "切换宿主深色"),
        createElement("button", { onClick: () => setSettingsOpen(true) }, "打开同级设置"),
        createElement(ProjectDetailPage, { projectId: project.id, projectPath: "D:\\projects\\one" }),
        settingsOpen && createElement(SettingsDrawer, {
          engines: [], settings: {
            engine_directory: null, engine_executables: {}, default_project_root: null,
            default_preset: "balanced", create_and_start: false, prevent_idle_sleep: false,
            log_retention_mb: 256, thumbnail_cache_mb: 256,
          }, metrics: null, projectId: project.id, projectPath: "D:\\projects\\one",
          onClose: () => setSettingsOpen(false), onSettings: vi.fn(), onEngines: vi.fn(), onError: vi.fn(),
        }),
      );
    }
    try {
      render(createElement(AppProvider, null, createElement(WorkspaceWithSettings)));
      const preview = await screen.findByTestId("gaussian-preview");
      fireEvent.change(screen.getByLabelText("模拟预览导航"), { target: { value: "preserved inspection orbit" } });
      fireEvent.click(screen.getByRole("button", { name: "切换宿主深色" }));
      expect(document.documentElement.dataset.theme).toBe("dark");
      fireEvent.click(screen.getByRole("button", { name: "重排工作台宿主" }));
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getByTestId("workspace-layout-host")).toHaveStyle({ width: "512px" });
      expect(screen.getByTestId("gaussian-preview")).toBe(preview);
      fireEvent.click(screen.getByRole("button", { name: "打开同级设置" }));
      const settings = await screen.findByRole("dialog", { name: "应用设置" });
      fireEvent.click(within(settings).getByRole("tab", { name: "外观" }));
      fireEvent.change(within(settings).getByRole("combobox", { name: "界面主题" }), { target: { value: "light" } });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(screen.getByTestId("gaussian-preview")).toBe(preview);
      fireEvent.click(within(settings).getByRole("button", { name: "关闭设置" }));
      expect(screen.queryByRole("dialog", { name: "应用设置" })).not.toBeInTheDocument();
      expect(screen.getByTestId("gaussian-preview")).toBe(preview);
      expect(screen.getByLabelText("模拟预览导航")).toHaveValue("preserved inspection orbit");
      // This verifies React ownership only. It is not a real GPU resource measurement.
      expect(previewLifecycle.mounted).toHaveBeenCalledTimes(1);
      expect(previewLifecycle.unmounted).not.toHaveBeenCalled();
    } finally {
      if (priorTheme == null) localStorage.removeItem("metorigin.ui.theme");
      else localStorage.setItem("metorigin.ui.theme", priorTheme);
      act(() => window.dispatchEvent(new Event("metorigin-theme-change")));
    }
  });

  it("opens the compact inspector as a focus-managed modal and restores its trigger", async () => {
    vi.mocked(desktopApi.getProjectArtifacts).mockResolvedValue(artifact());
    vi.mocked(desktopApi.listCheckpoints).mockResolvedValue([]);
    renderProject();
    await waitForInitialCheckpointLoad();
    const opener = screen.getByRole("button", { name: "预览与质量" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "预览与质量" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览与质量" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "预览与质量" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
