import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProvider, useAppContext } from "../context";
import { AppContext, initialState } from "../context/appContextValue";
import type { EngineInfo, ProjectInfo, RecentProjectAvailability } from "../types";
import { HomePage } from "./HomePage";

const projects: ProjectInfo[] = [
  { id: "recent", name: "最近完成的场景", path: "D:\\projects\\recent", status: "completed", updated_at: "2026-09-07T10:00:00Z" },
  { id: "running", name: "正在重建的场景", path: "C:\\projects\\running", status: "running", updated_at: "2026-09-06T10:00:00Z" },
];

const engine: EngineInfo = {
  name: "ffmpeg", version: "8.1", actual_version: "8.1.2-essentials_build",
  path: "D:\\engines\\ffmpeg.exe", available: true, source: "configured_or_path",
  pack_version: null, integrity_status: "not_applicable", expected_version: null,
  diagnostic: null, checked_at: "2026-09-06T12:00:00Z",
};

function SeedProjects({ records = projects, health }: {
  records?: ProjectInfo[];
  health?: Record<string, RecentProjectAvailability["status"]>;
}) {
  const { dispatch, state } = useAppContext();
  useEffect(() => {
    dispatch({ type: "SET_RECENT_PROJECTS", projects: records });
    records.forEach((project) => {
      const status = health?.[project.id];
      if (!status || status === "unknown") return;
      dispatch({ type: "BEGIN_PROJECT_AVAILABILITY", projectId: project.id, projectPath: project.path, generation: 1 });
      if (status === "checking") return;
      dispatch({ type: "SET_PROJECT_AVAILABILITY", generation: 1, result: {
        project_id: project.id, checked_path: project.path, availability: status,
        checked_at: "2026-10-29T08:00:00Z", reason_code: null, refreshed_project: null,
      } });
    });
    dispatch({ type: "SET_ACTIVE_PIPELINE", snapshot: {
      project_id: projects[1].id, project_path: projects[1].path, status: "running",
      state: { stages: {}, current_stage: "BrushTraining", overall_progress: 0.5 },
      sequence: 1, accepted_at: null, started_at: null, control_intent: "none",
    } });
  }, [dispatch, records, health]);
  return <output data-testid="destination">{state.page.type === "project-detail" ? state.page.projectPath : state.page.type}</output>;
}

function renderHome(onOpenProject = vi.fn()) {
  return render(<AppProvider><SeedProjects /><HomePage engines={[]} onOpenProject={onOpenProject} /></AppProvider>);
}

function projectRows(records: ProjectInfo[]) {
  const names = new Set(records.map((project) => project.name));
  return within(screen.getByRole("region", { name: "全部项目" })).getAllByRole("button")
    .filter((button) => names.has(button.getAttribute("aria-label") ?? ""));
}

async function selectProjectAction(project: ProjectInfo, name: string) {
  const trigger = screen.getByRole("button", { name: `${project.name} 项目操作` });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  return trigger;
}

describe("HomePage", () => {
  it("opens creation from the primary action and restores rows after clearing a failed search", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "项目中心" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    expect(screen.getByTestId("destination")).toHaveTextContent("new-project");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目名称或路径" }), { target: { value: "missing capture" } });
    expect(screen.getByRole("heading", { name: "没有匹配的项目" })).toBeVisible();
    expect(screen.queryByText(projects[0].name)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(projectRows(projects).map((row) => row.getAttribute("aria-label"))).toEqual(projects.map((project) => project.name));
  });

  it("opens the native project picker from the library toolbar", () => {
    const openProject = vi.fn();
    renderHome(openProject);
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    expect(openProject).toHaveBeenCalledTimes(1);
  });

  it("keeps cached project rows actionable when refresh fails and retries in context", () => {
    const retry = vi.fn();
    function FailedRefresh() {
      const { dispatch } = useAppContext();
      useEffect(() => { dispatch({ type: "SET_RECENT_PROJECTS_ERROR", error: "catalog unavailable" }); }, [dispatch]);
      return null;
    }
    render(<AppProvider><SeedProjects /><FailedRefresh /><HomePage engines={[]} onOpenProject={vi.fn()} onRetry={retry} /></AppProvider>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("正在显示已加载的记录");
    fireEvent.click(within(alert).getByRole("button", { name: "重新加载" }));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: projects[0].name }));
    expect(screen.getByTestId("destination")).toHaveTextContent(projects[0].path);
  });

  it("keeps all fifty-five projects in recent order with full management beyond the sidebar limit", async () => {
    const records: ProjectInfo[] = Array.from({ length: 55 }, (_, index) => ({
      id: `library-${index}`, name: `完整项目库 ${index + 1}`, path: `/captures/batch-${index + 1}`,
      status: "ready", updated_at: `2026-09-${String(index % 28 + 1).padStart(2, "0")}T10:00:00Z`,
    }));
    const lastProject = records[54];
    const checkFailedProject = records[53];
    const onSelectProject = vi.fn();
    const onRevealProject = vi.fn();
    const onDeleteProject = vi.fn();
    const onRetryAvailability = vi.fn();
    const onOpenIndependent = vi.fn();
    const onRelinkProject = vi.fn(async () => ({
      kind: "mismatch" as const, candidatePath: "/captures/another-project", code: "UI-PROJECT-RELINK-MISMATCH",
    }));
    render(<AppProvider><SeedProjects records={records} health={{ [lastProject.id]: "missing", [checkFailedProject.id]: "check_failed" }} />
      <HomePage engines={[]} onOpenProject={vi.fn()} onSelectProject={onSelectProject} projectActions={{
        onRevealProject, onDeleteProject, onRetryAvailability, onRelinkProject, onOpenIndependent,
      }} /></AppProvider>);
    const rows = projectRows(records);
    expect(rows).toHaveLength(55);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(records.map((project) => project.name));
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^55$/);
    expect(screen.queryByText("等待开始")).not.toBeInTheDocument();
    expect(screen.queryByText("进度尚未获取")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /进入工作区/ })).not.toBeInTheDocument();
    fireEvent.click(rows[5]);
    fireEvent.click(rows[54]);
    expect(onSelectProject.mock.calls).toEqual([[records[5]], [lastProject]]);
    expect(screen.getByTestId("destination")).toHaveTextContent("home");

    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    await selectProjectAction(checkFailedProject, "重试检查");
    expect(onRetryAvailability).toHaveBeenCalledWith(checkFailedProject.id);
    await selectProjectAction(lastProject, "重新定位");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("原记录未更改"));
    expect(onRelinkProject).toHaveBeenCalledWith(lastProject);
    expect(screen.getByRole("button", { name: lastProject.name })).toBeInTheDocument();
    expect(onOpenIndependent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "作为独立项目打开" }));
    expect(onOpenIndependent).toHaveBeenCalledWith("/captures/another-project");

    for (const [name, handler] of [
      ["在资源管理器中显示", onRevealProject],
      ["永久删除项目", onDeleteProject],
    ] as const) {
      await selectProjectAction(lastProject, name);
      expect(handler).toHaveBeenCalledWith(lastProject);
    }
  });

  it("filters gallery projects by complete Windows path without displaying the file path", () => {
    renderHome();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索项目名称或路径" }), { target: { value: "C:\\projects" } });
    const recent = within(screen.getByRole("region", { name: "全部项目" }));
    const row = recent.getByRole("button", { name: projects[1].name });
    expect(row).toHaveTextContent(projects[1].name);
    expect(recent.queryByRole("button", { name: projects[0].name })).not.toBeInTheDocument();
    expect(row).toHaveAttribute("title", expect.stringContaining(projects[1].path));
    expect(within(row).queryByTitle(projects[1].path)).not.toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(expect.stringContaining(projects[1].path));
    fireEvent.click(row);
    expect(screen.getByTestId("destination")).toHaveTextContent(projects[1].path);
  });

  it("retains complete long macOS project metadata in gallery descriptions", () => {
    const longProject = {
      ...projects[0],
      name: "苏州古建筑测绘 · Courtyard reconstruction final high quality 2026-10-28",
      path: "/Users/test/captures/architecture/苏州古建筑测绘/final-reconstruction",
    };
    render(<AppProvider><SeedProjects records={[longProject]} /><HomePage engines={[]} onOpenProject={vi.fn()} /></AppProvider>);
    const row = within(screen.getByRole("region", { name: "全部项目" })).getByRole("button", { name: longProject.name });
    expect(within(row).getByTitle(longProject.name)).toHaveTextContent(longProject.name);
    expect(row).toHaveAttribute("title", expect.stringContaining(longProject.path));
    expect(within(row).queryByTitle(longProject.path)).not.toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(expect.stringContaining(longProject.path));
    fireEvent.click(row);
    expect(screen.getByTestId("destination")).toHaveTextContent(longProject.path);
  });

  it("renders a source-preview gallery and keeps the project picker unique in its toolbar", () => {
    renderHome();
    const library = within(screen.getByRole("region", { name: "全部项目" }));
    expect(library.getAllByRole("listitem")).toHaveLength(projects.length);
    expect(library.getAllByRole("img", { name: "暂无素材预览" })).toHaveLength(projects.length);
    expect(library.getAllByRole("button", { name: "打开项目" })).toHaveLength(1);
    expect(library.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
  });

  it("counts name and path search matches without a status filter", () => {
    renderHome();
    expect(screen.queryByRole("combobox", { name: "状态筛选" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^2$/);
    const search = screen.getByRole("textbox", { name: "搜索项目名称或路径" });
    fireEvent.change(search, { target: { value: projects[0].name } });
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^1 \/ 2$/);
    expect(projectRows(projects).map((row) => row.getAttribute("aria-label"))).toEqual([projects[0].name]);
    fireEvent.change(search, { target: { value: projects[1].path } });
    expect(projectRows(projects).map((row) => row.getAttribute("aria-label"))).toEqual([projects[1].name]);
    fireEvent.change(search, { target: { value: "不存在的场景" } });
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^0 \/ 2$/);
    expect(screen.getByRole("heading", { name: "没有匹配的项目" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(search).toHaveValue("");
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^2$/);
    expect(projectRows(projects)).toHaveLength(2);
  });

  it("keeps every lifecycle state searchable in original order without status controls", () => {
    const statuses: ProjectInfo["status"][] = [
      "creating", "starting", "ready", "running", "pausing", "paused", "cancelling", "cancelled", "recovering", "completed", "failed",
    ];
    const records = statuses.map((status) => ({
      id: `status-${status}`, name: `状态项目 ${status}`, path: `/captures/${status}`, status, updated_at: projects[0].updated_at,
    }));
    render(<AppProvider><SeedProjects records={records} /><HomePage engines={[]} onOpenProject={vi.fn()} /></AppProvider>);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(projectRows(records).map((row) => row.getAttribute("aria-label"))).toEqual(records.map((project) => project.name));
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^11$/);
    const search = screen.getByRole("textbox", { name: "搜索项目名称或路径" });
    fireEvent.change(search, { target: { value: "/captures/paused" } });
    expect(projectRows(records).map((row) => row.getAttribute("aria-label"))).toEqual(["状态项目 paused"]);
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^1 \/ 11$/);
    fireEvent.change(search, { target: { value: "不存在的场景" } });
    expect(screen.getByRole("heading", { name: "没有匹配的项目" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(projectRows(records).map((row) => row.getAttribute("aria-label"))).toEqual(records.map((project) => project.name));
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^11$/);
  });

  it("retains failed, missing and pending records while hiding their permanent status rows", () => {
    const cases: { id: string; status: ProjectInfo["status"]; health: RecentProjectAvailability["status"]; stale?: boolean }[] = [
      { id: "failed", status: "failed", health: "available" },
      { id: "paused", status: "paused", health: "available" },
      { id: "cancelled", status: "cancelled", health: "available" },
      { id: "missing", status: "ready", health: "missing" },
      { id: "unreadable", status: "completed", health: "unreadable" },
      { id: "check-failed", status: "ready", health: "check_failed" },
      { id: "unknown", status: "completed", health: "unknown" },
      { id: "checking", status: "ready", health: "checking" },
      { id: "stale", status: "ready", health: "missing", stale: true },
      { id: "healthy", status: "ready", health: "available" },
      { id: "healthy-completed", status: "completed", health: "available" },
      { id: "active", status: "running", health: "available" },
    ];
    const records = cases.map(({ id, status }) => ({
      id, name: `项目边界 ${id}`, path: `/captures/${id}`, status, updated_at: projects[0].updated_at,
    }));
    const health: Record<string, RecentProjectAvailability> = Object.fromEntries(cases.map((item, index) => [item.id, {
      status: item.health, checkedPath: item.stale ? "/captures/previous-location" : records[index].path,
      checkedAt: null, reasonCode: null, generation: 1,
    }]));
    render(<AppContext.Provider value={{ state: {
      ...initialState, recentProjects: records, recentProjectsLoading: false, projectAvailability: health,
    }, dispatch: vi.fn() }}><HomePage engines={[]} onOpenProject={vi.fn()} /></AppContext.Provider>);

    expect(projectRows(records).map((row) => row.getAttribute("aria-label"))).toEqual(records.map((project) => project.name));
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^12$/);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    for (const label of ["已完成", "失败", "路径已丢失", "项目数据无法读取", "暂时无法检查", "正在检查路径"]) {
      expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目边界 missing" })).toHaveAccessibleDescription(expect.stringContaining("路径已丢失"));
    expect(screen.getByRole("button", { name: "项目边界 stale" })).not.toHaveAccessibleDescription(expect.stringContaining("路径已丢失"));
  });

  it("retries path checks through the menu and retains the project during and after repair", async () => {
    const project: ProjectInfo = { ...projects[0], id: "retry-project", status: "ready" };
    const records = [project];
    const health = { [project.id]: "check_failed" as const };
    const retryRequested = vi.fn();
    let completeCheck!: () => void;
    const pendingCheck = new Promise<void>((resolve) => { completeCheck = resolve; });
    function RetryingHome() {
      const { dispatch } = useAppContext();
      return <HomePage engines={[]} onOpenProject={vi.fn()} projectActions={{
        onRetryAvailability: (projectId) => {
          retryRequested(projectId);
          dispatch({ type: "BEGIN_PROJECT_AVAILABILITY", projectId, projectPath: project.path, generation: 2 });
          return pendingCheck.then(() => {
            dispatch({ type: "SET_PROJECT_AVAILABILITY", generation: 2, result: {
              project_id: projectId, checked_path: project.path, availability: "available",
              checked_at: "2026-10-29T08:05:00Z", reason_code: null, refreshed_project: null,
            } });
          });
        },
      }} />;
    }
    render(<AppProvider><SeedProjects records={records} health={health} /><RetryingHome /></AppProvider>);
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    const trigger = await selectProjectAction(project, "重试检查");
    expect(retryRequested).toHaveBeenCalledWith(project.id);
    const row = screen.getByRole("button", { name: project.name });
    expect(row.closest('[role="listitem"]')).toHaveAttribute("aria-busy", "true");
    expect(row).toHaveAccessibleDescription(expect.stringContaining("正在检查路径"));
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^1$/);
    await waitFor(() => expect(trigger).toHaveFocus());

    await act(async () => { completeCheck(); await pendingCheck; });
    expect(screen.getByRole("button", { name: project.name })).toBe(row);
    expect(row).toHaveAccessibleDescription(expect.stringContaining("路径可用"));
    expect(screen.queryByRole("button", { name: "重试检查" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新定位" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "没有匹配的项目" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("本机项目记录")).toHaveTextContent(/^1$/);
    fireEvent.click(row);
    expect(screen.getByTestId("destination")).toHaveTextContent(project.path);
  });

  it("shows an actionable engine issue only when a checked component is unavailable", () => {
    const openSettings = vi.fn();
    const view = render(<AppProvider><HomePage engines={[engine]} onOpenProject={vi.fn()} onOpenSettings={openSettings} /></AppProvider>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(<AppProvider><HomePage engines={[{ ...engine, available: false }]} onOpenProject={vi.fn()} onOpenSettings={openSettings} /></AppProvider>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("部分引擎需要处理 · ffmpeg");
    fireEvent.click(within(alert).getByRole("button", { name: "打开设置" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps one creation action when the library is empty", () => {
    render(<AppProvider><SeedProjects records={[]} /><HomePage engines={[]} onOpenProject={vi.fn()} /></AppProvider>);
    expect(screen.getByRole("heading", { name: "创建你的第一个场景" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "新建项目" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    expect(screen.getByTestId("destination")).toHaveTextContent("new-project");
  });
});
