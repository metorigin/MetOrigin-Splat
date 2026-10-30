import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setLanguagePreference, t } from "./i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useState } from "react";

import type { PipelineSnapshot, ProjectInfo } from "./types";
import App from "./App";
import * as modelEditor from "./hooks/useModelEditor";
import { selectProjectDirectory } from "./services/desktop";

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
const wizardCommitted = vi.hoisted(() => vi.fn());

vi.mock("./services/desktop", () => ({
  desktopApi: api,
  isDesktopRuntime: () => false,
  selectProjectDirectory: vi.fn(),
  confirmSafeCancel: vi.fn(),
  isActivePipelineConflict: api.isActivePipelineConflict,
}));

vi.mock("./pages/HomePage", async () => {
  const { useAppContext } = await import("./context");
  return {
    HomePage: ({ titleInWindowHeader, onOpenProject, onSelectProject }: {
      titleInWindowHeader?: boolean;
      onOpenProject: () => void;
      onSelectProject: (project: ProjectInfo) => void;
    }) => {
      const { state, dispatch } = useAppContext();
      return <div data-testid="page">
      {!titleInWindowHeader ? <h1>{t("项目中心")}</h1> : null}
      项目中心内容
      <button onClick={onOpenProject}>{t("打开项目")}</button>
      <button onClick={() => dispatch({ type: "NAVIGATE", page: { type: "new-project" } })}>{t("新建项目")}</button>
      {state.recentProjects.map((project) => <button key={project.id} onClick={() => onSelectProject(project)}>{project.name}</button>)}
      <input aria-label="首页输入框" />
      <textarea aria-label="首页多行输入" />
      <select aria-label="首页选择框"><option>默认</option></select>
      <div contentEditable aria-label="首页可编辑区域" />
      <div role="textbox" tabIndex={0} aria-label="ARIA 编辑器" />
    </div>;
    },
  };
});

vi.mock("./pages/NewProjectPage", async () => {
  const { useAppContext } = await import("./context");
  return {
    NewProjectPage: () => {
      const { dispatch } = useAppContext();
      useLayoutEffect(() => { wizardCommitted(); }, []);
      return (
        <div data-testid="page">
          <span>创建新项目</span>
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
  };
});

vi.mock("./pages/ProjectDetailPage", async () => {
  const { useAppContext } = await import("./context");
  return {
    ProjectDetailPage: ({ projectId, projectPath }: { projectId: string; projectPath: string }) => {
      const { state, dispatch } = useAppContext();
      const [initialPath] = useState(projectPath);
      const snapshot = state.pipelineSnapshots[projectId];
      return <div data-testid="page" data-initial-path={initialPath}>工作台 {projectId} {snapshot?.project_id}
        <button onClick={() => dispatch({ type: "NAVIGATE", page: { type: "project-detail", projectId, projectPath: `${projectPath}-relocated` } })}>模拟重定位同一项目</button>
      </div>;
    },
  };
});

describe("App workspace contexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wizardCommitted.mockReset();
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

  it("fully hides the sidebar and restores its width without remounting page content", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });
    const page = screen.getByTestId("page");
    const input = screen.getByRole("textbox", { name: "首页输入框" });
    fireEvent.change(input, { target: { value: "keep this draft" } });
    fireEvent.keyDown(screen.getByRole("separator", { name: "调整项目栏宽度" }), { key: "End" });
    expect(document.querySelector('[data-sidebar="sidebar"]')).toHaveStyle({ width: "320px" });

    fireEvent.click(screen.getByRole("button", { name: "折叠项目栏" }));

    expect(document.querySelector('[data-sidebar="sidebar"]')).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整项目栏宽度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置与引擎" })).not.toBeInTheDocument();
    const reopen = screen.getByRole("button", { name: "展开项目栏" });
    expect(reopen).toHaveAttribute("aria-expanded", "false");
    expect(reopen.closest('[data-window-region="navigation"]')).toHaveStyle({ width: "auto" });
    expect(screen.getByTestId("page")).toBe(page);
    expect(input).toHaveValue("keep this draft");

    fireEvent.click(reopen);

    expect(document.querySelector('[data-sidebar="sidebar"]')).toHaveStyle({ width: "320px" });
    expect(screen.getByTestId("page")).toBe(page);
    expect(input).toHaveValue("keep this draft");
    expect(api.startPipeline).not.toHaveBeenCalled();
  });

  it("returns focus to the titlebar after compact drawer settings close", async () => {
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string): MediaQueryList => ({
        matches: query === "(max-width: 1120px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<App />);
      await screen.findByRole("heading", { name: "项目中心" });
      const opener = screen.getByRole("button", { name: "打开项目导航" });
      opener.focus();
      fireEvent.click(opener);
      const drawer = screen.getByRole("dialog", { name: "项目导航" });
      const settings = within(drawer).getByRole("button", { name: "设置与引擎" });
      settings.focus();
      fireEvent.click(settings);

      expect(screen.queryByRole("dialog", { name: "项目导航" })).not.toBeInTheDocument();
      const closeSettings = screen.getByRole("button", { name: "关闭设置" });
      await waitFor(() => expect(closeSettings).toHaveFocus());
      // Let the old drawer's deferred opener restoration settle before closing settings.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(closeSettings).toHaveFocus();
      fireEvent.click(closeSettings);

      expect(screen.queryByRole("dialog", { name: "应用设置" })).not.toBeInTheDocument();
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      view?.unmount();
      if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
      else Reflect.deleteProperty(window, "matchMedia");
      if (resizeObserverDescriptor) Object.defineProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("guards sidebar navigation with editor leave and keeps wizard navigation inside its own exit flow", async () => {
    const leave = vi.fn().mockResolvedValue(true);
    const editorMock = vi.spyOn(modelEditor, "useModelEditor").mockReturnValue({
      session: null, editorRef: { current: null }, opening: false, open: vi.fn(), leave,
    });
    try {
      render(<App />);
      await screen.findByRole("heading", { name: "项目中心" });
      fireEvent.click(await screen.findByRole("button", { name: projectA.name }));
      await screen.findByRole("heading", { name: projectA.name });
      leave.mockClear();

      leave.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
      await waitFor(() => expect(leave).toHaveBeenCalledOnce());
      expect(screen.getByRole("heading", { name: projectA.name })).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
      await screen.findByRole("heading", { name: "项目中心" });
      expect(leave).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: projectA.name }));
      await screen.findByRole("heading", { name: projectA.name });
      expect(api.startPipeline).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
      await screen.findByRole("heading", { name: "项目中心" });
      fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
      await screen.findByRole("heading", { name: "创建新项目" });
      const home = screen.getByRole("button", { name: "项目中心" });
      expect(home).toBeDisabled();
      expect(screen.queryByRole("button", { name: projectA.name })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "折叠项目栏" })).toBeDisabled();
      const leaveCalls = leave.mock.calls.length;
      expect(screen.getByRole("heading", { name: "创建新项目" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "退出创建" }));
      await screen.findByRole("heading", { name: "项目中心" });
      expect(leave).toHaveBeenCalledTimes(leaveCalls);
      fireEvent.click(screen.getByRole("button", { name: projectA.name }));
      await screen.findByRole("heading", { name: projectA.name });
    } finally {
      editorMock.mockRestore();
    }
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

  it("replaces workspace request ownership when the same project moves, while language changes preserve it", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });
    fireEvent.click(await screen.findByRole("button", { name: projectA.name }));
    await screen.findByRole("heading", { name: projectA.name });
    const previous = await screen.findByTestId("page");
    expect(previous).toHaveAttribute("data-initial-path", projectA.path);
    fireEvent.click(screen.getByRole("button", { name: "模拟重定位同一项目" }));
    await waitFor(() => expect(screen.getByTestId("page")).toHaveAttribute("data-initial-path", `${projectA.path}-relocated`));
    const relocated = screen.getByTestId("page");
    expect(relocated).not.toBe(previous);
    act(() => setLanguagePreference("en"));
    expect(screen.getByTestId("page")).toBe(relocated);
    act(() => setLanguagePreference("zh-CN"));
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
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("project-a project-a"));
  });

  it("keeps A isolated while viewing B and blocks B without cancelling or queuing", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });

    fireEvent.click(await screen.findByRole("button", { name: projectB.name }));
    expect(await screen.findByRole("heading", { name: projectB.name })).toBeInTheDocument();
    expect(screen.queryByText(/活动项目 A.*正在运行/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("project-b project-b"));

    const start = screen.getByRole("button", { name: "开始重建" });
    start.focus();
    fireEvent.click(start);
    expect(api.startPipeline).not.toHaveBeenCalled();
    expect(start).toHaveFocus();

    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
    await screen.findByRole("heading", { name: "项目中心" });
    fireEvent.click(await screen.findByRole("button", { name: projectA.name }));
    await waitFor(() => expect(screen.getByRole("heading", { name: projectA.name })).toBeInTheDocument());
  });

  it("keeps newly created B valid but unqueued and allows navigation through the project hub", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "项目中心" });
    fireEvent.click(screen.getAllByRole("button", { name: /新建项目/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "模拟创建并开始 B" }));

    expect(await screen.findByRole("heading", { name: projectB.name })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("未启动，也未进入队列");
    expect(api.startPipeline).not.toHaveBeenCalled();

    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
    await screen.findByRole("heading", { name: "项目中心" });
    fireEvent.click(await screen.findByRole("button", { name: projectA.name }));
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

    fireEvent.click(await screen.findByRole("button", { name: projectB.name }));
    const start = await screen.findByRole("button", { name: "开始重建" });
    start.focus();
    fireEvent.click(start);

    await waitFor(() => expect(api.startPipeline).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前有重建任务尚未结束");
    expect(start).toHaveFocus();
  });

  it("uses Command on macOS while retaining input and IME guards", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<App />);
      await screen.findByText("项目中心内容");
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      fireEvent.keyDown(window, { key: "n", metaKey: true, isComposing: true });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "首页输入框" }), { key: "n", metaKey: true });
      expect(screen.getByText("项目中心内容")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      expect(await screen.findByText("创建向导内容")).toBeInTheDocument();
    } finally {
      platform.mockRestore();
    }
  });

  it("keeps global open/new shortcuts from bypassing the active creation wizard", async () => {
    // Dispatch at commit time, before App's passive effects can replace its home listener.
    wizardCommitted.mockImplementationOnce(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    render(<App />);
    await screen.findByText("项目中心内容");
    expect(selectProjectDirectory).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await screen.findByText("创建向导内容");
    expect(wizardCommitted).toHaveBeenCalledOnce();
    expect(selectProjectDirectory).not.toHaveBeenCalled();
    const wizard = screen.getByTestId("page");
    const open = new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(window, open);
    expect(selectProjectDirectory).not.toHaveBeenCalled();
    expect(open.defaultPrevented).toBe(true);
    const create = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(window, create);
    expect(create.defaultPrevented).toBe(true);
    expect(screen.getByTestId("page")).toBe(wizard);
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
