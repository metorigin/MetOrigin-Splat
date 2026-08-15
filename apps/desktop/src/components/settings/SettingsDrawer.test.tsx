import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsDrawer } from "./SettingsDrawer";

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
