import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CheckpointSummary } from "../../types";
import { CheckpointDrawer } from "./CheckpointDrawer";

const checkpoint: CheckpointSummary = {
  iteration: 500,
  relative_path: "checkpoints/500.ply",
  size_bytes: 1024,
  created_at: "2026-08-14T08:00:00Z",
  vertex_count: 1000,
  valid: true,
  current: false,
  brush_version: "0.2.0",
};

function drawer(onClose: () => void = vi.fn()) {
  return (
    <CheckpointDrawer
      checkpoints={[checkpoint]}
      onClose={onClose}
      onPreview={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onOpen={vi.fn()}
    />
  );
}

describe("CheckpointDrawer", () => {
  it("focuses Close and traps Tab in both directions", () => {
    render(drawer());
    const close = screen.getByRole("button", { name: "关闭 Checkpoint 管理器" });
    const remove = screen.getByRole("button", { name: "删除" });
    expect(close).toHaveFocus();
    remove.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(remove).toHaveFocus();
  });

  it("restores the real opener after Escape", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>管理 Checkpoint</button>{open ? drawer(() => setOpen(false)) : null}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "管理 Checkpoint" });
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole("dialog", { name: "Checkpoint 管理器" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Checkpoint 管理器" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
