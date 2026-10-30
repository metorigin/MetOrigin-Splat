import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AsyncResource, UiError } from "../../types";
import { AsyncStatus } from "./AsyncStatus";

const error: UiError = {
  code: "TEST-LOAD", category: "filesystem", title: "读取失败", message: "token=SECRET_VALUE /Users/private/capture",
  impact: "旧结果保留", suggestions: [], retryable: true, actions: [], technicalDetails: null, logReference: null,
};
const resource = (overrides: Partial<AsyncResource<unknown[]>> = {}): AsyncResource<unknown[]> => ({
  data: [], status: "success", completeness: "complete", partialIssues: [], error: null,
  lastSuccessfulAt: null, requestedAt: null, requestKey: "events", ...overrides,
});

describe("AsyncStatus", () => {
  it("retains stale feedback and retry even when the cached result is empty", () => {
    const retry = vi.fn();
    render(<AsyncStatus resource={resource({ status: "stale", error })} label="活动记录" empty onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("活动记录可能已过期");
    expect(screen.queryByText("暂无活动记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not mistake an empty refreshing resource for confirmed empty state", () => {
    render(<AsyncStatus resource={resource({ status: "refreshing" })} label="活动记录" empty />);
    expect(screen.getByRole("status")).toHaveTextContent("正在刷新活动记录");
    expect(screen.queryByText("暂无活动记录")).not.toBeInTheDocument();
  });

  it("redacts resource errors and only offers safe retries for partial results", () => {
    const retry = vi.fn();
    const view = render(<AsyncStatus resource={resource({ status: "error", error })} label="活动记录" onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("[REDACTED]");
    expect(screen.getByRole("alert")).toHaveTextContent("[REDACTED_PATH]");
    expect(screen.getByRole("alert")).not.toHaveTextContent("SECRET_VALUE");
    view.rerender(<AsyncStatus resource={resource({ completeness: "partial", partialIssues: [{ scope: "活动记录", error: { ...error, retryable: false }, retryActionKey: "reload" }] })} label="活动记录" onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("仅部分可用");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });
});
