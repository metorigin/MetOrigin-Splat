import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmationProvider } from "./ConfirmationProvider";
import { requestConfirmation, registerConfirmationHandler } from "@/services/confirmation";
import { confirmRemoveRecentProject, confirmSafeCancel } from "@/services/desktop";

const request = { title: "离开模型编辑", description: "未保存修改将被丢弃。", confirmLabel: "丢弃并离开", cancelLabel: "继续编辑", destructive: true };

function begin() {
  let promise!: Promise<boolean>;
  act(() => { promise = requestConfirmation(request); });
  return promise;
}

describe("application confirmation", () => {
  it("fails closed when no shell is mounted or the presentation fails", async () => {
    await expect(requestConfirmation(request)).resolves.toBe(false);
    const unregister = registerConfirmationHandler(() => Promise.reject(new Error("unavailable")));
    await expect(requestConfirmation(request)).resolves.toBe(false);
    unregister();
  });

  it("keeps the editor mounted, focuses the conservative action, and returns the decision once", async () => {
    const view = render(<ConfirmationProvider><iframe title="Editor" src="about:blank" /></ConfirmationProvider>);
    const editor = screen.getByTitle("Editor");
    const promise = begin();
    expect(screen.getByRole("alertdialog", { name: request.title })).toHaveAccessibleDescription(request.description);
    expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus();
    expect(screen.getByTitle("Editor")).toBe(editor);
    fireEvent.click(screen.getByRole("button", { name: "丢弃并离开" }));
    await expect(promise).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTitle("Editor")).toBe(editor);
    view.unmount();
  });

  it("rejects a concurrent request without replacing the pending decision", async () => {
    render(<ConfirmationProvider><div>Workspace</div></ConfirmationProvider>);
    const first = begin();
    await expect(requestConfirmation({ ...request, title: "Duplicate" })).resolves.toBe(false);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(request.title);
    fireEvent.keyDown(screen.getByRole("button", { name: "继续编辑" }), { key: "Escape" });
    await expect(first).resolves.toBe(false);
  });

  it("resolves false on provider disposal and allows a newly mounted shell to ask again", async () => {
    const view = render(<ConfirmationProvider><div>Workspace</div></ConfirmationProvider>);
    const first = begin();
    view.unmount();
    await expect(first).resolves.toBe(false);
    await expect(requestConfirmation(request)).resolves.toBe(false);
    render(<ConfirmationProvider><div>Workspace</div></ConfirmationProvider>);
    const next = begin();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await expect(next).resolves.toBe(false);
  });

  it("routes safe cancellation and recent removal through the same awaited application surface", async () => {
    render(<ConfirmationProvider><div>Workspace</div></ConfirmationProvider>);
    let cancellation!: Promise<boolean>;
    act(() => { cancellation = confirmSafeCancel("训练"); });
    expect(screen.getByRole("alertdialog", { name: "安全取消重建" })).toHaveTextContent("将停止训练并保留已验证阶段与合法检查点");
    fireEvent.click(screen.getByRole("button", { name: "继续运行" }));
    await expect(cancellation).resolves.toBe(false);
    let removal!: Promise<boolean>;
    act(() => { removal = confirmRemoveRecentProject("Courtyard"); });
    expect(screen.getByRole("alertdialog", { name: "从最近项目移除" })).toHaveTextContent("磁盘中的项目文件会保留");
    fireEvent.click(screen.getByRole("button", { name: "移除记录" }));
    await expect(removal).resolves.toBe(true);
  });
});
