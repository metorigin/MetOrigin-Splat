import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLanguagePreference } from "./i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineSnapshot, ProjectInfo } from "./types";
import App from "./App";

const projectA: ProjectInfo = {
  id: "project-a",
  name: "活动项目 A",
  path: "D:\\projects\\a",
  status: "running",
  updated_at: "2026-08-14T08:00:00Z",
  stage_label: "BrushTraining",
};

const projectB: ProjectInfo = {
  id: "project-b",
  name: "待运行项目 B",
  path: "D:\\projects\\b",
  status: "ready",
  updated_at: "2026-08-14T07:00:00Z",
};

const activeSnapshot: PipelineSnapshot = {
  project_id: projectA.id,
  project_path: projectA.path,
  status: "running",
  state: { stages: {}, current_stage: "BrushTraining", overall_progress: 0.42 },
  sequence: 12,
  accepted_at: "2026-08-14T08:00:00Z",
  started_at: "2026-08-14T08:00:01Z",
  control_intent: "none",
};

const readySnapshot: PipelineSnapshot = {
  project_id: projectB.id,
  project_path: projectB.path,
  status: "ready",
  state: { stages: {}, current_stage: null, overall_progress: 0 },
  sequence: 0,
  accepted_at: null,
  started_at: null,
  control_intent: "none",
};

const api = vi.hoisted(() => ({
  appVersion: vi.fn(),
  checkEngines: vi.fn(),
  listRecentProjects: vi.fn(),
  listRecentProjectIndex: vi.fn(),
  checkRecentProjectAvailability: vi.fn(),
  getAppSettings: vi.fn(),
  getResourceMetrics: vi.fn(),
  getActivePipelineSummary: vi.fn(),
  getPipelineState: vi.fn(),
  startPipeline: vi.fn(),
  isActivePipelineConflict: vi.fn(),
}));

vi.mock("./services/desktop", () => ({
  desktopApi: api,
  isDesktopRuntime: () => false,
  selectProjectDirectory: vi.fn(),
  confirmSafeCancel: vi.fn(),
  confirmRemoveRecentProject: vi.fn(),
  isActivePipelineConflict: api.isActivePipelineConflict,
}));

vi.mock("./pages", async () => {
  const { useAppContext } = await import("./context");
  return {
    HomePage: () => <div data-testid="page">
      项目中心内容
      <input aria-label="首页输入框" />
      <textarea aria-label="首页多行输入" />
      <select aria-label="首页选择框"><option>默认</option></select>
      <div contentEditable aria-label="首页可编辑区域" />
      <div role="textbox" tabIndex={0} aria-label="ARIA 编辑器" />
    </div>,
    NewProjectPage: () => {
      const { dispatch } = useAppContext();
      return (
        <div data-testid="page">
          <h1>创建新项目</h1>
          创建向导内容
          <button type="button" onClick={() => dispatch({ type: "NAVIGATE", page: { type: "home" } })}>退出创建</button>
          <button
            type="button"
            onClick={() => {
              dispatch({
                type: "ADD_RECENT_PROJECT",
                project: {
                  id: "project-b",
                  name: "待运行项目 B",
                  path: "D:\\projects\\b",
                  status: "ready",
                  updated_at: "2026-08-14T09:00:00Z",
                },
              });
              dispatch({
                type: "SET_PIPELINE_CONFLICT",
                requestedProjectId: "project-b",
                activeProjectId: "project-a",
              });
              dispatch({
                type: "NAVIGATE",
                page: { type: "project-detail", projectId: "project-b", projectPath: "D:\\projects\\b" },
              });
              dispatch({
                type: "SET_ERROR",
                error: "项目已创建；活动项目 A 仍在运行，B 未启动，也未进入队列。",
              });
            }}
          >
            模拟创建并开始 B
          </button>
        </div>
      );
    },
    ProjectDetailPage: ({ projectId }: { projectId: string }) => {
      const { state } = useAppContext();
      const snapshot = state.pipelineSnapshots[projectId];
      return <div data-testid="page">工作台 {projectId} {snapshot?.project_id}</div>;
    },
  };
});

describe("App workspace contexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.appVersion.mockResolvedValue("0.1.0");
    api.checkEngines.mockResolvedValue([]);
    api.listRecentProjects.mockResolvedValue([projectA, projectB]);
    api.listRecentProjectIndex.mockResolvedValue([projectA, projectB]);
    api.checkRecentProjectAvailability.mockImplementation(async (projectId: string, projectPath: string) => ({
      project_id: projectId,
      project_path: projectPath,
      availability: "available",
      checked_at: "2026-08-14T08:05:00Z",
    }));
    api.getAppSettings.mockResolvedValue(null);
    api.getResourceMetrics.mockResolvedValue(null);
    api.getActivePipelineSummary.mockResolvedValue(activeSnapshot);
    api.getPipelineState.mockImplementation(async (path?: string) =>
      path === projectB.path ? readySnapshot : activeSnapshot,
    );
    api.isActivePipelineConflict.mockReturnValue(false);
  });

  it("changes workspace language without resetting input or restarting the active pipeline", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });
    await waitFor(() => expect(api.getActivePipelineSummary).toHaveBeenCalled());
    const input = screen.getByRole("textbox", { name: "首页输入框" });
    fireEvent.change(input, { target: { value: "保留中文输入" } });
    const settingsReads = api.getAppSettings.mock.calls.length;
    act(() => setLanguagePreference("en"));
    expect(screen.getByRole("heading", { name: "Project Hub" })).toBeVisible();
    expect(input).toHaveValue("保留中文输入");
    expect(screen.getByRole("textbox", { name: "首页输入框" })).toBe(input);
    expect(api.getAppSettings).toHaveBeenCalledTimes(settingsReads);
    expect(api.startPipeline).not.toHaveBeenCalled();
    act(() => setLanguagePreference("zh-CN"));
    expect(screen.getByRole("heading", { name: "项目中心" })).toBeVisible();
  });

  it("renders distinct home, wizard, and workspace contexts without leaking run controls", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "项目中心" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /新建项目/ })[0]);
    expect(await screen.findByRole("heading", { name: "创建新项目" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始重建" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出创建" }));
    fireEvent.click(await screen.findByRole("button", { name: projectA.name }));
    expect(await screen.findByRole("heading", { name: projectA.name })).toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveTextContent("project-a project-a");
  });

  it("keeps A isolated while viewing B and blocks B without cancelling or queuing", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });

    const projectBButtons = await screen.findAllByRole("button", { name: new RegExp(projectB.name) });
    fireEvent.click(projectBButtons.find((button) => !button.getAttribute("aria-label")) ?? projectBButtons[0]);
    expect(await screen.findByRole("heading", { name: projectB.name })).toBeInTheDocument();
    expect(screen.queryByText(/活动项目 A.*正在运行/)).not.toBeInTheDocument();
    expect(screen.getByTestId("page")).toHaveTextContent("project-b project-b");

    const start = screen.getByRole("button", { name: "开始重建" });
    start.focus();
    fireEvent.click(start);
    expect(api.startPipeline).not.toHaveBeenCalled();
    expect(start).toHaveFocus();

    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: projectA.name }));
    await waitFor(() => expect(screen.getByRole("heading", { name: projectA.name })).toBeInTheDocument());
  });

  it("keeps newly created B valid but unqueued and allows navigation through recent projects", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });
    fireEvent.click(screen.getAllByRole("button", { name: /新建项目/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "模拟创建并开始 B" }));

    expect(await screen.findByRole("heading", { name: projectB.name })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("未启动，也未进入队列");
    expect(api.startPipeline).not.toHaveBeenCalled();

    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: projectA.name }));
    await waitFor(() => expect(screen.getByRole("heading", { name: projectA.name })).toBeInTheDocument());
  });

  it("normalizes a backend start race into the same active-project blocker", async () => {
    api.getActivePipelineSummary
      .mockResolvedValueOnce(null)
      .mockResolvedValue(activeSnapshot);
    api.isActivePipelineConflict.mockReturnValue(true);
    api.startPipeline.mockRejectedValue({ code: "UI-PIPELINE-ACTIVE-CONFLICT" });
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });

    const projectBButtons = await screen.findAllByRole("button", { name: new RegExp(projectB.name) });
    fireEvent.click(projectBButtons.find((button) => !button.getAttribute("aria-label")) ?? projectBButtons[0]);
    const start = await screen.findByRole("button", { name: "开始重建" });
    start.focus();
    fireEvent.click(start);

    await waitFor(() => expect(api.startPipeline).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前有重建任务尚未结束");
    expect(start).toHaveFocus();
  });

  it("ignores global navigation shortcuts from editors, IME, prevented events, and overlays", async () => {
    render(<App />);
    await screen.findByText("项目中心内容");
    const editableTargets = [
      screen.getByRole("textbox", { name: "首页输入框" }),
      screen.getByRole("textbox", { name: "首页多行输入" }),
      screen.getByRole("combobox", { name: "首页选择框" }),
      screen.getByLabelText("首页可编辑区域"),
      screen.getByRole("textbox", { name: "ARIA 编辑器" }),
    ];
    for (const target of editableTargets) {
      fireEvent.keyDown(target, { key: "n", ctrlKey: true });
      expect(screen.getByText("项目中心内容")).toBeInTheDocument();
    }

    fireEvent.keyDown(window, { key: "n", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, keyCode: 229 });
    const prevented = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(screen.getByText("项目中心内容")).toBeInTheDocument();

    const overlay = document.createElement("div");
    overlay.dataset.keyboardOverlay = "true";
    document.body.appendChild(overlay);
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(screen.getByText("项目中心内容")).toBeInTheDocument();
    overlay.remove();

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(await screen.findByText("创建向导内容")).toBeInTheDocument();
  });
});
