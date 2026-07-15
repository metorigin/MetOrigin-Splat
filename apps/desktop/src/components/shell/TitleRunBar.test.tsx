import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TitleRunBar } from "./TitleRunBar";

const project = { id: "p", name: "自行车街景测试", path: "p", status: "running" as const, updated_at: "2026-07-14" };
const state = { stages: {}, current_stage: null, overall_progress: 0.58 };

describe("TitleRunBar", () => {
  it("routes running and paused states to the correct controls", () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const props = { project, onStart: vi.fn(), onPause: pause, onResume: resume, onCancel: vi.fn(), onOpenSettings: vi.fn(), onRevealProject: vi.fn(), onRemoveProject: vi.fn(), onDeleteProject: vi.fn() };
    const { rerender } = render(<TitleRunBar {...props} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "running", state, sequence: 1, accepted_at: null, started_at: null, control_intent: "none" }} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledOnce();
    rerender(<TitleRunBar {...props} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "paused", state, sequence: 2, accepted_at: null, started_at: null, control_intent: "none" }} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(resume).toHaveBeenCalledOnce();
  });

  it("blocks repeated controls while cancellation is in progress", () => {
    const cancel = vi.fn();
    render(<TitleRunBar project={project} pipelineSnapshot={{ project_id: "p", project_path: "p", status: "cancelling", state, sequence: 3, accepted_at: null, started_at: null, control_intent: "cancel" }} onStart={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={cancel} onOpenSettings={vi.fn()} onRevealProject={vi.fn()} onRemoveProject={vi.fn()} onDeleteProject={vi.fn()} />);
    const cancelling = screen.getByRole("button", { name: "正在取消…" });
    expect(cancelling).toBeDisabled();
    fireEvent.click(cancelling);
    expect(cancel).not.toHaveBeenCalled();
  });
});
