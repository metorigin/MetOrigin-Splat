import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopTitlebar } from "./DesktopTitlebar";

const platform = vi.hoisted(() => ({ desktop: true, mac: true }));

vi.mock("../../services/desktop", () => ({ isDesktopRuntime: () => platform.desktop }));
vi.mock("../../lib/platformShortcuts", () => ({ isMacPlatform: () => platform.mac }));

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
    platform.mac = true;
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the sidebar toggle adjacent to page content without history controls", () => {
    const view = render(titlebar(props()));
    const navigation = view.container.querySelector('[data-window-region="navigation"]')!;
    const toggle = screen.getByRole("button", { name: "折叠项目栏" });
    expect(within(navigation as HTMLElement).getAllByRole("button")).toEqual([toggle]);
    const pageHeader = view.container.querySelector('[data-window-region="page-header"]')!;
    expect(view.container.querySelector('[data-window-region="history"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "后退" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "前进" })).not.toBeInTheDocument();
    expect(navigation.nextElementSibling).toBe(pageHeader);
    expect(pageHeader.parentElement).toBe(navigation.parentElement);
    expect(within(pageHeader as HTMLElement).getByRole("heading", { name: "项目中心" })).toBeVisible();
  });

  it.each([true, false])("preserves controls, focus, and the header target across collapse on nativeMac=%s", (nativeMac) => {
    platform.desktop = nativeMac;
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
    expect(navigation).toHaveStyle({ width: "auto" });
    expect(view.container.querySelector('[data-window-region="page-header"]')).toBe(pageHeader);
    expect(headerTargetRef.mock.calls).toEqual([[pageHeader]]);

    const resizedWidth = 320;
    view.rerender(titlebar({ ...value, sidebarWidth: resizedWidth }));

    expect(screen.getByRole("button", { name: "折叠项目栏" })).toBe(toggle);
    expect(toggle).toHaveFocus();
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
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(value.onToggleSidebar).toHaveBeenCalledOnce();

    view.rerender(titlebar({ ...value, drawerOpen: true }));
    expect(screen.getByRole("button", { name: "打开项目导航" })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    view.rerender(titlebar({ ...value, compact: false }));
    expect(screen.getByRole("button", { name: "展开项目栏" })).toBe(toggle);
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
