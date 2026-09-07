import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("workspace theme", () => {
  it("follows system changes only when system appearance is selected", () => {
    let dark = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({ matches: dark, addEventListener: (_: string, callback: () => void) => listeners.add(callback), removeEventListener: (_: string, callback: () => void) => listeners.delete(callback) }));
    const hook = renderHook(useTheme);
    act(() => hook.result.current.setTheme("system"));
    expect(hook.result.current.resolvedTheme).toBe("dark");
    act(() => { dark = false; listeners.forEach((callback) => callback()); });
    expect(hook.result.current.resolvedTheme).toBe("light");
    act(() => hook.result.current.setTheme("dark"));
    act(() => listeners.forEach((callback) => callback()));
    expect(hook.result.current.resolvedTheme).toBe("dark");
    act(() => hook.result.current.setTheme("light"));
  });

  it("persists a selection and updates every mounted surface", () => {
    const first = renderHook(useTheme);
    const second = renderHook(useTheme);
    act(() => first.result.current.setTheme("dark"));
    expect(second.result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("metorigin.ui.theme")).toBe("dark");
    act(() => first.result.current.setTheme("light"));
  });

  it("keeps theme switching usable when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const hook = renderHook(useTheme);
    act(() => hook.result.current.setTheme("dark"));
    expect(hook.result.current.resolvedTheme).toBe("dark");
    act(() => hook.result.current.setTheme("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
