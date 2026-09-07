import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopCommandError, desktopApi } from "../../services/desktop";
import type { ActionImpactPreview, ActionReceipt, WorkspaceActionRequest } from "../../types";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

const request: WorkspaceActionRequest = {
  projectId: "project-a",
  projectPath: "D:\\projects\\project-a",
  action: "cancel",
};

function preview(token: string, label = "current pipeline"): ActionImpactPreview {
  return {
    action: "cancel",
    targetLabel: label,
    allowed: true,
    blockedReason: null,
    irreversible: false,
    preserved: ["kept artifact"],
    invalidated: ["temporary output"],
    regenerated: [],
    warnings: [],
    sizeBytes: null,
    previewToken: token,
    createdAt: "2026-08-14T00:00:00Z",
    expiresAt: "2026-08-14T00:10:00Z",
  };
}

function receipt(): ActionReceipt {
  return {
    id: "receipt-1",
    action: "cancel",
    status: "success",
    title: "Action completed",
    message: "The confirmed action completed.",
    completedAt: "2026-08-14T00:01:00Z",
    affectedResources: ["pipeline"],
    dismissible: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("WorkspaceActionDialog", () => {
  beforeEach(() => {
    vi.spyOn(desktopApi, "previewWorkspaceAction").mockResolvedValue(preview("token-1"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("focuses the safe cancel action and submits a token only once while busy", async () => {
    const pending = deferred<{ kind: "completed"; receipt: ActionReceipt }>();
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction").mockReturnValue(pending.promise);
    render(<WorkspaceActionDialog request={request} onClose={vi.fn()} />);

    const dialog = await screen.findByRole("alertdialog");
    await screen.findByText("kept artifact");
    const buttons = within(dialog).getAllByRole("button");
    await waitFor(() => expect(buttons[0]).toHaveFocus());
    const confirmButton = buttons[buttons.length - 1];

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("token-1");

    pending.resolve({ kind: "completed", receipt: receipt() });
    expect(await screen.findByText("The confirmed action completed.")).toBeVisible();
  });

  it("keeps the dialog open, focuses the updated alert, and requires explicit reconfirmation after stale", async () => {
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction")
      .mockResolvedValueOnce({
        kind: "stale",
        code: "UI-ACTION-PREVIEW-STALE",
        message: "State changed; nothing was executed.",
        preview: preview("token-2", "updated pipeline"),
      })
      .mockResolvedValueOnce({ kind: "completed", receipt: receipt() });
    render(<WorkspaceActionDialog request={request} onClose={vi.fn()} />);

    const dialog = await screen.findByRole("alertdialog");
    await screen.findByText("kept artifact");
    let buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);

    expect(await screen.findByText("updated pipeline")).toBeVisible();
    const alert = within(dialog).getByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("The confirmed action completed.")).not.toBeInTheDocument();

    buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByText("The confirmed action completed.");
    expect(execute).toHaveBeenNthCalledWith(2, "token-2");
  });

  it("retains the expired preview as disabled reference when refresh fails and exposes retry", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction)
      .mockResolvedValueOnce(preview("token-1"))
      .mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(desktopApi, "executeWorkspaceAction").mockRejectedValue(
      new DesktopCommandError("execute_workspace_action", JSON.stringify({
        code: "UI-ACTION-PREVIEW-EXPIRED",
        message: "Expired; nothing was executed.",
        retryable: false,
      })),
    );
    render(<WorkspaceActionDialog request={request} onClose={vi.fn()} />);

    const dialog = await screen.findByRole("alertdialog");
    await screen.findByText("kept artifact");
    const buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);

    await screen.findByText("UI-UNKNOWN-COMMAND");
    expect(screen.getByText("kept artifact")).toBeVisible();
    expect(dialog.querySelector<HTMLButtonElement>(".button-warning")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "重新读取影响说明" })).toBeEnabled();
  });
});
