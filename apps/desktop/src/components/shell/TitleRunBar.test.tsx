import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TitleRunBar } from "./TitleRunBar";

const project = { id: "p", name: "自行车街景测试", path: "p", status: "running" as const, updated_at: "2026-07-14" };
const state = { stages: {}, current_stage: null, overall_progress: 0.58 };

describe("TitleRunBar", () => {
  it("does not expose project progress or run controls without a project context", () => {
    render(
      <TitleRunBar
        project={null}
        pipelineSnapshot={null}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onRevealProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开始重建|暂停|继续/ })).not.toBeInTheDocument();
  });

  it("shows unknown progress without fabricating an ETA", () => {
    render(
      <TitleRunBar
        project={{ ...project, status: "running" }}
        pipelineSnapshot={null}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onRevealProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("正在估算")).toBeInTheDocument();
    expect(screen.queryByText(/约 \d+ (分钟|小时)/)).not.toBeInTheDocument();
    expect(screen.queryByText("预计剩余")).not.toBeInTheDocument();
  });

  it("describes an active-project conflict and preserves focus after a blocked attempt", () => {
    const start = vi.fn();
    const blocked = vi.fn();
    render(
      <TitleRunBar
        project={{ ...project, id: "project-b", name: "项目 B", status: "ready" }}
        pipelineSnapshot={null}
        pipelineConflict={{
          activeProjectId: "project-a",
          activeProjectName: "项目 A",
          status: "running",
          stageLabel: "模型训练",
          progress: 0.42,
          updatedAt: Date.now(),
        }}
        onBlockedAttempt={blocked}
        onStart={start}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onRevealProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );

    const startButton = screen.getByRole("button", { name: "开始重建" });
    startButton.focus();
    fireEvent.click(startButton);

    expect(start).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledOnce();
    expect(startButton).toHaveFocus();
    expect(startButton).toHaveAttribute("aria-describedby");
    expect(screen.getByRole("alert")).toHaveTextContent("当前有重建任务尚未结束");
    expect(screen.queryByText(/项目 A.*正在运行/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回活动项目" })).not.toBeInTheDocument();
  });

  it("routes running and paused states to the correct controls", () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const props = { project, onStart: vi.fn(), onPause: pause, onResume: resume, onCancel: vi.fn(), onRevealProject: vi.fn(), onRemoveProject: vi.fn(), onDeleteProject: vi.fn() };
    const { rerender } = render(<TitleRunBar {...props} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "running", state, sequence: 1, accepted_at: null, started_at: null, control_intent: "none" }} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledOnce();
    rerender(<TitleRunBar {...props} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "paused", state, sequence: 2, accepted_at: null, started_at: null, control_intent: "none" }} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(resume).toHaveBeenCalledOnce();
  });

  it("blocks repeated controls while cancellation is in progress", () => {
    const cancel = vi.fn();
    render(<TitleRunBar project={project} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "cancelling", state, sequence: 3, accepted_at: null, started_at: null, control_intent: "cancel" }} onStart={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={cancel} onRevealProject={vi.fn()} onRemoveProject={vi.fn()} onDeleteProject={vi.fn()} />);
    const cancelling = screen.getByRole("button", { name: "正在取消…" });
    expect(cancelling).toBeDisabled();
    fireEvent.click(cancelling);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("provides the complete keyboard menu contract and restores its trigger", async () => {
    render(
      <TitleRunBar
        project={{ ...project, status: "ready" }}
        pipelineSnapshot={null}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onRevealProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "操作" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("menuitem", { name: /在资源管理器中显示/ });
    await waitFor(() => expect(first).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("menu").id);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "从最近项目移除" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "从最近项目移除" }), { key: "End" });
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

  it("skips disabled destructive items while a project is running", async () => {
    render(<TitleRunBar project={project} pipelineSnapshot={null} onStart={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onRevealProject={vi.fn()} onRemoveProject={vi.fn()} onDeleteProject={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "操作" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /在资源管理器中显示/ })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: /永久删除项目/ })).toBeDisabled();
  });
});
