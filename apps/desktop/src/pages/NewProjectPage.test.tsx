import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProvider, useAppContext } from "../context";
import {
  desktopApi,
  selectImageDirectory,
  selectProjectRoot,
} from "../services/desktop";
import type { PipelineSnapshot, ProjectCopyProgress, ProjectPreflight } from "../types";
import { NewProjectPage } from "./NewProjectPage";

const analyzeMedia = vi.fn();
const eventListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, listener: (event: { payload: unknown }) => void) => {
    eventListeners.set(event, listener);
    return Promise.resolve(() => eventListeners.delete(event));
  }),
}));
vi.mock("../services/desktop", () => ({
  isDesktopRuntime: () => true,
  isActivePipelineConflict: () => false,
  selectVideoFile: vi.fn().mockResolvedValue("D:\\dataset\\bike.mp4"),
  selectImageDirectory: vi.fn(),
  selectProjectRoot: vi.fn(),
  desktopApi: {
    analyzeMedia: (...args: unknown[]) => analyzeMedia(...args),
    getImagePreviews: vi.fn(),
    preflightProject: vi.fn(),
    createProject: vi.fn(),
    cancelProjectCreation: vi.fn(),
    startPipeline: vi.fn(),
    getActivePipelineSummary: vi.fn(),
  },
}));

async function advanceToConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
  await screen.findByText("3840 × 2160");
  fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
  await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
  await screen.findByRole("heading", { name: "确认创建" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function StateProbe() {
  const { state } = useAppContext();
  return <><output data-testid="page">{state.page.type}</output>{state.error ? <div role="alert">{state.error}</div> : null}</>;
}

function SeedActivePipeline({ snapshot }: { snapshot: PipelineSnapshot }) {
  const { dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot });
  }, [dispatch, snapshot]);
  return null;
}

function SeedWizardPage() {
  const { dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: "NAVIGATE", page: { type: "new-project" } });
  }, [dispatch]);
  return null;
}

describe("NewProjectPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    vi.mocked(desktopApi.cancelProjectCreation).mockResolvedValue(undefined);
    analyzeMedia.mockResolvedValue({
      source_kind: "video",
      source_path: "D:\\dataset\\bike.mp4",
      display_name: "bike.mp4",
      size_bytes: 1_675_000_000,
      valid: true,
      video_metadata: {
        width: 3840,
        height: 2160,
        fps: 29.97002997,
        frame_count: 3990,
        duration_seconds: 133.135,
        codec: "hevc",
        rotation: null,
      },
      image_set_metadata: null,
      preset_estimates: [
        { id: "fast", name: "Quick Preview", description: "", fps: 2, max_frames: 300, target_long_edge: 1280, iterations: 3000, sh_degree: 0, checkpoint_interval: 500, estimated_frames: 266, estimated_disk_bytes: 85_120_000 },
      ],
      preview_items: [],
      warnings: [],
      blockers: [],
    });
    vi.mocked(desktopApi.preflightProject).mockResolvedValue({
      can_continue: true,
      engine_checks: [],
      estimated_frames: 266,
      estimated_disk_bytes: 7_000_000_000,
      available_disk_bytes: 50_000_000_000,
      recommended_preset: "fast",
      warnings: [],
      blockers: [],
    });
    vi.mocked(desktopApi.createProject).mockResolvedValue({
      id: "project-1",
      name: "bike",
      path: "D:\\projects\\bike.splat-project",
      status: "ready",
      start_after_create: true,
    });
    vi.mocked(desktopApi.getImagePreviews).mockResolvedValue([]);
  });

  it("shows real video metadata and Fast estimate after native selection", async () => {
    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await waitFor(() => expect(screen.getByText("3840 × 2160")).toBeInTheDocument());
    expect(screen.getByText("29.97 fps")).toBeInTheDocument();
    expect(screen.getByText("2 分 13.1 秒")).toBeInTheDocument();
    expect(screen.getByText("HEVC")).toBeInTheDocument();
    expect(screen.getByText(/预计 266 帧/)).toBeInTheDocument();
  });

  it("shows real engine versions and NVIDIA preflight diagnostics", async () => {
    vi.mocked(desktopApi.preflightProject).mockResolvedValueOnce({
      can_continue: false,
      engine_checks: [
        {
          name: "COLMAP",
          available: true,
          path: "D:\\MetOrigin\\engines\\colmap\\bin\\colmap.exe",
          expected_version: "4.1.0",
          actual_version: "4.1.0",
          diagnostic: "已通过启动和版本检查。",
          source: "resource",
          integrity_status: "valid",
        },
        {
          name: "NVIDIA GPU / 驱动",
          available: false,
          path: "nvidia-smi",
          expected_version: null,
          actual_version: null,
          diagnostic: "未能运行 nvidia-smi，请安装 NVIDIA 官方驱动。",
          source: "system",
          integrity_status: null,
        },
      ],
      estimated_frames: 266,
      estimated_disk_bytes: 7_000_000_000,
      available_disk_bytes: 50_000_000_000,
      recommended_preset: "fast",
      warnings: [],
      blockers: ["NVIDIA GPU / 驱动不可用"],
    });

    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));

    expect(await screen.findByText("4.1.0")).toBeInTheDocument();
    expect(screen.getByText(/未能运行 nvidia-smi/)).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
  });

  it("stays on confirmation and reruns preflight after the save directory changes", async () => {
    vi.mocked(selectProjectRoot).mockResolvedValue("E:\\recon-projects");
    render(<AppProvider><NewProjectPage /></AppProvider>);

    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    const changeDirectory = await screen.findByText("更改目录");

    let resolveDirectoryCheck!: (result: ProjectPreflight) => void;
    vi.mocked(desktopApi.preflightProject).mockImplementationOnce(() => new Promise((resolve) => {
      resolveDirectoryCheck = resolve;
    }));
    fireEvent.click(changeDirectory.closest("button")!);

    expect(await screen.findByRole("status")).toHaveTextContent("正在检查新目录");
    expect(screen.getByRole("heading", { name: "确认创建" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅创建项目" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建并开始重建" })).toBeDisabled();

    await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenLastCalledWith({
      sourcePath: "D:\\dataset\\bike.mp4",
      projectRoot: "E:\\recon-projects",
      preset: "fast",
    }));
    await act(async () => resolveDirectoryCheck({
      can_continue: true,
      engine_checks: [],
      estimated_frames: 266,
      estimated_disk_bytes: 7_000_000_000,
      available_disk_bytes: 80_000_000_000,
      recommended_preset: "fast",
      warnings: [],
      blockers: [],
    }));

    expect(await screen.findByText(/已重新检查，可用空间/)).toHaveTextContent("74.51 GiB");
    expect(screen.getByRole("heading", { name: "确认创建" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅创建项目" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "创建并开始重建" })).toBeEnabled();
    expect(desktopApi.preflightProject).toHaveBeenCalledTimes(2);
  });

  it("keeps directory preflight failures inline and prevents project creation", async () => {
    vi.mocked(selectProjectRoot).mockResolvedValue("E:\\nearly-full");
    render(<AppProvider><NewProjectPage /></AppProvider>);

    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));

    vi.mocked(desktopApi.preflightProject).mockResolvedValueOnce({
      can_continue: false,
      engine_checks: [],
      estimated_frames: 266,
      estimated_disk_bytes: 7_000_000_000,
      available_disk_bytes: 2_000_000_000,
      recommended_preset: "fast",
      warnings: [],
      blockers: ["目标磁盘空间不足"],
    });
    fireEvent.click(screen.getByRole("button", { name: "更改目录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("新目录不可用");
    expect(screen.getByRole("alert")).toHaveTextContent("请处理以下问题");
    expect(screen.getByText("目标磁盘空间不足")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确认创建" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新选择目录" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "仅创建项目" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建并开始重建" })).toBeDisabled();
    expect(desktopApi.createProject).not.toHaveBeenCalled();
  });

  it("keeps start failure visible after navigating to the created project", async () => {
    vi.mocked(desktopApi.startPipeline).mockRejectedValue(new Error("Brush executable missing"));

    function StateProbe() {
      const { state } = useAppContext();
      return <div><output data-testid="page">{state.page.type}</output>{state.error && <div role="alert">{state.error}</div>}</div>;
    }

    render(<AppProvider><NewProjectPage /><StateProbe /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    fireEvent.click(await screen.findByRole("button", { name: /创建并开始重建/ }));

    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("project-detail"));
    expect(screen.getByRole("alert")).toHaveTextContent("项目已创建，但未能开始重建");
    expect(screen.getByRole("alert")).toHaveTextContent("Brush executable missing");
  });

  it("shows recursive image statistics and six controlled previews", async () => {
    vi.mocked(selectImageDirectory).mockResolvedValue("D:\\datasets\\自行车\\images");
    analyzeMedia.mockResolvedValue({
      source_kind: "images",
      source_path: "D:\\datasets\\自行车\\images",
      display_name: "images",
      size_bytes: 1_011_000_000,
      valid: true,
      video_metadata: null,
      image_set_metadata: {
        image_count: 73,
        ignored_count: 2,
        invalid_count: 1,
        total_size_bytes: 1_011_000_000,
        formats: { jpg: 73 },
      },
      preset_estimates: [
        { id: "fast", name: "快速", description: "", fps: 2, max_frames: 300, target_long_edge: 1280, iterations: 3000, sh_degree: 0, checkpoint_interval: 500, estimated_frames: 73, estimated_disk_bytes: 23_360_000 },
      ],
      preview_items: [],
      warnings: ["已递归扫描子目录"],
      blockers: [],
    });
    vi.mocked(desktopApi.getImagePreviews).mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        relative_path: `子目录/DSC${index}.JPG`,
        display_name: `DSC${index}.JPG`,
        width: 6000,
        height: 4000,
        data_url: index === 2 ? "" : "data:image/jpeg;base64,AA==",
      })),
    );

    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择图片文件夹/ }));

    await waitFor(() => expect(desktopApi.getImagePreviews).toHaveBeenCalledWith("D:\\datasets\\自行车\\images"));
    expect(screen.getAllByText("73 张", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByText("1 张", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByText("6000 × 4000")).toHaveLength(6);
    expect(screen.getByText("无法解码")).toBeInTheDocument();
    expect(screen.getByText("DSC5.JPG")).toBeInTheDocument();
  });

  it("does not show previews returned by a replaced directory request", async () => {
    vi.mocked(selectImageDirectory)
      .mockResolvedValueOnce("D:\\images-a")
      .mockResolvedValueOnce("D:\\images-b");
    const imageAnalysis = (path: string) => ({
      source_kind: "images" as const,
      source_path: path,
      display_name: path.endsWith("a") ? "images-a" : "images-b",
      size_bytes: 1000,
      valid: true,
      video_metadata: null,
      image_set_metadata: { image_count: 3, ignored_count: 0, invalid_count: 0, total_size_bytes: 1000, formats: { jpg: 3 } },
      preset_estimates: [{ id: "fast", name: "快速", description: "", fps: 2, max_frames: 300, target_long_edge: 1280, iterations: 3000, sh_degree: 0, checkpoint_interval: 500, estimated_frames: 3, estimated_disk_bytes: 1000 }],
      preview_items: [],
      warnings: [],
      blockers: [],
    });
    analyzeMedia.mockImplementation((path: string) => Promise.resolve(imageAnalysis(path)));
    let resolveFirst!: (value: Array<{ relative_path: string; display_name: string; width: number; height: number; data_url: string }>) => void;
    vi.mocked(desktopApi.getImagePreviews)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([{ relative_path: "new.JPG", display_name: "new.JPG", width: 10, height: 10, data_url: "data:image/jpeg;base64,AA==" }]);

    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择图片文件夹/ }));
    await screen.findByText("images-a");
    fireEvent.click(screen.getByRole("button", { name: /替换素材/ }));
    await screen.findByText("new.JPG");
    resolveFirst([{ relative_path: "old.JPG", display_name: "old.JPG", width: 10, height: 10, data_url: "data:image/jpeg;base64,AA==" }]);
    await waitFor(() => expect(screen.queryByText("old.JPG")).not.toBeInTheDocument());
  });

  it("states each step purpose and separates notices, warnings, and blockers", async () => {
    const base = await analyzeMedia("D:\\dataset\\bike.mp4");
    analyzeMedia.mockClear();
    analyzeMedia.mockResolvedValue({
      ...base,
      valid: false,
      warnings: ["少量照片曝光不一致，但仍可继续检查。"],
      blockers: ["没有足够的可读取画面。"],
    });
    render(<AppProvider><NewProjectPage /></AppProvider>);

    expect(screen.getByText(/当前目标：选择要重建的视频或连续照片/)).toBeVisible();
    expect(screen.getByText(/围绕静止主体缓慢移动/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));

    expect(await screen.findByRole("region", { name: "可以继续的提醒" })).toHaveTextContent("曝光不一致");
    expect(screen.getByRole("region", { name: "需要处理的问题" })).toHaveTextContent("没有足够");
    expect(screen.getByRole("button", { name: /下一步/ })).toBeDisabled();
  });

  it("automatically checks each newly selected preset and enables continue after success", async () => {
    const base = await analyzeMedia("D:\\dataset\\bike.mp4");
    analyzeMedia.mockClear();
    analyzeMedia.mockResolvedValue({
      ...base,
      preset_estimates: [
        ...base.preset_estimates,
        { ...base.preset_estimates[0], id: "balanced", name: "Balanced", description: "Default preset with good quality", iterations: 7000 },
        { ...base.preset_estimates[0], id: "quality", name: "Quality", iterations: 30_000 },
      ],
    });
    render(<AppProvider><NewProjectPage /></AppProvider>);

    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await waitFor(() => expect(desktopApi.preflightProject).toHaveBeenCalledTimes(1));
    const allowed = await desktopApi.preflightProject({ sourcePath: base.source_path, projectRoot: null, preset: "fast" });
    expect(screen.getByText("兼顾重建质量与处理时间，适合大多数场景。")).toBeVisible();
    expect(screen.queryByText("Default preset with good quality")).not.toBeInTheDocument();
    for (const [id, label] of [["balanced", "均衡"], ["quality", "高质量"], ["fast", "快速"]]) {
      const pending = deferred<ProjectPreflight>();
      vi.mocked(desktopApi.preflightProject).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(desktopApi.preflightProject).toHaveBeenLastCalledWith({ sourcePath: base.source_path, projectRoot: null, preset: id });
      expect(screen.getByRole("button", { name: /下一步/ })).toBeDisabled();
      expect(screen.getByText(/正在按当前预设检查/)).toBeVisible();
      await act(async () => pending.resolve(allowed));
      expect(screen.getByRole("button", { name: /下一步/ })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    expect(await screen.findByRole("heading", { name: "确认创建" })).toBeVisible();
  });

  it.each([true, false])("ignores a stale preset result after the latest check finishes (latest allowed: %s)", async (latestAllowed) => {
    const base = await analyzeMedia("D:\\dataset\\bike.mp4");
    const allowed = await desktopApi.preflightProject({ sourcePath: base.source_path, projectRoot: null, preset: "fast" });
    analyzeMedia.mockResolvedValue({ ...base, preset_estimates: [
      ...base.preset_estimates,
      { ...base.preset_estimates[0], id: "balanced" },
      { ...base.preset_estimates[0], id: "quality" },
    ] });
    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");
    fireEvent.click(screen.getByRole("button", { name: /下一步/ }));
    await screen.findByRole("heading", { name: "重建预设" });
    const old = deferred<ProjectPreflight>();
    const latest = deferred<ProjectPreflight>();
    vi.mocked(desktopApi.preflightProject).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    fireEvent.click(screen.getByRole("button", { name: /^高质量/ }));
    fireEvent.click(screen.getByRole("button", { name: /^均衡/ }));
    await act(async () => latest.resolve({ ...allowed, can_continue: latestAllowed, blockers: latestAllowed ? [] : ["当前预设磁盘空间不足"] }));
    await act(async () => { if (latestAllowed) old.reject(new Error("过时请求失败")); else old.resolve(allowed); });
    const next = screen.getByRole("button", { name: /下一步/ });
    if (latestAllowed) expect(next).toBeEnabled();
    else {
      expect(next).toBeDisabled();
      expect(screen.getByText("当前预设磁盘空间不足")).toBeVisible();
    }
    expect(screen.queryByText(/过时请求失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/正在按当前预设检查/)).not.toBeInTheDocument();
  });

  it("keeps the draft until the app dialog confirms discarding, with safe focus and Escape", async () => {
    render(<AppProvider><SeedWizardPage /><NewProjectPage /><StateProbe /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("new-project"));
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await screen.findByText("3840 × 2160");

    const exitButton = screen.getByRole("button", { name: "关闭新建项目" });
    exitButton.focus();
    fireEvent.click(exitButton);
    const dialog = screen.getByRole("alertdialog", { name: "退出项目创建？" });
    expect(dialog).toHaveAttribute("aria-describedby", "wizard-exit-description");
    expect(within(dialog).getByRole("button", { name: "继续编辑" })).toHaveFocus();
    expect(screen.getByTestId("page")).toHaveTextContent("new-project");
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
    expect(desktopApi.preflightProject).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("3840 × 2160")).toBeVisible();
    await waitFor(() => expect(exitButton).toHaveFocus());

    fireEvent.click(exitButton);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveTextContent("new-project");
    await waitFor(() => expect(exitButton).toHaveFocus());

    fireEvent.click(exitButton);
    fireEvent.click(screen.getByRole("button", { name: "退出并放弃" }));
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("home"));
  });

  it("exits an untouched wizard without a confirmation", () => {
    render(<AppProvider><SeedWizardPage /><NewProjectPage /><StateProbe /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: "关闭新建项目" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveTextContent("home");
  });

  it.each([true, false])("waits for creation to stop before exiting; cancellation accepted: %s", async (accepted) => {
    const creation = deferred<Awaited<ReturnType<typeof desktopApi.createProject>>>();
    vi.mocked(desktopApi.createProject).mockReturnValue(creation.promise);
    if (!accepted) vi.mocked(desktopApi.cancelProjectCreation).mockRejectedValueOnce(new Error("无法取消复制"));
    render(<AppProvider><SeedWizardPage /><NewProjectPage /><StateProbe /></AppProvider>);
    await advanceToConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "仅创建项目" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭新建项目" }));
    const dialog = screen.getByRole("alertdialog", { name: "取消项目创建？" });
    expect(within(dialog).getByRole("button", { name: "继续创建" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "继续创建" }));
    expect(desktopApi.cancelProjectCreation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭新建项目" }));
    fireEvent.click(screen.getByRole("button", { name: "安全取消并退出" }));
    await waitFor(() => expect(desktopApi.cancelProjectCreation).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveTextContent("new-project");
    if (accepted) {
      fireEvent.click(screen.getByRole("button", { name: "关闭新建项目" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(desktopApi.cancelProjectCreation).toHaveBeenCalledTimes(1);
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成");
    }

    await act(async () => { creation.reject(new Error(accepted ? "cancelled" : "copy failed")); });
    expect(screen.getByTestId("page")).toHaveTextContent(accepted ? "home" : "new-project");
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
  });

  it("shows event-backed copy progress, cancels safely, and keeps create single-flight", async () => {
    const creation = deferred<Awaited<ReturnType<typeof desktopApi.createProject>>>();
    vi.mocked(desktopApi.createProject).mockReturnValue(creation.promise);
    render(<AppProvider><NewProjectPage /></AppProvider>);
    await advanceToConfirmation();

    const submit = screen.getByRole("button", { name: "创建并开始重建" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(desktopApi.createProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar", { name: "素材复制进度" })).not.toBeInTheDocument();
    expect(screen.getByText("等待首个进度回执")).toBeVisible();

    const progress: ProjectCopyProgress = {
      project_id: "project-1",
      copied_bytes: 512,
      total_bytes: 1024,
      percent: 0.5,
      completed: false,
    };
    act(() => eventListeners.get("project://copy-progress")?.({ payload: progress }));
    expect(screen.getByRole("progressbar", { name: "素材复制进度" })).toHaveAttribute("aria-valuenow", "50");

    const cancel = screen.getByRole("button", { name: "取消复制" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(desktopApi.cancelProjectCreation).toHaveBeenCalledTimes(1);
    await act(async () => {
      creation.reject(new Error("cancelled"));
      await Promise.resolve();
    });
    expect(await screen.findByRole("status")).toHaveTextContent("项目创建已安全取消");
  });

  it("does not submit or exit for editing and IME shortcuts", async () => {
    render(<AppProvider><NewProjectPage /></AppProvider>);
    await advanceToConfirmation();
    const name = screen.getByRole("textbox", { name: "项目名称" });

    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(name, { key: "Escape" });
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });

    expect(desktopApi.createProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确认创建" })).toBeVisible();
  });

  it("creates B but skips start and queueing when project A is active", async () => {
    const active: PipelineSnapshot = {
      project_id: "project-a",
      project_path: "D:\\projects\\a.splat-project",
      status: "running",
      state: { stages: {}, current_stage: "BrushTraining", overall_progress: 0.4 },
      sequence: 7,
      accepted_at: "2026-08-14T08:00:00Z",
      started_at: "2026-08-14T08:00:01Z",
      control_intent: "none",
    };
    render(
      <AppProvider>
        <SeedActivePipeline snapshot={active} />
        <NewProjectPage />
        <StateProbe />
      </AppProvider>,
    );
    await advanceToConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "创建并开始重建" }));

    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("project-detail"));
    expect(desktopApi.createProject).toHaveBeenCalledTimes(1);
    expect(desktopApi.startPipeline).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("未启动，也未进入队列");
  });
});
