import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsDrawer } from "./SettingsDrawer";
import { desktopApi } from "../../services/desktop";
import type { EngineInfo, ResourceMetrics } from "../../types";

const settings = {
  engine_directory: null,
  engine_executables: {},
  default_project_root: null,
  default_preset: "balanced",
  create_and_start: false,
  prevent_idle_sleep: false,
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

afterEach(() => vi.restoreAllMocks());

describe("SettingsDrawer", () => {
  it("keeps macOS idle-sleep prevention off until explicitly saved", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const save = vi.spyOn(desktopApi, "saveAppSettings").mockImplementation(async (next) => next);
    const props = loadedProps();
    const view = render(<SettingsDrawer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    const checkbox = screen.getByRole("switch", { name: "任务运行时防止空闲睡眠" });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription("仅影响之后启动的任务。允许屏幕休眠；合盖、手动睡眠和低电量仍可能中断任务。");
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith({ ...settings, prevent_idle_sleep: true }));
    expect(save).toHaveBeenCalledWith({ ...settings, prevent_idle_sleep: true });
    view.rerender(<SettingsDrawer {...props} settings={{ ...settings, prevent_idle_sleep: true }} />);
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.change(screen.getByRole("combobox", { name: /Language/ }), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("tab", { name: "Performance & Storage" }));
    expect(screen.getByRole("switch", { name: "Prevent idle sleep while a task is running" })).toBeChecked();
  });

  it("does not offer the macOS idle-sleep setting on Windows", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<SettingsDrawer {...loadedProps()} />);
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    expect(screen.queryByRole("switch", { name: "任务运行时防止空闲睡眠" })).not.toBeInTheDocument();
  });

  it("switches language live without saving engine settings or closing the drawer", () => {
    const props = loadedProps();
    render(<SettingsDrawer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "外观" }));
    fireEvent.change(screen.getByRole("combobox", { name: /Language/ }), { target: { value: "en" } });
    expect(screen.getByRole("dialog", { name: "Application settings" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "General" })).toHaveTextContent("General");
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByRole("combobox", { name: /Language/ }), { target: { value: "zh-CN" } });
    expect(screen.getByRole("tab", { name: "外观" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    expect(screen.getByText("默认质量预设")).toBeVisible();
    expect(props.onSettings).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

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
    expect(screen.getByText("2.7 GiB / 15.9 GiB")).toBeVisible();
    expect(screen.getByText("3%")).toBeVisible();
    view.rerender(<SettingsDrawer {...loadedProps()} engines={[engine]} metrics={{ ...metrics, gpu: { ...metrics.gpu!, utilization_percent: 0, memory_used_bytes: 0 } }} version="0.1.0" />);
    expect(screen.getByText("0%")).toBeVisible();
    expect(screen.getByText("0.0 GiB / 15.9 GiB")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    expect(screen.getByText("磁盘可用空间").nextElementSibling).toHaveTextContent("100.0 GiB");
    view.rerender(<SettingsDrawer {...loadedProps()} metrics={{ ...metrics, project_disk_available_bytes: null }} />);
    expect(screen.getByText("磁盘可用空间").nextElementSibling).toHaveTextContent("尚未测量");
    view.rerender(<SettingsDrawer {...loadedProps()} metrics={{ ...metrics, project_disk_available_bytes: 0 }} />);
    expect(screen.getByText("磁盘可用空间").nextElementSibling).toHaveTextContent("0.0 GiB");
  });

  it("labels shared memory truthfully and shows effective settings separately from the requested preset", () => {
    const metrics: ResourceMetrics = {
      timestamp:"2026-10-27T01:00:00Z",operating_system:"macOS",cpu_name:"Apple M1 Pro",cpu_usage_percent:5,
      memory_total_bytes:32*1024**3,memory_used_bytes:12*1024**3,project_disk_available_bytes:null,disk_path:null,warnings:[],
      gpu:{name:"Apple M1 Pro",driver_version:null,memory_total_bytes:null,memory_used_bytes:null,utilization_percent:null,temperature_celsius:null},
      memory:{kind:"unified",available_bytes:20*1024**3,available_source:"mach_host_statistics64_free_plus_inactive",available_is_estimate:true,free_bytes:8*1024**3,inactive_bytes:12*1024**3,compressed_bytes:4*1024**3,pressure:null,pressure_source:null,swap_total_bytes:0,swap_used_bytes:0},
      runtime:{requested_preset:"quality",colmap_backend:"CPU",brush_backend:"Metal",device_name:"Apple M1 Pro",training_budget_bytes:16*1024**3,recommended_working_set_bytes:null,
        effective_training:{iterations:7000,sh_degree:1,resolution:1920,image_cache_budget_bytes:1024**3,max_splats:1500000,threads:6}},
    };
    render(<SettingsDrawer {...loadedProps()} metrics={metrics} />);
    expect(screen.getByText("统一内存")).toBeVisible();
    expect(screen.queryByText("显存（VRAM）")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab",{name:"性能与存储"}));
    expect(screen.getByText("CPU")).toBeVisible();
    expect(screen.getByText("Metal · Apple M1 Pro")).toBeVisible();
    expect(screen.getByText("高质量")).toBeVisible();
    expect(screen.getByText("7,000 steps · SH1 · 1920 px")).toBeVisible();
    expect(screen.getByText("16.0 GiB")).toBeVisible();
    expect(screen.getByText("系统内存压力").nextElementSibling).toHaveTextContent("尚未测量");
    expect(screen.getByText("Metal 建议工作集").nextElementSibling).toHaveTextContent("尚未测量");
    expect(screen.getByText("可回收内存估算").nextElementSibling).toHaveTextContent("20.0 GiB");
    expect(screen.getByText("压缩内存").nextElementSibling).toHaveTextContent("4.0 GiB");
    expect(screen.getByText("估算来自系统空闲与非活跃内存，不重复扣减压缩内存。它不是可保证的分配额度，预览仍优先遵循系统内存压力。")).toBeVisible();
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

  it("keeps one tab stop, activates tabs with arrows, and exposes panel relationships", async () => {
    render(<SettingsDrawer {...loadedProps()} />);
    const engineTab = screen.getByRole("tab", { name: "引擎" });
    const defaultsTab = screen.getByRole("tab", { name: "常规" });
    // Radix makes the tablist the initial entry stop; entering focuses the active tab.
    const tablist = screen.getByRole("tablist", { name: "设置分类" });
    expect([tablist, ...screen.getAllByRole("tab")].filter((element) => element.tabIndex === 0)).toHaveLength(1);
    fireEvent.focus(tablist);
    engineTab.focus();
    fireEvent.keyDown(engineTab, { key: "ArrowUp" });
    await waitFor(() => expect(defaultsTab).toHaveFocus());
    expect(defaultsTab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(defaultsTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", defaultsTab.id);

    fireEvent.keyDown(defaultsTab, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "诊断" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("tab", { name: "诊断" }), { key: "Home" });
    await waitFor(() => expect(defaultsTab).toHaveFocus());
  });

  it("uses the latest close callback after a parent rerender without losing initial focus", () => {
    const firstClose = vi.fn();
    const nextClose = vi.fn();
    const view = render(<SettingsDrawer {...loadedProps(firstClose)} />);
    const close = screen.getByRole("button", { name: "关闭设置" });
    expect(close).toHaveFocus();
    view.rerender(<SettingsDrawer {...loadedProps(nextClose)} />);
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(firstClose).not.toHaveBeenCalled();
    expect(nextClose).toHaveBeenCalledTimes(1);
  });

  it("keeps numeric edits local, rejects empty and out-of-range values, then applies both limits once", async () => {
    const save = vi.spyOn(desktopApi, "saveAppSettings").mockImplementation(async (next) => next);
    const props = loadedProps();
    render(<SettingsDrawer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    const log = screen.getByRole("spinbutton", { name: "结构化事件日志上限（MiB）" });
    const cache = screen.getByRole("spinbutton", { name: "预览缓存上限（MiB）" });
    const apply = screen.getByRole("button", { name: "保存设置" });
    expect(apply).toBeDisabled();
    fireEvent.change(log, { target: { value: "" } });
    expect(log).toHaveAttribute("aria-invalid", "true");
    expect(apply).toBeDisabled();
    fireEvent.change(log, { target: { value: "8192" } });
    expect(apply).toBeDisabled();
    fireEvent.change(log, { target: { value: "512" } });
    fireEvent.change(cache, { target: { value: "1024" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith({ ...settings, log_retention_mb: 512, thumbnail_cache_mb: 1024 }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("preserves unsaved numeric drafts across tab changes and allows retry after a failed save", async () => {
    const save = vi.spyOn(desktopApi, "saveAppSettings").mockRejectedValueOnce(new Error("disk unavailable")).mockImplementation(async (next) => next);
    const props = loadedProps();
    render(<SettingsDrawer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "预览缓存上限（MiB）" }), { target: { value: "1024" } });
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    expect(screen.getByRole("spinbutton", { name: "预览缓存上限（MiB）" })).toHaveValue(1024);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("Error: disk unavailable"));
    expect(props.onSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("disk unavailable");
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith({ ...settings, thumbnail_cache_mb: 1024 }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps the settings shell open and deduplicates saves until persistence finishes", async () => {
    let finish!: (value: typeof settings) => void;
    const save = vi.spyOn(desktopApi, "saveAppSettings").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const props = loadedProps();
    render(<SettingsDrawer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "性能与存储" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "预览缓存上限（MiB）" }), { target: { value: "512" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    const dialog = screen.getByRole("dialog", { name: "应用设置" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "关闭设置" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.submit(screen.getByRole("button", { name: "正在保存" }).closest("form")!);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    finish({ ...settings, thumbnail_cache_mb: 512 });
    await waitFor(() => expect(dialog).not.toHaveAttribute("aria-busy"));
    expect(props.onSettings).toHaveBeenCalledWith({ ...settings, thumbnail_cache_mb: 512 });
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

});
