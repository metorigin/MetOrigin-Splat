import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    onRemoveProject: vi.fn(),
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

  it("keeps row order, focused control, and an open menu stable during updates", () => {
    const projects = [project(1), project(2), project(3)];
    const view = render(<ProjectNavigator {...props({ projects, availability: {} })} />);
    const secondTrigger = screen.getByRole("button", { name: "扫描项目 2 项目操作" });
    secondTrigger.focus();
    fireEvent.click(secondTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    const updated = projects.map((item) => item.id === "project-1" ? { ...item, status: "completed" as const } : item);
    view.rerender(<ProjectNavigator {...props({ projects: updated, availability: {
      "project-1": availability(updated[0], "available"),
    } })} />);
    expect(document.activeElement).toBe(secondTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /扫描项目 \d+$/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining("扫描项目 1"),
      expect.stringContaining("扫描项目 2"),
      expect.stringContaining("扫描项目 3"),
    ]);
  });

  it("retries only check-failed records and preserves focus when the result changes", async () => {
    const item = project(1);
    const onRetryAvailability = vi.fn();
    const view = render(<ProjectNavigator {...props({
      projects: [item],
      availability: { [item.id]: availability(item, "check_failed") },
      onRetryAvailability,
    })} />);
    const retry = screen.getByRole("button", { name: "重试检查" });
    retry.focus();
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onRetryAvailability).toHaveBeenCalledTimes(1);

    view.rerender(<ProjectNavigator {...props({
      projects: [item],
      availability: { [item.id]: availability(item, "available") },
      onRetryAvailability,
    })} />);
    expect(document.activeElement).toBe(retry);
    expect(retry).toHaveTextContent("路径可用");
    expect(retry).toHaveAttribute("aria-disabled", "true");
  });

  it("preserves a mismatched record and opens the candidate only after explicit choice", async () => {
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
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "重新定位" }));
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
    expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /永久删除项目/ }), { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /永久删除项目/ }), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("skips disabled project-menu actions for an active project", async () => {
    const running = project(1, "running");
    render(<ProjectNavigator {...props({ projects: [running] })} />);
    const trigger = screen.getByRole("button", { name: "扫描项目 1 项目操作" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /在资源管理器中显示/ })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toBeDisabled();
  });
});
