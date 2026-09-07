import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsDrawer } from "./SettingsDrawer";
import type { EngineInfo, ResourceMetrics } from "../../types";

const settings = {
  engine_directory: null,
  engine_executables: {},
  default_project_root: null,
  default_preset: "balanced",
  create_and_start: false,
  log_retention_mb: 256,
  thumbnail_cache_mb: 256,
};

function loadedProps(onClose = vi.fn()) {
  return {
    engines: [],
    settings,
    metrics: null,
    projectId: null,
    projectPath: null,
    onClose,
    onSettings: vi.fn(),
    onEngines: vi.fn(),
    onError: vi.fn(),
  };
}

describe("SettingsDrawer", () => {
  it("shows detected engine versions and live system information inside settings", () => {
    const engine: EngineInfo = {
      name: "ffmpeg", version: "8.1", actual_version: "8.1.2-essentials_build",
      path: "D:\\engines\\ffmpeg.exe", available: true, source: "configured_or_path",
      pack_version: null, integrity_status: "not_applicable", expected_version: null,
      diagnostic: null, checked_at: "2026-09-06T12:00:00Z",
    };
    const metrics: ResourceMetrics = {
      timestamp: "2026-09-06T12:00:00Z", operating_system: "Windows 11 Home China",
      cpu_name: null, cpu_usage_percent: 10, memory_total_bytes: 32 * 1024 ** 3,
      memory_used_bytes: 8 * 1024 ** 3, project_disk_available_bytes: 100 * 1024 ** 3, warnings: [],
      disk_path: "D:\\MetOrigin",
      gpu: { name: "NVIDIA GeForce RTX 5080 Laptop GPU", driver_version: null,
        memory_total_bytes: 15.9 * 1024 ** 3, memory_used_bytes: 2.7 * 1024 ** 3,
        utilization_percent: 3, temperature_celsius: null },
    };
    const view = render(<SettingsDrawer {...loadedProps()} engines={[engine]} metrics={metrics} version="0.1.0" />);
    expect(screen.getByText("版本：8.1.2-essentials_build")).toBeVisible();
    expect(screen.getByText("Windows 11 Home China")).toBeVisible();
    expect(screen.getByText("v0.1.0")).toBeVisible();
    expect(screen.getByText("2.7 / 15.9 GB")).toBeVisible();
    expect(screen.getByText("3%")).toBeVisible();
    view.rerender(<SettingsDrawer {...loadedProps()} engines={[engine]} metrics={{ ...metrics, gpu: { ...metrics.gpu!, utilization_percent: 0, memory_used_bytes: 0 } }} version="0.1.0" />);
    expect(screen.getByText("0%")).toBeVisible();
    expect(screen.getByText("0.0 / 15.9 GB")).toBeVisible();
  });

  it("remains open with actionable feedback when settings totally fail to load", () => {
    const retry = vi.fn();
    render(
      <SettingsDrawer
        engines={[]}
        settings={null}
        loadError="temporary settings failure"
        metrics={null}
        projectId={null}
        projectPath={null}
        onClose={vi.fn()}
        onSettings={vi.fn()}
        onEngines={vi.fn()}
        onError={vi.fn()}
        onRetrySettings={retry}
      />,
    );
    expect(screen.getByRole("dialog", { name: "应用设置" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("无法加载设置");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps one tab stop, activates tabs with arrows, and exposes panel relationships", () => {
    render(<SettingsDrawer {...loadedProps()} />);
    const engineTab = screen.getByRole("tab", { name: "引擎" });
    const defaultsTab = screen.getByRole("tab", { name: "项目默认值" });
    expect(engineTab).toHaveAttribute("tabindex", "0");
    expect(defaultsTab).toHaveAttribute("tabindex", "-1");
    engineTab.focus();
    fireEvent.keyDown(engineTab, { key: "ArrowRight" });
    expect(defaultsTab).toHaveFocus();
    expect(defaultsTab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(defaultsTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", defaultsTab.id);

    fireEvent.keyDown(defaultsTab, { key: "End" });
    expect(screen.getByRole("tab", { name: "诊断" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "诊断" }), { key: "Home" });
    expect(engineTab).toHaveFocus();
  });

  it("uses the latest close callback after a parent rerender without losing initial focus", () => {
    const firstClose = vi.fn();
    const nextClose = vi.fn();
    const view = render(<SettingsDrawer {...loadedProps(firstClose)} />);
    const close = screen.getByRole("button", { name: "关闭设置" });
    expect(close).toHaveFocus();
    view.rerender(<SettingsDrawer {...loadedProps(nextClose)} />);
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(firstClose).not.toHaveBeenCalled();
    expect(nextClose).toHaveBeenCalledTimes(1);
  });
});
