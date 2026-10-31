import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopTitlebar } from "./DesktopTitlebar";

const platform = vi.hoisted(() => ({ desktop: true, mac: false, windows: true }));

vi.mock("../../services/desktop", () => ({ isDesktopRuntime: () => platform.desktop }));
vi.mock("../../lib/platformShortcuts", () => ({
  isMacPlatform: () => platform.mac,
  isWindowsPlatform: () => platform.windows,
}));

type TitlebarProps = ComponentProps<typeof DesktopTitlebar>;

function props(overrides: Partial<TitlebarProps> = {}): TitlebarProps {
  return {
    sidebarWidth: 272,
    title: "项目中心",
    sidebarCollapsed: false,
    compact: false,
    drawerOpen: false,
    navigationDisabled: false,
    onToggleSidebar: vi.fn(),
    ...overrides,
  };
}

function titlebar(value: TitlebarProps) {
  return <TooltipProvider><DesktopTitlebar {...value} /></TooltipProvider>;
}

describe("DesktopTitlebar regions", () => {
  beforeEach(() => {
    platform.desktop = true;
    platform.mac = false;
    platform.windows = true;
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the application brand on Windows with only the sidebar toggle beside page content", () => {
    const view = render(titlebar(props()));
    const navigation = view.container.querySelector('[data-window-region="navigation"]')!;
    const toggle = screen.getByRole("button", { name: "折叠项目栏" });
    const brand = within(navigation as HTMLElement).getByText("MetOrigin Splat");
    expect(brand).toBeVisible();
    expect(brand).toHaveAttribute("data-tauri-drag-region");
    const icon = navigation.querySelector('img')!;
    expect(icon).toHaveAttribute("width", "28");
    expect(icon).toHaveAttribute("height", "28");
    expect(icon).toHaveAttribute("draggable", "false");
    expect(icon).toHaveAttribute("alt", "");
    expect(icon).toHaveAttribute("data-tauri-drag-region");
    expect(within(navigation as HTMLElement).getAllByRole("button")).toEqual([toggle]);
    const pageHeader = view.container.querySelector('[data-window-region="page-header"]')!;
    expect(view.container.querySelector('[data-window-region="history"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "后退" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "前进" })).not.toBeInTheDocument();
    expect(navigation.nextElementSibling).toBe(pageHeader);
    expect(pageHeader.parentElement).toBe(navigation.parentElement);
    expect(within(pageHeader as HTMLElement).getByRole("heading", { name: "项目中心" })).toBeVisible();
  });

  it.each([
    { name: "macOS", mac: true },
    { name: "Linux", mac: false },
  ])("hides the application brand on $name", ({ mac }) => {
    platform.mac = mac;
    platform.windows = false;
    const view = render(titlebar(props()));
    const navigation = view.container.querySelector('[data-window-region="navigation"]')!;
    const toggle = screen.getByRole("button", { name: "折叠项目栏" });
    expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();
    expect(navigation.querySelector("img")).toBeNull();
    expect(within(navigation as HTMLElement).getAllByRole("button")).toEqual([toggle]);
  });

  it.each([
    { name: "Windows", mac: false, windows: true },
    { name: "macOS", mac: true, windows: false },
  ])("preserves controls, focus, and the header target across collapse on $name", ({ mac, windows }) => {
    platform.mac = mac;
    platform.windows = windows;
    const headerTargetRef = vi.fn((_node: HTMLDivElement | null) => undefined);
    const value = props({ headerTargetRef, children: <input aria-label="页头草稿" defaultValue="draft" /> });
    const view = render(titlebar(value));
    const navigation = view.container.querySelector('[data-window-region="navigation"]')!;
    const pageHeader = view.container.querySelector('[data-window-region="page-header"]')!;
    const toggle = screen.getByRole("button", { name: "折叠项目栏" });
    const draft = screen.getByRole("textbox", { name: "页头草稿" });
    fireEvent.change(draft, { target: { value: "keep this draft" } });
    expect(navigation).toHaveStyle({ width: `${value.sidebarWidth}px` });
    expect(toggle).toHaveAttribute("id", "desktop-sidebar-toggle");
    act(() => toggle.focus());

    view.rerender(titlebar({ ...value, sidebarCollapsed: true }));

    expect(screen.getByRole("button", { name: "展开项目栏" })).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();
    expect(navigation).toHaveStyle({ width: "auto" });
    expect(view.container.querySelector('[data-window-region="page-header"]')).toBe(pageHeader);
    expect(headerTargetRef.mock.calls).toEqual([[pageHeader]]);

    const resizedWidth = 320;
    view.rerender(titlebar({ ...value, sidebarWidth: resizedWidth }));

    expect(screen.getByRole("button", { name: "折叠项目栏" })).toBe(toggle);
    expect(toggle).toHaveFocus();
    if (windows) {
      expect(screen.getByText("MetOrigin Splat")).toBeVisible();
    } else {
      expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();
    }
    expect(navigation).toHaveStyle({ width: `${resizedWidth}px` });
    expect(view.container.querySelector('[data-window-region="page-header"]')).toBe(pageHeader);
    expect(headerTargetRef.mock.calls).toEqual([[pageHeader]]);
    expect(screen.getByRole("textbox", { name: "页头草稿" })).toBe(draft);
    expect(draft).toHaveValue("keep this draft");
  });

  it("invokes the sidebar toggle and disables it while navigation is guarded", () => {
    const value = props();
    const view = render(titlebar(value));
    const toggle = screen.getByRole("button", { name: "折叠项目栏" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(value.onToggleSidebar).toHaveBeenCalledOnce();

    view.rerender(titlebar({ ...value, navigationDisabled: true, sidebarCollapsed: true }));
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(value.onToggleSidebar).toHaveBeenCalledOnce();

    view.rerender(titlebar({ ...value, sidebarCollapsed: true }));
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(value.onToggleSidebar).toHaveBeenCalledTimes(2);
  });

  it("exposes compact drawer state on the same stable toggle", () => {
    const value = props({ compact: true, sidebarCollapsed: true });
    const view = render(titlebar(value));
    const toggle = screen.getByRole("button", { name: "打开项目导航" });
    expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(value.onToggleSidebar).toHaveBeenCalledOnce();

    view.rerender(titlebar({ ...value, drawerOpen: true }));
    expect(screen.getByRole("button", { name: "打开项目导航" })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();

    view.rerender(titlebar({ ...value, compact: false }));
    expect(screen.getByRole("button", { name: "展开项目栏" })).toBe(toggle);
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
