import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelEditor } from "./useModelEditor";
import { desktopApi } from "../services/desktop";
import type { EditorSession, ProjectInfo } from "../types";

vi.mock("../services/desktop", () => ({ isDesktopRuntime: () => false, desktopApi: { openModelEditor: vi.fn(), closeModelEditor: vi.fn() } }));
const project: ProjectInfo = { id: "p", path: "D:/p", name: "项目", status: "completed", updated_at: "2026-09-09" };
const session: EditorSession = { session_id: "session-a", project_id: "p", project_path: "D:/p", project_name: "项目", source: { relative_path: "output/scene.ply", revision: "r", size_bytes: 10, vertex_count: 1, iteration: null } };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(desktopApi.openModelEditor).mockResolvedValue(session); vi.mocked(desktopApi.closeModelEditor).mockResolvedValue(); });

describe("workspace editor lifecycle", () => {
  it("opens the project model and preserves the session when leaving is declined", async () => {
    const { result } = renderHook(() => useModelEditor(vi.fn()));
    await act(async () => { await result.current.open(project); });
    expect(desktopApi.openModelEditor).toHaveBeenCalledWith("p", "D:/p");
    Object.assign(result.current.editorRef, { current: { requestLeave: vi.fn().mockResolvedValue(false) } });
    await act(async () => { expect(await result.current.leave()).toBe(false); });
    expect(result.current.session).toBe(session);
    expect(desktopApi.closeModelEditor).not.toHaveBeenCalled();
    Object.assign(result.current.editorRef, { current: { requestLeave: vi.fn().mockResolvedValue(true) } });
    await act(async () => { expect(await result.current.leave()).toBe(true); });
    expect(desktopApi.closeModelEditor).toHaveBeenCalledWith("session-a");
    expect(result.current.session).toBeNull();
  });
  it("prevents navigation and duplicate opens while preparing a model", async () => {
    let resolve!: (value: EditorSession) => void;
    vi.mocked(desktopApi.openModelEditor).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useModelEditor(vi.fn()));
    let pending!: Promise<void>;
    act(() => { pending = result.current.open(project); });
    await act(async () => {
      expect(await result.current.leave()).toBe(false);
      await result.current.open(project);
    });
    expect(desktopApi.openModelEditor).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(session); await pending; });
    expect(result.current.session).toBe(session);
  });
  it("keeps the editor available if ending its backend session fails", async () => {
    const error = vi.fn();
    const { result } = renderHook(() => useModelEditor(error));
    await act(async () => { await result.current.open(project); });
    vi.mocked(desktopApi.closeModelEditor).mockRejectedValueOnce(new Error("暂时不可用"));
    await act(async () => { expect(await result.current.leave()).toBe(false); });
    expect(result.current.session).toBe(session);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("暂时不可用"));
  });
});
