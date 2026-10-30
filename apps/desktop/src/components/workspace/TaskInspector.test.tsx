import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceMetrics } from "@/types";
import { TaskInspector } from "./TaskInspector";

type Workspace = Parameters<typeof TaskInspector>[0]["workspace"];

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    project: null, artifacts: null, checkpoints: [],
    setCheckpointOpen: vi.fn(), inspectorOpen: false, setInspectorOpen: vi.fn(),
    setActivityOpen: vi.fn(), qualityAction: null, recoveringStage: null,
    setQualityDialogOpen: vi.fn(), qualityAccepting: false, inspectorCloseRef: { current: null },
    pipelineState: undefined, workspaceStatus: "running", workspaceComplete: false,
    openOutputDirectory: vi.fn().mockResolvedValue(undefined), openScenePly: vi.fn().mockResolvedValue(undefined),
    currentStageLabel: "高斯模型训练", pipelineBusy: true, workspacePaused: false, workspaceFailed: false,
    overallPercent: 42, failedStage: null, failureMessage: null, gpuPercent: 48,
    memory: { unified: false, used: 8 * 1024 ** 3, total: 32 * 1024 ** 3 },
    vramPercent: 25, cpuPercent: 36, recoverFromStage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function metrics(utilization: number | null = 48, operatingSystem = "Windows"): ResourceMetrics {
  return {
    timestamp: "2026-10-31T00:00:00Z", operating_system: operatingSystem, cpu_name: null,
    cpu_usage_percent: 36, memory_total_bytes: 32 * 1024 ** 3, memory_used_bytes: 8 * 1024 ** 3,
    project_disk_available_bytes: null, disk_path: null, warnings: [],
    gpu: { name: "Test GPU", driver_version: null, memory_total_bytes: null,
      memory_used_bytes: null, utilization_percent: utilization, temperature_celsius: null },
  };
}

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
beforeEach(() => { Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" }); });
afterEach(() => {
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
  else Reflect.deleteProperty(navigator, "platform");
});

describe("task inspector presentation", () => {
  it("omits repeated running progress and background guidance while keeping logs and quality actions", () => {
    const view = workspace();
    render(<TaskInspector workspace={view} metrics={metrics()} />);
    expect(screen.queryByRole("region", { name: "任务监控" })).not.toBeInTheDocument();
    expect(screen.queryByText(/任务可在应用内后台运行/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看日志与活动" }));
    expect(view.setActivityOpen).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "质量检查详情" })).toBeVisible();
    expect(screen.getByRole("button", { name: "恢复点（0）" })).toBeVisible();
  });

  it.each(["platform", "operating system", "unified memory"])("hides Mac GPU utilization identified by %s, retaining memory and CPU", (signal) => {
    if (signal === "platform") Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    const view = workspace({ memory: { unified: signal === "unified memory", used: 8 * 1024 ** 3, total: 32 * 1024 ** 3 } });
    render(<TaskInspector workspace={view} metrics={metrics(48, signal === "operating system" ? "macOS" : "Windows")} />);
    expect(screen.queryByRole("progressbar", { name: "GPU" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^GPU /)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CPU" })).toHaveAttribute("aria-valuenow", "36");
    expect(screen.getByRole("progressbar", { name: signal === "unified memory" ? "统一内存" : "VRAM" })).toBeVisible();
  });

  it.each([null, NaN, Infinity])("does not show unavailable GPU utilization (%s) as an indeterminate bar", (utilization) => {
    render(<TaskInspector workspace={workspace()} metrics={metrics(utilization)} />);
    expect(screen.queryByRole("progressbar", { name: "GPU" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^GPU /)).not.toBeInTheDocument();
  });

  it("retains a measured GPU utilization on Windows", () => {
    render(<TaskInspector workspace={workspace()} metrics={metrics()} />);
    expect(screen.getByText("GPU 48%")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "GPU" })).toHaveAttribute("aria-valuenow", "48");
  });

  it("retains failure details and recovery controls", () => {
    const view = workspace({ workspaceFailed: true, pipelineBusy: false, workspaceStatus: "failed", failedStage: "BrushTraining", failureMessage: "训练资源不足" });
    render(<TaskInspector workspace={view} metrics={null} />);
    expect(screen.getByRole("region", { name: "错误与恢复" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("训练资源不足");
    fireEvent.click(screen.getByRole("button", { name: "重试失败阶段" }));
    expect(view.recoverFromStage).toHaveBeenCalledWith("BrushTraining", "failed");
    expect(screen.getByRole("button", { name: "查看可用恢复点" })).toBeDisabled();
  });

  it("retains completed results and output actions", () => {
    const view = workspace({ workspaceComplete: true, pipelineBusy: false, workspaceStatus: "completed" });
    render(<TaskInspector workspace={view} metrics={null} />);
    expect(screen.getByRole("region", { name: "重建完成" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开输出目录" }));
    expect(view.openOutputDirectory).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "打开 PLY" })).toBeVisible();
  });
});
