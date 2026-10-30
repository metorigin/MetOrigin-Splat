import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { ModalSurface } from "../primitives";
import { ProjectDrawer } from "./ProjectDrawer";
import { ProjectSidebar } from "./ProjectSidebar";

type DrawerActions = {
  onHome?: () => void;
  onOpenSettings?: () => void;
  navigationDisabled?: boolean;
};

function renderCompactSidebar(actions: DrawerActions = {}, onDrawerChange = vi.fn()) {
  return render(<SidebarWithTitlebar
    actions={actions}
    onDrawerChange={onDrawerChange}
  />);
}

function SidebarWithTitlebar({ compact = true, onDrawerChange = () => undefined, actions = {} }: {
  compact?: boolean;
  onDrawerChange?: (open: boolean) => void;
  actions?: DrawerActions;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const noop = () => undefined;
  return <>
    <button onClick={() => { setDrawerOpen(true); onDrawerChange(true); }}>打开项目导航</button>
    <ProjectSidebar
      activeProjectPath={null}
      collapsed={false}
      viewportCompact={compact}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={(open) => { setDrawerOpen(open); onDrawerChange(open); }}
      onHome={actions.onHome ?? noop}
      onOpenSettings={actions.onOpenSettings ?? noop}
      navigationDisabled={actions.navigationDisabled}
    />
  </>;
}

function DrawerWithActions({ actions, onClose = () => undefined }: { actions: DrawerActions; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开项目导航</button>
    {open ? <ProjectDrawer
      {...actions}
      onClose={() => { setOpen(false); onClose(); }}
    /> : null}
  </>;
}

function DrawerSettingsHandoff() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return <>
    <DrawerWithActions actions={{ onOpenSettings: () => setSettingsOpen(true) }} />
    {settingsOpen ? <ModalSurface id="drawer-settings-test" title="设置与引擎" onClose={() => setSettingsOpen(false)}>
      <button onClick={() => setSettingsOpen(false)}>关闭设置</button>
    </ModalSurface> : null}
  </>;
}

describe("compact project drawer", () => {
  it("opens project navigation with only the project hub and settings", () => {
    renderCompactSidebar();
    expect(document.querySelector("aside")).not.toBeInTheDocument();
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "项目导航" });
    expect(within(dialog).getByRole("button", { name: "项目中心" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "设置与引擎" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "关闭项目抽屉" })).toBeVisible();
    expect(within(dialog).getAllByRole("button")).toHaveLength(3);
    expect(within(dialog).queryByText("最近项目")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "按项目名称或路径搜索" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "打开项目" })).not.toBeInTheDocument();
  });

  it("traps focus and closes with Escape while restoring the opener", async () => {
    renderCompactSidebar();
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "项目导航" });
    const close = within(dialog).getByRole("button", { name: "关闭项目抽屉" });
    expect(document.activeElement).toBe(close);

    const focusableButtons = within(dialog).getAllByRole("button");
    const last = focusableButtons[focusableButtons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on a safe backdrop click and restores the opener", async () => {
    renderCompactSidebar();
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    opener.focus();
    fireEvent.click(opener);
    const backdrop = document.querySelector("[data-slot='dialog-overlay']");
    expect(backdrop).toBeInTheDocument();
    // Radix registers its outside-pointer listener after the portal mounts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(backdrop!, { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("opens from an external titlebar control and restores that control after Escape", async () => {
    const onDrawerChange = vi.fn();
    render(<SidebarWithTitlebar onDrawerChange={onDrawerChange} />);
    expect(document.querySelector("aside")).not.toBeInTheDocument();
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "项目导航" });
    const close = within(dialog).getByRole("button", { name: "关闭项目抽屉" });
    expect(close).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "项目中心" })).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onDrawerChange.mock.calls).toEqual([[true], [false]]);
  });

  it("closes a controlled drawer once when the window expands and restores the sidebar", async () => {
    const onDrawerChange = vi.fn();
    const view = render(<SidebarWithTitlebar onDrawerChange={onDrawerChange} />);
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "项目导航" })).toBeVisible();
    view.rerender(<SidebarWithTitlebar compact={false} onDrawerChange={onDrawerChange} />);
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    expect(document.querySelector("aside")).toBeVisible();
    expect(screen.getByRole("button", { name: "项目中心" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "折叠项目栏" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    view.rerender(<SidebarWithTitlebar compact={false} onDrawerChange={onDrawerChange} />);
    expect(onDrawerChange.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["项目中心", "onHome"],
    ["设置与引擎", "onOpenSettings"],
  ] as const)("closes the drawer before invoking %s", (label, callback) => {
    const action = vi.fn();
    const onClose = vi.fn();
    render(<DrawerWithActions actions={{ [callback]: action }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "打开项目导航" }));
    const dialog = screen.getByRole("dialog", { name: "项目导航" });
    expect(document.querySelector("aside")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: label }));

    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]);
  });

  it("keeps settings available while workspace navigation is disabled", () => {
    const actions = {
      onHome: vi.fn(),
      onOpenSettings: vi.fn(),
      navigationDisabled: true,
    };
    renderCompactSidebar(actions);
    fireEvent.click(screen.getByRole("button", { name: "打开项目导航" }));
    const dialog = screen.getByRole("dialog", { name: "项目导航" });

    const home = within(dialog).getByRole("button", { name: "项目中心" });
    expect(home).toBeDisabled();
    // Native activation respects the disabled fieldset; a synthetic click
    // dispatch would bypass the browser's disabled-control suppression.
    home.click();
    expect(actions.onHome).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    const settings = within(dialog).getByRole("button", { name: "设置与引擎" });
    expect(settings).toBeEnabled();
    fireEvent.click(settings);
    expect(actions.onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
  });

  it("keeps focus inside settings after the drawer closes", async () => {
    render(<DrawerSettingsHandoff />);
    const opener = screen.getByRole("button", { name: "打开项目导航" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(within(screen.getByRole("dialog", { name: "项目导航" })).getByRole("button", { name: "设置与引擎" }));

    expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
    const closeSettings = within(screen.getByRole("dialog", { name: "设置与引擎" })).getByRole("button", { name: "关闭设置" });
    await waitFor(() => expect(closeSettings).toHaveFocus());
    // The old drawer schedules opener restoration on the next animation frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(closeSettings).toHaveFocus();
  });
});
