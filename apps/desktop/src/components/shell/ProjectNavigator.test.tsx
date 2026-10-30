import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInfo, RecentProjectAvailability } from "../../types";
import { ProjectNavigator } from "./ProjectNavigator";
import type { ProjectNavigatorProps } from "./ProjectNavigator";

function project(index: number, status: ProjectInfo["status"] = "ready"): ProjectInfo {
  return {
    id: `project-${index}`,
    name: `扫描项目 ${index}`,
    path: `D:\\capture\\batch-${index}\\project.splat-project`,
    status,
    updated_at: `2026-08-14T${String(index % 24).padStart(2, "0")}:00:00Z`,
    stage_label: status === "running" ? "BrushTraining" : undefined,
  };
}

function availability(
  item: ProjectInfo,
  status: RecentProjectAvailability["status"],
): RecentProjectAvailability {
  return {
    status,
    checkedPath: item.path,
    checkedAt: status === "unknown" || status === "checking" ? null : "2026-08-14T08:30:00Z",
    reasonCode: status === "check_failed" ? "UI-PROJECT-PATH-UNAVAILABLE" : null,
    generation: 1,
  };
}

function props(overrides: Partial<ProjectNavigatorProps> = {}): ProjectNavigatorProps {
  const projects = overrides.projects ?? [project(1)];
  return {
    projects,
    availability: Object.fromEntries(projects.map((item) => [item.id, availability(item, "available")])),
    activeProjectPath: null,
    onSelectProject: vi.fn(),
    onRevealProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRetryAvailability: vi.fn(),
    onRelinkProject: vi.fn(async () => ({ kind: "cancelled" as const })),
    onOpenIndependent: vi.fn(),
    ...overrides,
  };
}

describe("ProjectNavigator", () => {
  it("shows up to fifty projects immediately and searches by name or full path", () => {
    const projects = Array.from({ length: 55 }, (_, index) => project(index));
    render(<ProjectNavigator {...props({ projects, availability: {} })} />);
    expect(screen.getAllByRole("button", { name: /扫描项目 \d+$/ })).toHaveLength(50);

    const search = screen.getByRole("textbox", { name: "按项目名称或路径搜索" });
    fireEvent.change(search, { target: { value: "batch-54" } });
    expect(screen.getByRole("button", { name: "扫描项目 54" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "扫描项目 4" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "扫描项目 17" } });
    expect(screen.getByRole("button", { name: "扫描项目 17" })).toBeInTheDocument();
  });

  it("renders lifecycle and path-health states with distinct non-color text", () => {
    const projects = [
      project(1, "ready"),
      project(2, "running"),
      project(3, "failed"),
      project(4, "completed"),
      project(5, "ready"),
    ];
    const health = {
      [projects[0].id]: availability(projects[0], "available"),
      [projects[1].id]: availability(projects[1], "missing"),
      [projects[2].id]: availability(projects[2], "unreadable"),
      [projects[3].id]: availability(projects[3], "check_failed"),
      [projects[4].id]: availability(projects[4], "checking"),
    };
    render(<ProjectNavigator {...props({ projects, availability: health })} />);

    expect(screen.getAllByText("就绪")).toHaveLength(2);
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("路径可用")).toBeInTheDocument();
    expect(screen.getByText("路径已丢失")).toBeInTheDocument();
    expect(screen.getByText("项目数据无法读取")).toBeInTheDocument();
    expect(screen.getByText("暂时无法检查")).toBeInTheDocument();
    expect(screen.getByText("记录已保留")).toBeInTheDocument();
    expect(screen.getByText("正在检查路径")).toBeInTheDocument();
    expect(screen.getByText("请检查项目数据，或选择正确的项目位置。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重试检查" })).toHaveLength(1);
  });

  it("can suppress healthy catalog path rows while retaining failed checks and their recovery", () => {
    const projects = [project(1), project(2), project(3), project(4)];
    const states = ["available", "checking", "unknown", "check_failed"] as const;
    render(<ProjectNavigator {...props({
      projects,
      availability: Object.fromEntries(projects.map((item, index) => [item.id, availability(item, states[index])])),
    })} catalog showHealthyAvailability={false} />);
    expect(screen.queryByText("路径可用")).not.toBeInTheDocument();
    expect(screen.queryByText("正在检查路径")).not.toBeInTheDocument();
    expect(screen.queryByText("等待检查路径")).not.toBeInTheDocument();
    expect(screen.getByText("暂时无法检查")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试检查" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: /扫描项目 \d+$/ })).toHaveLength(4);
  });

  it("renders gallery thumbnails and names while retaining full project identity in its description and actions", async () => {
    const item = project(1, "running");
    const renderThumbnail = vi.fn((value: ProjectInfo) => <img src="/fixtures/capture.png" alt={`${value.name} 输入照片`} />);
    const value = props({ projects: [item], renderThumbnail });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(renderThumbnail).toHaveBeenCalledWith(item);
    expect(screen.getByRole("img", { name: `${item.name} 输入照片` })).toHaveAttribute("src", "/fixtures/capture.png");
    const open = screen.getByRole("button", { name: item.name });
    expect(open).toHaveAccessibleDescription(expect.stringContaining(`运行中 · Brush 训练 · ${item.path} · 路径可用`));
    expect(open).toHaveAttribute("title", expect.stringContaining(item.path));
    expect(screen.queryByText("Brush 训练")).not.toBeInTheDocument();
    expect(screen.queryByText("路径可用")).not.toBeInTheDocument();
    expect(screen.queryByTitle(item.path)).not.toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
    fireEvent.click(open);
    expect(value.onSelectProject).toHaveBeenCalledWith(item);

    const menu = screen.getByRole("button", { name: `${item.name} 项目操作` });
    menu.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "从最近项目移除" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "在资源管理器中显示" }));
    expect(value.onRevealProject).toHaveBeenCalledWith(item);
    expect(value.onSelectProject).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu).toHaveFocus());
  });

  it("keeps gallery cards to photos and names with lifecycle and path-health details only in their descriptions", () => {
    const projects = [project(1, "completed"), project(2, "running"), project(3, "failed"), project(4, "paused"), project(5, "ready")];
    const states = ["available", "missing", "unreadable", "check_failed", "checking"] as const;
    render(<ProjectNavigator {...props({
      projects,
      availability: Object.fromEntries(projects.map((item, index) => [item.id, availability(item, states[index])])),
      renderThumbnail: (item) => <img src="/fixtures/capture.png" alt={`${item.name} 输入照片`} />,
    })} gallery showSearch={false} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(projects.length);
    expect(screen.getAllByRole("img")).toHaveLength(projects.length);
    ["已完成", "运行中", "Brush 训练", "失败", "已暂停", "就绪", "路径可用", "路径已丢失", "项目数据无法读取", "暂时无法检查", "正在检查路径", "记录已保留"].forEach((label) => expect(screen.queryByText(label)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    projects.forEach((item, index) => {
      const open = screen.getByRole("button", { name: item.name });
      expect(within(open).getByTitle(item.name)).toHaveTextContent(item.name);
      expect(open).toHaveAccessibleDescription(expect.stringContaining(item.path));
      expect(open).toHaveAttribute("title", expect.stringContaining(item.path));
      const health = ["路径可用", "路径已丢失", "项目数据无法读取", "暂时无法检查", "正在检查路径"][index];
      expect(open).toHaveAccessibleDescription(expect.stringContaining(health));
    });
    expect(screen.getAllByRole("button")).toHaveLength(projects.length * 2);
  });

  it.each(["more", "context"] as const)("retains gallery recovery actions in the %s menu", async (surface) => {
    const projects = [project(1), project(2)];
    const value = props({ projects, availability: {
      [projects[0].id]: availability(projects[0], "missing"),
      [projects[1].id]: availability(projects[1], "check_failed"),
    } });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    for (const [index, label] of ["重新定位", "重试检查"].entries()) {
      const item = projects[index];
      const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
      if (surface === "more") {
        trigger.focus();
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
      } else {
        fireEvent.contextMenu(screen.getByRole("button", { name: item.name }), { button: 2, clientX: 120, clientY: 80 });
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: label }));
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    }
    expect(value.onRelinkProject).toHaveBeenCalledTimes(1);
    expect(value.onRelinkProject).toHaveBeenCalledWith(projects[0]);
    expect(value.onRetryAvailability).toHaveBeenCalledTimes(1);
    expect(value.onRetryAvailability).toHaveBeenCalledWith(projects[1].id);
    expect(value.onSelectProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
  });

  it("keeps gallery retry focus and prevents duplicate checks without adding a persistent status row", async () => {
    const item = project(1);
    let finish!: () => void;
    const onRetryAvailability = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const value = props({ projects: [item], availability: { [item.id]: availability(item, "check_failed") }, onRetryAvailability });
    const view = render(<ProjectNavigator {...value} gallery showSearch={false} />);
    const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重试检查" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const retry = await screen.findByRole("menuitem", { name: "重试检查" });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(retry);
    expect(onRetryAvailability).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    await act(async () => finish());
    view.rerender(<ProjectNavigator {...value} availability={{ [item.id]: availability(item, "available") }} gallery showSearch={false} />);
    expect(trigger).toHaveFocus();
    expect(screen.queryByText("路径可用")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: item.name })).toHaveAccessibleDescription(expect.stringContaining("路径可用"));
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "重试检查" })).not.toBeInTheDocument();
  });

  it("retains an explicit gallery relink error after selecting recovery from its context menu", async () => {
    const item = project(1);
    const onRelinkProject = vi.fn(async () => ({ kind: "error" as const, code: "UI-PROJECT-PATH-UNAVAILABLE", message: "无法读取所选目录" }));
    const value = props({ projects: [item], availability: { [item.id]: availability(item, "missing") }, onRelinkProject });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("button", { name: item.name }), { button: 2, clientX: 120, clientY: 80 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重新定位" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法重新定位");
    expect(screen.getByRole("alert")).toHaveTextContent("UI-PROJECT-PATH-UNAVAILABLE");
    expect(screen.getByRole("button", { name: item.name })).toBeInTheDocument();
    expect(value.onSelectProject).not.toHaveBeenCalled();
    expect(value.onOpenIndependent).not.toHaveBeenCalled();
  });

  it("keeps the compact sidebar independent from the gallery thumbnail renderer", () => {
    const renderThumbnail = vi.fn(() => <img src="/fixtures/capture.png" alt="输入照片" />);
    render(<ProjectNavigator {...props({ renderThumbnail })} compact gallery showSearch={false} />);
    expect(renderThumbnail).not.toHaveBeenCalled();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "就绪" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "输入照片" })).not.toBeInTheDocument();
  });

  it("opens a gallery context menu on right click without opening the project and restores keyboard focus on Escape", async () => {
    const item = project(1);
    const value = props({ projects: [item] });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    const open = screen.getByRole("button", { name: item.name });
    const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    fireEvent(open, context);
    expect(context.defaultPrevented).toBe(true);
    expect(value.onSelectProject).not.toHaveBeenCalled();
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAccessibleName(`${item.name} 项目操作`);
    expect(within(menu).queryByRole("menuitem", { name: "从最近项目移除" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "永久删除项目" })).not.toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));

    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(value.onSelectProject).not.toHaveBeenCalled();
    expect(value.onDeleteProject).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "在资源管理器中显示" })).toHaveFocus());
  });

  it.each([
    { name: "right mouse", button: 2, ctrlKey: false },
    { name: "Control-click", button: 0, ctrlKey: true },
  ])("does not select any gallery action when the opening $name release lands over a menu item", async ({ button, ctrlKey }) => {
    const item = project(1);
    const value = props({ projects: [item], onNavigate: vi.fn() });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    const open = screen.getByRole("button", { name: item.name });
    const pointer = (target: HTMLElement, type: "pointerdown" | "pointerup") => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, buttons: type === "pointerdown" ? button === 2 ? 2 : 1 : 0, ctrlKey, clientX: 120, clientY: 80 });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(target, event);
    };
    pointer(open, "pointerdown");
    fireEvent.contextMenu(open, { button, ctrlKey, clientX: 120, clientY: 80 });
    const danger = await screen.findByRole("menuitem", { name: "永久删除项目" });
    // A newly appeared item did not receive the opening pointerdown. Its
    // pointerup must not synthesize a primary click and choose that action.
    pointer(danger, "pointerup");
    fireEvent.click(danger, { button, ctrlKey });
    [value.onSelectProject, value.onRevealProject, value.onDeleteProject, value.onRetryAvailability, value.onRelinkProject, value.onNavigate].forEach((action) => expect(action).not.toHaveBeenCalled());
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    fireEvent.keyDown(menu, { key: "Home" });
    const reveal = screen.getByRole("menuitem", { name: "在资源管理器中显示" });
    await waitFor(() => expect(reveal).toHaveFocus());
    fireEvent.keyDown(reveal, { key: "Enter" });
    expect(value.onRevealProject).toHaveBeenCalledTimes(1);
    expect(value.onRevealProject).toHaveBeenCalledWith(item);
    expect(value.onDeleteProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it.each(["more", "context"] as const)("keeps permanent deletion disabled for a running project in the %s menu", async (surface) => {
    const item = project(1, "running");
    const value = props({ projects: [item] });
    render(<ProjectNavigator {...value} gallery showSearch={false} />);
    if (surface === "more") {
      const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    } else {
      fireEvent.contextMenu(screen.getByRole("button", { name: item.name }), { button: 2, clientX: 120, clientY: 80 });
    }
    expect(await screen.findByRole("menuitem", { name: "永久删除项目" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "从最近项目移除" })).not.toBeInTheDocument();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "End" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "在资源管理器中显示" })).toHaveFocus());
    expect(value.onDeleteProject).not.toHaveBeenCalled();
  });

  it.each(["catalog", "compact"] as const)("keeps native right-click behavior in the %s presentation", (presentation) => {
    const item = project(1);
    render(<ProjectNavigator {...props({ projects: [item] })} {...{ [presentation]: true }} showSearch={false} />);
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    fireEvent(screen.getByRole("button", { name: item.name }), context);
    expect(context.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps compact and catalog descriptions isolated for the same project across instances", () => {
    const item = project(1, "completed");
    const compactView = render(<ProjectNavigator {...props({ projects: [item] })} compact showSearch={false} />);
    const compact = within(compactView.container);
    const compactOpen = compact.getByRole("button", { name: item.name });
    expect(compactOpen).toHaveAccessibleDescription(`已完成 · ${item.path} · 路径可用`);
    expect(compactOpen).toHaveAttribute("title", expect.stringContaining("路径可用"));
    expect(compact.getByRole("img", { name: "已完成" })).toBeInTheDocument();
    expect(compact.queryByText("已完成")).not.toBeInTheDocument();
    expect(compact.queryByText("路径可用")).not.toBeInTheDocument();
    expect(compact.queryByRole("textbox")).not.toBeInTheDocument();

    const catalogItem = { ...item, status: "running" as const, stage_label: "BrushTraining", path: "/Users/test/captures/batch-1/project.splat-project" };
    const catalogProps = props({ projects: [catalogItem], availability: { [item.id]: availability(catalogItem, "missing") } });
    const catalogView = render(<ProjectNavigator {...catalogProps} catalog showSearch={false} showHealthyAvailability={false} />);
    const catalog = within(catalogView.container);
    const catalogOpen = catalog.getByRole("button", { name: item.name });
    expect(catalogOpen).toHaveAccessibleDescription(`运行中 · Brush 训练 · ${catalogItem.path} · 路径已丢失`);
    expect(catalog.getByTitle(catalogItem.path)).toHaveTextContent("…/batch-1/project.splat-project");
    const time = catalogView.container.querySelector("time");
    expect(time).toHaveAttribute("datetime", catalogItem.updated_at);
    expect(time?.parentElement).toBe(catalogOpen.parentElement);
    expect(catalogOpen.querySelector("time")).toBeNull();
    fireEvent.click(catalogOpen);
    expect(catalogProps.onSelectProject).toHaveBeenCalledWith(catalogItem);

    const compactSummary = compactOpen.getAttribute("aria-describedby");
    const catalogSummary = catalogOpen.getAttribute("aria-describedby");
    expect(compactSummary).toBeTruthy();
    expect(catalogSummary).toBeTruthy();
    expect(compactSummary).not.toBe(catalogSummary);
    [compactSummary, catalogSummary].forEach((id) => {
      expect(Array.from(document.querySelectorAll("[id]")).filter((element) => element.id === id)).toHaveLength(1);
    });
    catalogView.rerender(<ProjectNavigator {...catalogProps} availability={{ [item.id]: availability(catalogItem, "available") }} catalog showSearch={false} showHealthyAvailability={false} />);
    expect(catalogOpen).toHaveAttribute("aria-describedby", catalogSummary);
    expect(catalogOpen).toHaveAccessibleDescription(`运行中 · Brush 训练 · ${catalogItem.path} · 路径可用`);
    expect(compactOpen).toHaveAccessibleDescription(`已完成 · ${item.path} · 路径可用`);
  });

  it("keeps unavailable compact projects on one row with repair available from their menu", async () => {
    const item = project(1);
    const onRelinkProject = vi.fn(async () => ({ kind: "cancelled" as const }));
    render(<ProjectNavigator {...props({ projects: [item], availability: { [item.id]: availability(item, "missing") }, onRelinkProject })} compact showSearch={false} />);
    const open = screen.getByRole("button", { name: item.name });
    expect(open).toHaveAccessibleDescription(expect.stringContaining("路径已丢失"));
    expect(open).toHaveAttribute("title", expect.stringContaining(item.path));
    expect(screen.getByRole("img", { name: "路径已丢失" })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.queryByText("路径已丢失")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const relink = await screen.findByRole("menuitem", { name: "重新定位" });
    fireEvent.click(relink);
    expect(onRelinkProject).toHaveBeenCalledWith(item);
  });

  it("retries a compact path-check failure from its menu and returns focus to the row control", async () => {
    const item = project(1);
    const onRetryAvailability = vi.fn();
    const value = props({ projects: [item], availability: { [item.id]: availability(item, "check_failed") }, onRetryAvailability });
    const view = render(<ProjectNavigator {...value} compact showSearch={false} />);
    const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
    expect(screen.getByRole("img", { name: "暂时无法检查" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重试检查" }));
    expect(onRetryAvailability).toHaveBeenCalledWith(item.id);
    await waitFor(() => expect(trigger).toHaveFocus());

    view.rerender(<ProjectNavigator {...value} availability={{ [item.id]: availability(item, "available") }} compact showSearch={false} />);
    expect(screen.getByRole("button", { name: item.name })).toHaveAccessibleDescription(expect.stringContaining("路径可用"));
    expect(screen.getByRole("img", { name: "就绪" })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "重试检查" })).not.toBeInTheDocument();
  });

  it("keeps row order, focused control, and an open menu stable during updates", async () => {
    const projects = [project(1), project(2), project(3)];
    const view = render(<ProjectNavigator {...props({ projects, availability: {} })} compact />);
    const secondTrigger = screen.getByRole("button", { name: "扫描项目 2 项目操作" });
    secondTrigger.focus();
    fireEvent.keyDown(secondTrigger, { key: "ArrowDown" });
    const focusedItem = await screen.findByRole("menuitem", { name: /在资源管理器中显示/ });
    await waitFor(() => expect(focusedItem).toHaveFocus());
    expect(screen.getByRole("menu")).toBeInTheDocument();

    const updated = projects.map((item) => item.id === "project-1" ? { ...item, status: "completed" as const } : item);
    view.rerender(<ProjectNavigator {...props({ projects: updated, availability: {
      "project-1": availability(updated[0], "available"),
    } })} compact />);
    expect(document.activeElement).toBe(focusedItem);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(focusedItem, { key: "Escape" });
    await waitFor(() => expect(secondTrigger).toHaveFocus());
    expect(screen.getAllByRole("button", { name: /扫描项目 \d+$/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining("扫描项目 1"),
      expect.stringContaining("扫描项目 2"),
      expect.stringContaining("扫描项目 3"),
    ]);
  });

  it("retries only check-failed catalog records and preserves focus when the result changes", async () => {
    const item = project(1);
    const onRetryAvailability = vi.fn();
    const view = render(<ProjectNavigator {...props({
      projects: [item],
      availability: { [item.id]: availability(item, "check_failed") },
      onRetryAvailability,
    })} catalog />);
    const retry = screen.getByRole("button", { name: "重试检查" });
    retry.focus();
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onRetryAvailability).toHaveBeenCalledTimes(1);

    view.rerender(<ProjectNavigator {...props({
      projects: [item],
      availability: { [item.id]: availability(item, "available") },
      onRetryAvailability,
    })} catalog />);
    expect(document.activeElement).toBe(retry);
    expect(retry).toHaveTextContent("路径可用");
    expect(retry).toHaveAttribute("aria-disabled", "true");
  });

  it.each(["catalog", "gallery"] as const)("preserves a mismatched %s record and opens the candidate only after explicit choice", async (presentation) => {
    const item = project(1);
    const onOpenIndependent = vi.fn();
    const onNavigate = vi.fn();
    const onRelinkProject = vi.fn(async () => ({
      kind: "mismatch" as const,
      candidatePath: "D:\\capture\\different-project",
      code: "UI-PROJECT-RELINK-MISMATCH",
    }));
    render(<ProjectNavigator {...props({
      projects: [item],
      availability: { [item.id]: availability(item, "missing") },
      onRelinkProject,
      onOpenIndependent,
      onNavigate,
    })} {...{ [presentation]: true }} />);

    if (presentation === "gallery") {
      const trigger = screen.getByRole("button", { name: `${item.name} 项目操作` });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "重新定位" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "重新定位" }));
    }
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("原记录未更改"));
    expect(screen.getByRole("button", { name: "扫描项目 1" })).toBeInTheDocument();
    expect(onOpenIndependent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "作为独立项目打开" }));
    expect(onOpenIndependent).toHaveBeenCalledWith("D:\\capture\\different-project");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("opens project menus into focus and supports arrows, boundaries, Escape, and Tab", async () => {
    const item = project(1);
    render(<ProjectNavigator {...props({ projects: [item] })} />);
    const trigger = screen.getByRole("button", { name: "扫描项目 1 项目操作" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("menuitem", { name: /在资源管理器中显示/ });
    await waitFor(() => expect(first).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("menu").id);

    fireEvent.keyDown(first, { key: "End" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /永久删除项目/ }), { key: "Home" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /永久删除项目/ }), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each([false, true])("skips disabled project-menu actions for an active project with gallery=%s", async (gallery) => {
    const running = project(1, "running");
    render(<ProjectNavigator {...props({ projects: [running] })} gallery={gallery} />);
    const trigger = screen.getByRole("button", { name: "扫描项目 1 项目操作" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /在资源管理器中显示/ })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toHaveAttribute("aria-disabled", "true");
  });
});
