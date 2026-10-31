import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const deleteProject: WorkspaceActionRequest = { ...request, action: "delete_project" };

function deletionPreview(irreversible: boolean, token = "delete-token"): ActionImpactPreview {
  return {
    ...preview(token, "unparsed server label"), action: "delete_project", irreversible,
    sizeBytes: 1024 ** 3,
    warnings: ["repeated deletion warning"],
    regenerated: ["regenerated artifact"],
  };
}

describe("WorkspaceActionDialog", () => {
  beforeEach(() => {
    vi.spyOn(desktopApi, "previewWorkspaceAction").mockResolvedValue(preview("token-1"));
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    [true, "确认永久删除项目“自行车街景”吗？"],
    [false, "确认删除项目“自行车街景”的记录吗？"],
  ] as const)("uses one question and safe actions for project deletion (permanent=%s)", async (irreversible, question) => {
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue(deletionPreview(irreversible));
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction");
    const onClose = vi.fn();
    render(<WorkspaceActionDialog request={deleteProject} projectName="自行车街景" onClose={onClose} />);
    const dialog = await screen.findByRole("alertdialog", { name: question });
    expect(within(dialog).getByRole("heading", { name: question })).toBeVisible();
    expect(dialog).toHaveClass("w-[min(420px,calc(100vw-2rem))]");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["取消", "删除"]);
    expect(dialog).not.toHaveTextContent(/unparsed server label|kept artifact|temporary output|regenerated artifact|repeated deletion warning|GiB|不可撤销|涉及约/);
    expect(dialog.querySelector(".impact-preview")).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus());
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a generic project question when no display name is provided", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue(deletionPreview(true));
    render(<WorkspaceActionDialog request={deleteProject} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认永久删除这个项目吗？" });
    expect(dialog).not.toHaveTextContent("unparsed server label");
  });

  it("confirms only the requested checkpoint and guards duplicate deletion while pending", async () => {
    const checkpointRequest: WorkspaceActionRequest = { ...request, action: "delete_checkpoint", checkpointIteration: 1500 };
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue({ ...deletionPreview(true), action: "delete_checkpoint" });
    const pending = deferred<{ kind: "completed"; receipt: ActionReceipt }>();
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction").mockReturnValue(pending.promise);
    const onCompleted = vi.fn();
    render(<WorkspaceActionDialog request={checkpointRequest} onClose={vi.fn()} onCompleted={onCompleted} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除恢复点 1500 吗？" });
    const confirm = within(dialog).getByRole("button", { name: "删除" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("delete-token");
    expect(within(dialog).getByRole("button", { name: "正在删除…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => pending.resolve({ kind: "completed", receipt: { ...receipt(), action: "delete_checkpoint" } }));
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("retains blocked deletion feedback without enabling a forbidden action", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue({
      ...deletionPreview(false), allowed: false, blockedReason: "项目仍在处理中",
    });
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction");
    render(<WorkspaceActionDialog request={deleteProject} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除这个项目的记录吗？" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("项目仍在处理中");
    expect(within(dialog).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps an expired delete token disabled until preview retry supplies a usable token", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction)
      .mockResolvedValueOnce(deletionPreview(false, "expired-delete-token"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(deletionPreview(false, "fresh-delete-token"));
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction").mockRejectedValue(new DesktopCommandError("execute_workspace_action", JSON.stringify({
      code: "UI-ACTION-PREVIEW-EXPIRED", message: "Expired; nothing was executed.", retryable: false,
    })));
    render(<WorkspaceActionDialog request={deleteProject} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除这个项目的记录吗？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await screen.findByText("UI-ACTION-PREVIEW-FAILED");
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "删除" })).toBeEnabled());
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps deletion open beyond five seconds without automatically closing or executing", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue(deletionPreview(false));
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction");
    const onClose = vi.fn();
    render(<WorkspaceActionDialog request={deleteProject} projectName="自行车街景" onClose={onClose} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除项目“自行车街景”的记录吗？" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus());
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTime(6000));
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("updates the delete question after stale, focuses the short alert, and requires a new token confirmation", async () => {
    vi.mocked(desktopApi.previewWorkspaceAction).mockResolvedValue(deletionPreview(false, "record-only-token"));
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction")
      .mockResolvedValueOnce({ kind: "stale", code: "UI-ACTION-PREVIEW-STALE", message: "Long backend details must not be repeated", preview: deletionPreview(true, "permanent-token") })
      .mockResolvedValueOnce({ kind: "completed", receipt: { ...receipt(), action: "delete_project" } });
    render(<WorkspaceActionDialog request={deleteProject} projectName="自行车街景" onClose={vi.fn()} />);
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除项目“自行车街景”的记录吗？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await screen.findByRole("alertdialog", { name: "确认永久删除项目“自行车街景”吗？" });
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("项目状态已变化，请重新确认。");
    expect(dialog).not.toHaveTextContent("Long backend details must not be repeated");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(execute).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await screen.findByText("The confirmed action completed.");
    expect(execute).toHaveBeenNthCalledWith(1, "record-only-token");
    expect(execute).toHaveBeenNthCalledWith(2, "permanent-token");
  });

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
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const stale = {
      kind: "stale" as const,
      code: "UI-ACTION-PREVIEW-STALE" as const,
      message: "State changed; nothing was executed.",
      preview: preview("token-2", "updated pipeline"),
    };
    const pending = deferred<typeof stale>();
    const execute = vi.spyOn(desktopApi, "executeWorkspaceAction")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ kind: "completed", receipt: receipt() });
    render(<WorkspaceActionDialog request={request} onClose={vi.fn()} />);

    const dialog = await screen.findByRole("alertdialog");
    await screen.findByText("kept artifact");
    let buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);

    await act(async () => {
      pending.resolve(stale);
      await Promise.resolve();
      // A frame may run before React commits an async result. Focusing a ref
      // from that frame must not lose the committed stale-state announcement.
      for (const callback of frames.splice(0)) callback(performance.now());
    });

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

    await screen.findByText("UI-ACTION-PREVIEW-FAILED");
    expect(screen.getByText("kept artifact")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认并执行" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "重新读取影响说明" })).toBeEnabled();
  });
});
