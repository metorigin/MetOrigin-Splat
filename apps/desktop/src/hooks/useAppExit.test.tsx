import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppExit } from "./useAppExit";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: { payload: string }) => void>(),
  finish: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: string }) => void) => {
    mocks.callbacks.set(name, callback);
    return mocks.cleanup;
  }),
}));
vi.mock("../services/desktop", () => ({
  isDesktopRuntime: () => true,
  desktopApi: { finishAppExit: mocks.finish },
}));
beforeEach(() => { mocks.callbacks.clear(); vi.clearAllMocks(); mocks.finish.mockResolvedValue(undefined); });
const requestQuit = () => act(() => mocks.callbacks.get("app-exit-requested")?.({ payload: "" }));

describe("native quit editor handoff", () => {
  it("keeps the app open when the user cancels leaving the editor", async () => {
    const leave = vi.fn().mockResolvedValue(false);
    renderHook(() => useAppExit(leave, vi.fn()));
    requestQuit();
    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("waits for editor persistence and deduplicates repeated quit requests", async () => {
    let resolveLeave!: (value: boolean) => void;
    const leave = vi.fn(() => new Promise<boolean>((resolve) => { resolveLeave = resolve; }));
    renderHook(() => useAppExit(leave, vi.fn()));
    requestQuit(); requestQuit();
    expect(leave).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
    await act(async () => resolveLeave(true));
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce());
  });

  it("reports native cleanup failures and unregisters both listeners", async () => {
    const report = vi.fn();
    const { unmount } = renderHook(() => useAppExit(vi.fn().mockResolvedValue(true), report));
    await act(async () => {});
    act(() => mocks.callbacks.get("app-exit-failed")?.({ payload: "未能停止" }));
    expect(report).toHaveBeenCalledWith("未能停止");
    mocks.finish.mockRejectedValueOnce(new Error("无法保存"));
    requestQuit();
    await waitFor(() => expect(report).toHaveBeenCalledWith("Error: 无法保存"));
    unmount();
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });
});
