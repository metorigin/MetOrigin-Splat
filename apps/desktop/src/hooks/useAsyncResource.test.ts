import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UiError } from "../types/errors";
import {
  asyncResourceReducer,
  createAsyncResourceState,
  useAsyncResource,
} from "./useAsyncResource";

const retryableError: UiError = {
  code: "UI-RETRYABLE",
  category: "filesystem",
  title: "暂时无法读取",
  message: "读取暂时失败。",
  impact: "现有数据保持不变。",
  suggestions: ["重试读取"],
  retryable: true,
  actions: [{ kind: "retry", label: "重试", enabled: true }],
  technicalDetails: null,
  logReference: null,
};

const terminalError: UiError = {
  ...retryableError,
  code: "UI-NOT-RETRYABLE",
  title: "项目数据不可用",
  retryable: false,
  actions: [{ kind: "dismiss", label: "关闭", enabled: true }],
};

describe("AsyncResource", () => {
  it("distinguishes complete empty success from loading and failure", () => {
    const loading = asyncResourceReducer(createAsyncResourceState<string[]>(), {
      type: "request",
      requestKey: "projects",
      requestedAt: 10,
    });
    const success = asyncResourceReducer(loading, {
      type: "success",
      requestKey: "projects",
      data: [],
      completeness: "complete",
      partialIssues: [],
      receivedAt: 20,
    });

    expect(success).toMatchObject({
      data: [],
      status: "success",
      completeness: "complete",
      error: null,
      lastSuccessfulAt: 20,
    });
  });

  it("keeps partial data and suppresses unsafe retry action keys", () => {
    const loading = asyncResourceReducer(createAsyncResourceState<string[]>(), {
      type: "request",
      requestKey: "artifacts",
      requestedAt: 10,
    });
    const partial = asyncResourceReducer(loading, {
      type: "success",
      requestKey: "artifacts",
      data: ["preview.ply"],
      completeness: "partial",
      partialIssues: [
        { scope: "checkpoints", error: retryableError, retryActionKey: "retry-checkpoints" },
        { scope: "preview", error: terminalError, retryActionKey: "unsafe-retry" },
      ],
      receivedAt: 20,
    });

    expect(partial.partialIssues[0].retryActionKey).toBe("retry-checkpoints");
    expect(partial.partialIssues[1].retryActionKey).toBeNull();
  });

  it("retains the last successful data when refresh fails", () => {
    const current = createAsyncResourceState(["checkpoint-1"]);
    const refreshing = asyncResourceReducer(current, {
      type: "request",
      requestKey: "refresh",
      requestedAt: 30,
    });
    const stale = asyncResourceReducer(refreshing, {
      type: "failure",
      requestKey: "refresh",
      error: retryableError,
    });

    expect(stale.status).toBe("stale");
    expect(stale.data).toEqual(["checkpoint-1"]);
    expect(stale.error?.code).toBe("UI-RETRYABLE");
  });

  it("ignores results for a replaced request key", () => {
    const loading = asyncResourceReducer(createAsyncResourceState<string[]>(), {
      type: "request",
      requestKey: "new-query",
      requestedAt: 40,
    });
    const stale = asyncResourceReducer(loading, {
      type: "success",
      requestKey: "old-query",
      data: ["old"],
      completeness: "complete",
      partialIssues: [],
      receivedAt: 50,
    });

    expect(stale).toBe(loading);
  });

  it("runs one mutation per action key and reuses its promise", async () => {
    let resolveMutation: ((value: string) => void) | undefined;
    const mutation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    const { result } = renderHook(() => useAsyncResource<string[]>());

    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.runMutation("restore", mutation);
      second = result.current.runMutation("restore", mutation);
    });
    expect(first).toBe(second);
    expect(mutation).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMutation?.("done");
      await first;
    });
    expect(result.current.isActionPending("restore")).toBe(false);
  });
});
