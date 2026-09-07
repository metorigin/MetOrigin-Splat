import { useEffect } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProvider, useAppContext } from "../context";
import type { ProjectInfo, ResourceMetrics } from "../types";
import { HomePage } from "./HomePage";

const projects: ProjectInfo[] = [
  { id: "recent", name: "最近完成的场景", path: "D:\\projects\\recent", status: "completed", updated_at: "2026-09-07T10:00:00Z" },
  { id: "running", name: "正在重建的场景", path: "C:\\projects\\running", status: "running", updated_at: "2026-09-06T10:00:00Z" },
];

const metrics: ResourceMetrics = {
  timestamp: "2026-09-07T10:00:00Z", operating_system: "Windows 11", cpu_name: null,
  cpu_usage_percent: 0, memory_total_bytes: 32 * 1024 ** 3, memory_used_bytes: 8 * 1024 ** 3,
  project_disk_available_bytes: 120.5 * 1024 ** 3, disk_path: "D:\\Apps\\MetOrigin Splat",
  gpu: null, warnings: [],
};

function SeedProjects() {
  const { dispatch, state } = useAppContext();
  useEffect(() => {
    dispatch({ type: "SET_RECENT_PROJECTS", projects });
    dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot: {
      project_id: projects[1].id, project_path: projects[1].path, status: "running",
      state: { stages: {}, current_stage: "BrushTraining", overall_progress: 0.5 },
      sequence: 1, accepted_at: null, started_at: null, control_intent: "none",
    } });
  }, [dispatch]);
  return <output data-testid="destination">{state.page.type === "project-detail" ? state.page.projectPath : state.page.type}</output>;
}

function renderHome(value: ResourceMetrics | null = metrics) {
  return render(<AppProvider><SeedProjects /><HomePage engines={[]} metrics={value} onOpenProject={vi.fn()} /></AppProvider>);
}

describe("HomePage", () => {
  it("keeps all projects in recent order and opens each row without a featured preview", () => {
    renderHome();
    const recent = within(screen.getByRole("region", { name: "最近项目" }));
    const rows = recent.getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(projects[0].name);
    expect(rows[1]).toHaveTextContent(projects[1].name);
    expect(screen.queryByText("等待开始")).not.toBeInTheDocument();
    expect(screen.queryByText("进度尚未获取")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /进入工作区/ })).not.toBeInTheDocument();
    rows.forEach((row, index) => {
      fireEvent.click(row);
      expect(screen.getByTestId("destination")).toHaveTextContent(projects[index].path);
    });
    expect(screen.queryByText("开始之前，了解设备状态。")).not.toBeInTheDocument();
    expect(screen.queryByText("影像与模型，存储在本机")).not.toBeInTheDocument();
  });

  it("filters the same clickable rows by project name or path", () => {
    renderHome();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目名称或路径" }), { target: { value: "C:\\projects" } });
    const recent = within(screen.getByRole("region", { name: "最近项目" }));
    const row = recent.getByRole("button");
    expect(row).toHaveTextContent(projects[1].name);
    fireEvent.click(row);
    expect(screen.getByTestId("destination")).toHaveTextContent(projects[1].path);
  });

  it("displays measured installation disk space and identifies its drive", () => {
    renderHome();
    const overview = within(screen.getByRole("region", { name: "项目概览" }));
    expect(overview.getByText("120.5 GB")).toBeVisible();
    expect(overview.getByText("应用安装盘 · D:")).toHaveAttribute("title", metrics.disk_path);
    expect(within(screen.getByRole("complementary", { name: "运行环境" })).getByText("120.5 GB 可用")).toBeVisible();
  });

  it.each([null, { ...metrics, project_disk_available_bytes: null }])("does not turn unavailable disk measurements into zero: %s", (value) => {
    renderHome(value);
    const overview = within(screen.getByRole("region", { name: "项目概览" }));
    expect(overview.getByText("尚未测量")).toBeVisible();
    expect(overview.queryByText("0.0 GB")).not.toBeInTheDocument();
  });

  it("preserves a real zero-byte measurement", () => {
    renderHome({ ...metrics, project_disk_available_bytes: 0 });
    expect(within(screen.getByRole("region", { name: "项目概览" })).getByText("0.0 GB")).toBeVisible();
  });
});
