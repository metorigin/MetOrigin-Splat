import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UiError } from "../../types";
import { ErrorNotice } from "./ErrorNotice";

function uiError(overrides: Partial<UiError> = {}): UiError {
  return {
    code: "E-TEST",
    category: "filesystem",
    title: "无法读取项目",
    message: "项目状态未更新",
    impact: "正在显示最后一次结果",
    suggestions: ["检查磁盘连接", "稍后重试"],
    retryable: true,
    actions: [
      { kind: "retry", label: "重试", enabled: true },
      { kind: "open_settings", label: "打开设置", enabled: true },
    ],
    technicalDetails: "token=secret C:\\Users\\alice\\project.log",
    logReference: null,
    ...overrides,
  };
}

describe("ErrorNotice", () => {
  it("shows user impact, code, suggestions, actions, and redacted details", () => {
    render(<ErrorNotice error={uiError()} blocking />);
    expect(screen.getByRole("alert")).toHaveTextContent("无法读取项目");
    expect(screen.getByRole("alert")).toHaveTextContent("影响：正在显示最后一次结果");
    expect(screen.getByRole("alert")).toHaveTextContent("E-TEST");
    expect(screen.getByText("检查磁盘连接")).toBeInTheDocument();
    fireEvent.click(screen.getByText("技术详情"));
    expect(screen.getByText(/\[REDACTED\]/)).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("never renders Retry for an unsafe error", () => {
    render(<ErrorNotice error={uiError({ retryable: false })} />);
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
  });

  it("runs an async action once while preserving visible feedback", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const onAction = vi.fn(() => pending);
    render(<ErrorNotice error={uiError()} onAction={onAction} />);
    const retry = screen.getByRole("button", { name: "重试" });
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "重试中…" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByText("无法读取项目")).toBeInTheDocument();
    resolve();
    await pending;
  });
});
