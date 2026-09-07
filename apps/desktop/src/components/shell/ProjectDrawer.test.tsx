import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "../../types";
import { ProjectSidebar } from "./ProjectSidebar";

function project(index: number): ProjectInfo {
  return {
    id: `project-${index}`,
    name: `项目 ${index}`,
    path: `D:\\projects\\${index}.splat-project`,
    status: "ready",
    updated_at: "2026-08-14T00:00:00Z",
  };
}

function compactMatchMedia(): MediaQueryList {
  return {
    matches: true,
    media: "(max-width: 1120px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

function renderCompactSidebar() {
  const noop = vi.fn();
  return render(
    <ProjectSidebar
      projects={Array.from({ length: 25 }, (_, index) => project(index))}
      activeProjectPath={null}
      collapsed={false}
      onToggle={noop}
      onHome={noop}
      onNewProject={noop}
      onOpenProject={noop}
      onSelectProject={noop}
      onRevealProject={noop}
      onRemoveProject={noop}
      onDeleteProject={noop}
    />,
  );
}

describe("compact project drawer", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(() => compactMatchMedia()));
  });

  it("opens the complete searchable list and per-project menu in one action", () => {
    renderCompactSidebar();
    const opener = screen.getByRole("button", { name: "打开全部项目" });
    expect(screen.queryByRole("dialog", { name: "全部项目" })).not.toBeInTheDocument();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "全部项目" });
    expect(within(dialog).getAllByRole("button", { name: /^项目 \d+$/ })).toHaveLength(25);
    expect(within(dialog).getByRole("textbox", { name: "按项目名称或路径搜索" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "项目 24 项目操作" }));
    expect(within(dialog).getByRole("menu")).toBeInTheDocument();
    expect(within(dialog).getByRole("menuitem", { name: /永久删除项目/ })).toBeInTheDocument();
  });

  it("traps focus and closes with Escape while restoring the opener", async () => {
    renderCompactSidebar();
    const opener = screen.getByRole("button", { name: "打开全部项目" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "全部项目" });
    const close = within(dialog).getByRole("button", { name: "关闭项目抽屉" });
    expect(document.activeElement).toBe(close);

    const focusableButtons = within(dialog).getAllByRole("button");
    const last = focusableButtons[focusableButtons.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "全部项目" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on a safe backdrop click and restores the opener", async () => {
    renderCompactSidebar();
    const opener = screen.getByRole("button", { name: "打开全部项目" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "全部项目" });
    const backdrop = dialog.parentElement;
    expect(backdrop).toHaveClass("modal-backdrop");
    fireEvent.mouseDown(backdrop!);
    expect(screen.queryByRole("dialog", { name: "全部项目" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
