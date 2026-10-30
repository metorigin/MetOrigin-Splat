import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionReceipt as ActionReceiptModel } from "../../types";
import { ActionReceipt } from "./ActionReceipt";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function receipt(overrides: Partial<ActionReceiptModel> = {}): ActionReceiptModel {
  return { id: "receipt", action: "cancel", status: "success", title: "操作已完成", message: "已按确认的影响范围完成操作，并刷新相关状态。", completedAt: "2026-10-31T00:00:00Z", affectedResources: ["pipeline"], dismissible: true, ...overrides };
}

describe("ActionReceipt", () => {
  it("redacts credentials and private paths at the rendering boundary", () => {
    const receipt: ActionReceiptModel = {
      id: "receipt-safe",
      action: "cancel",
      status: "success",
      title: "操作完成",
      message:
        "token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\project",
      completedAt: "2026-08-14T00:00:00Z",
      affectedResources: ["pipeline"],
      dismissible: false,
    };

    render(<ActionReceipt receipt={receipt} placement="inline" />);
    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(status).not.toHaveTextContent("PrivateUser");
    expect(status).toHaveTextContent("[REDACTED]");
    expect(status).toHaveTextContent("[REDACTED_PATH]");
  });

  it("keeps a useful failure reason assertive and permits early manual dismissal", () => {
    const dismiss = vi.fn();
    render(<ActionReceipt receipt={{ id: "failed", action: "cancel", status: "error", title: "操作未完成", message: "任务仍在运行", completedAt: "2026-08-14T00:00:00Z", affectedResources: ["pipeline"], dismissible: true }} onDismiss={dismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("任务仍在运行");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each([
    ["delete_project", ["recent_projects", "project_storage"], "项目已删除"],
    ["delete_project", ["recent_projects"], "项目记录已移除"],
    ["delete_checkpoint", ["checkpoints"], "恢复点已删除"],
    ["restore_checkpoint", ["checkpoints"], "已恢复所选恢复点"],
    ["pause", ["pipeline"], "已请求暂停任务"],
    ["cancel", ["pipeline"], "已请求取消任务"],
    ["rerun_stage", ["pipeline"], "阶段已重置"],
  ] as const)("summarizes %s without a repeated generic heading", (action, affectedResources, expected) => {
    render(<ActionReceipt receipt={receipt({ action, affectedResources: [...affectedResources] })} />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.queryByText("操作已完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/已按确认的影响范围/)).not.toBeInTheDocument();
  });

  it("clears parent state after five seconds even for an old nondismissible toast receipt", () => {
    const dismiss = vi.fn();
    render(<ActionReceipt receipt={receipt({ dismissible: false })} onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("gives a replacement receipt with the same short message its own five seconds", () => {
    const dismiss = vi.fn();
    const view = render(<ActionReceipt receipt={receipt({ id: "first" })} onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(4000));
    view.rerender(<ActionReceipt receipt={receipt({ id: "second" })} onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByRole("status")).toHaveTextContent("已请求取消任务");
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("expires an error toast while keeping its concrete redacted reason", () => {
    const dismiss = vi.fn();
    render(<ActionReceipt receipt={receipt({ status: "error", message: "任务仍在运行，无法删除 token=PRIVATE_TEST_VALUE /Users/private/project" })} onDismiss={dismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("任务仍在运行，无法删除");
    expect(screen.getByRole("alert")).not.toHaveTextContent("PRIVATE_TEST_VALUE");
    act(() => vi.advanceTimersByTime(5000));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps inline confirmation receipts visible and complete after five seconds", () => {
    const dismiss = vi.fn();
    render(<ActionReceipt receipt={receipt()} placement="inline" onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("status")).toHaveTextContent("操作已完成");
    expect(screen.getByRole("status")).toHaveTextContent("已按确认的影响范围完成操作，并刷新相关状态。");
    expect(dismiss).not.toHaveBeenCalled();
  });
});
