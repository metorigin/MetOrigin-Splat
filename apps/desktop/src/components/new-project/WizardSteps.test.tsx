import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MediaAnalysis, PresetEstimate, ProjectPreflight } from "@/types";
import { ConfirmStep, PreflightStep } from "./WizardSteps";

const presets: PresetEstimate[] = [
  { id: "fast", name: "Fast", description: "", fps: 2, max_frames: 300, target_long_edge: 1280, colmap_long_edge: 1280, iterations: 3000, sh_degree: 0, checkpoint_interval: 500, estimated_frames: 40, estimated_disk_bytes: 100_000_000 },
  { id: "balanced", name: "Balanced", description: "", fps: 3, max_frames: 500, target_long_edge: 1920, colmap_long_edge: 1600, iterations: 7000, sh_degree: 1, checkpoint_interval: 500, estimated_frames: 61, estimated_disk_bytes: 300_000_000 },
  { id: "quality", name: "Quality", description: "", fps: 4, max_frames: 800, target_long_edge: 2560, colmap_long_edge: 1920, iterations: 30_000, sh_degree: 2, checkpoint_interval: 1000, estimated_frames: 81, estimated_disk_bytes: 500_000_000 },
];
const analysis: MediaAnalysis = { source_kind: "video", source_path: "D:/test/video.mp4", display_name: "video.mp4", size_bytes: 1000, valid: true,
  video_metadata: { width: 3840, height: 2160, fps: 30, frame_count: 600, duration_seconds: 20, codec: "h264", rotation: null },
  image_set_metadata: null, preset_estimates: presets, preview_items: [], warnings: [], blockers: [] };
const preflight: ProjectPreflight = { preset: "quality", can_continue: true,
  engine_checks: [{ name: "GPU", available: true, path: null, expected_version: null, actual_version: null, diagnostic: "当前设备已验证", source: null, integrity_status: null }],
  estimated_frames: 81, estimated_disk_bytes: 500_000_000, available_disk_bytes: 50_000_000_000, recommended_preset: "fast", warnings: [], blockers: [],
  effective_training: { iterations: 30_000, sh_degree: 2, resolution: 2560, threads: 2 } };
const stepProps = { analysis, preflight, checking: false, selectedPreset: "quality", onSelectPreset: vi.fn(), onRecheck: vi.fn() };
const confirmProps = { analysis, estimate: presets[2], preflight, directoryCheck: { status: "idle" as const }, projectName: "Test", projectRoot: null,
  onNameChange: vi.fn(), onChooseRoot: vi.fn(async () => undefined) };

describe("wizard effective training settings", () => {
  it("shows checked Quality 30000/SH2/2560 consistently in the selected card, details and confirmation", () => {
    const view = render(<PreflightStep {...stepProps} />);
    const quality = screen.getByRole("button", { name: /^高质量/ });
    expect(quality).toHaveTextContent("本次实际执行 · 30,000 步 · SH2 · 2560 px");
    expect(screen.getByRole("button", { name: /^均衡/ })).toHaveTextContent("预设请求 · 7,000 步 · SH1 · 1920 px");
    expect(screen.getByRole("button", { name: /^均衡/ })).not.toHaveTextContent("本次实际执行");
    fireEvent.click(screen.getByRole("button", { name: /参数详情/ }));
    expect(screen.getByText("训练最长边：2560 px")).toBeVisible();
    expect(screen.getByText("球谐阶数：2")).toBeVisible();
    const checked = within(screen.getByRole("region", { name: "预检结果" }));
    expect(checked.getByText(/30,000 步 · SH2 · 2560 px/)).toBeVisible();
    view.rerender(<ConfirmStep {...confirmProps} />);
    expect(screen.getByText(/30,000 步 · SH2 · 2560 px/)).toBeVisible();
    expect(screen.getByText("本次实际执行")).toBeVisible();
  });

  it("clearly separates a conservative Mac effective policy from the Quality request on both steps", () => {
    const limited = { ...preflight, effective_training: { iterations: 3000, sh_degree: 0, resolution: 960, threads: 2 }, warnings: ["本次 Mac 执行参数：3000 步，SH0，训练长边 960 px，最多 300000 个高斯。"] };
    const view = render(<PreflightStep {...stepProps} preflight={limited} />);
    const quality = screen.getByRole("button", { name: /^高质量/ });
    expect(quality).toHaveTextContent("本次实际执行 · 3,000 步 · SH0 · 960 px");
    expect(quality).toHaveTextContent("预设请求 · 30,000 步 · SH2 · 2560 px");
    expect(screen.getByText("本次执行参数已调整，以预检结果为准。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /参数详情/ }));
    expect(screen.getByText("训练最长边：960 px")).toBeVisible();
    expect(screen.getByText("球谐阶数：0")).toBeVisible();
    view.rerender(<ConfirmStep {...confirmProps} preflight={limited} />);
    expect(screen.getByText(/3,000 步 · SH0 · 960 px/)).toBeVisible();
    expect(screen.getByText(/30,000 步 · SH2 · 2560 px/)).toBeVisible();
    expect(screen.getByText("本次执行参数已调整，以预检结果为准。")).toBeVisible();
  });

  it.each([true, false])("hides stale actual settings, warnings and engine readiness during a preset change (checking=%s)", (checking) => {
    const stale = { ...preflight, preset: "fast", effective_training: { iterations: 3000, sh_degree: 0, resolution: 960, threads: 2 }, warnings: ["旧预设提醒"] };
    render(<PreflightStep {...stepProps} preflight={stale} checking={checking} />);
    expect(screen.getByRole("button", { name: /^高质量/ })).toHaveTextContent("预设请求 · 30,000 步 · SH2 · 2560 px");
    expect(screen.queryByText("本次实际执行")).not.toBeInTheDocument();
    expect(screen.queryByText("旧预设提醒")).not.toBeInTheDocument();
    expect(screen.queryByText("当前设备已验证")).not.toBeInTheDocument();
    expect(screen.queryByText(/3,000 步 · SH0 · 960 px/)).not.toBeInTheDocument();
    expect(screen.getAllByText("实际参数待预检").length).toBeGreaterThan(0);
  });

  it("does not label a missing effective response or an unbound legacy response as actual settings", () => {
    const view = render(<PreflightStep {...stepProps} preflight={{ ...preflight, effective_training: null }} />);
    expect(screen.getByText("当前引擎未提供实际参数，当前显示预设请求。")).toBeVisible();
    expect(screen.queryByText("本次实际执行")).not.toBeInTheDocument();
    view.rerender(<PreflightStep {...stepProps} preflight={{ ...preflight, preset: undefined }} />);
    expect(screen.queryByText("本次实际执行")).not.toBeInTheDocument();
    expect(screen.getByText("待检查")).toBeVisible();
  });

  it("withholds confirmation settings while a replacement directory preflight is pending", () => {
    render(<ConfirmStep {...confirmProps} directoryCheck={{ status: "checking" }} />);
    expect(screen.queryByText("本次实际执行")).not.toBeInTheDocument();
    expect(screen.getByText("实际参数待预检")).toBeVisible();
  });
});
