import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProvider, useAppContext } from "../context";
import { desktopApi, selectImageDirectory, selectProjectRoot } from "../services/desktop";
import type { ProjectPreflight } from "../types";
import { NewProjectPage } from "./NewProjectPage";

const analyzeMedia = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../services/desktop", () => ({
  isDesktopRuntime: () => true,
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
  },
}));

describe("NewProjectPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
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
});
