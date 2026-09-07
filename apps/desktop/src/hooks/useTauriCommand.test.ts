import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invokeDesktopCommand } from "../services/desktop";
import { useTauriCommand } from "./useTauriCommand";

vi.mock("../services/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/desktop")>();
  return { ...actual, invokeDesktopCommand: vi.fn() };
});

describe("useTauriCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains last-good data and exposes a normalized error", async () => {
    vi.mocked(invokeDesktopCommand)
      .mockResolvedValueOnce("0.1.0")
      .mockRejectedValueOnce(JSON.stringify({ code: "E-VERSION", message: "暂时不可用", retryable: true }));
    const { result } = renderHook(() => useTauriCommand<string>("app_version"));
    await act(async () => { await result.current.execute(); });
    expect(result.current.data).toBe("0.1.0");
    await act(async () => { await result.current.execute().catch(() => undefined); });
    expect(result.current.data).toBe("0.1.0");
    expect(result.current.uiError?.code).toBe("E-VERSION");
    expect(result.current.uiError?.retryable).toBe(true);
  });

  it("coalesces repeated execution while a command is pending", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(invokeDesktopCommand).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useTauriCommand<string>("app_version"));
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.execute();
      second = result.current.execute();
    });
    expect(result.current.loading).toBe(true);
    expect(first).toBe(second);
    expect(invokeDesktopCommand).toHaveBeenCalledOnce();
    resolve("0.1.0");
    await act(async () => { await first; });
    expect(result.current.loading).toBe(false);
  });
});
