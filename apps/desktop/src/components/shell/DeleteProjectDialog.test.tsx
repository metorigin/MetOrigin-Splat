import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeleteProjectDialog } from "./DeleteProjectDialog";

const project = {
  id: "project-1",
  name: "自行车",
  path: "D:\\projects\\自行车.splat-project",
  status: "ready" as const,
  updated_at: "2026-07-14T00:00:00Z",
};

describe("DeleteProjectDialog", () => {
  it("uses a warning-only confirmation and defaults focus to cancel", () => {
    const onConfirm = vi.fn();
    render(<DeleteProjectDialog project={project} busy={false} onCancel={vi.fn()} onConfirm={onConfirm} />);
    const deleteButton = screen.getByRole("button", { name: "永久删除" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape unless deletion is busy", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<DeleteProjectDialog project={project} busy={false} onCancel={onCancel} onConfirm={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<DeleteProjectDialog project={project} busy onCancel={onCancel} onConfirm={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate deletion while busy", () => {
    const view = render(<DeleteProjectDialog project={project} busy onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(within(view.container).getByRole("button", { name: "正在删除…" })).toBeDisabled();
    expect(within(view.container).getByRole("button", { name: "取消" })).toBeDisabled();
  });
});
