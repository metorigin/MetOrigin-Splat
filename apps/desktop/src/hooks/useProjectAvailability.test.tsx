import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectAvailabilityResult, ProjectInfo, RecentProjectAvailability } from "../types";
import { useProjectAvailability } from "./useProjectAvailability";

const api = vi.hoisted(() => ({
  checkRecentProjectAvailability: vi.fn(),
}));

vi.mock("../services/desktop", () => ({ desktopApi: api }));

function project(index: number): ProjectInfo {
  return {
    id: `project-${index}`,
    name: `项目 ${index}`,
    path: `D:\\projects\\${index}`,
    status: "ready",
    updated_at: "2026-08-14T00:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function available(item: ProjectInfo): ProjectAvailabilityResult {
  return {
    project_id: item.id,
    checked_path: item.path,
    availability: "available",
    checked_at: "2026-08-14T00:01:00Z",
    reason_code: null,
    refreshed_project: item,
  };
}

describe("useProjectAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts no more than four probes and releases one slot per completion", async () => {
    const projects = Array.from({ length: 7 }, (_, index) => project(index));
    const pending = projects.map(() => deferred<ProjectAvailabilityResult>());
    let active = 0;
    let maximum = 0;
    api.checkRecentProjectAvailability.mockImplementation((id: string) => {
      const index = Number(id.split("-")[1]);
      active += 1;
      maximum = Math.max(maximum, active);
      return pending[index].promise.finally(() => { active -= 1; });
    });
    const dispatch = vi.fn();

    renderHook(() => useProjectAvailability(projects, {}, dispatch));
    await waitFor(() => expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(4));
    expect(maximum).toBe(4);

    await act(async () => { pending[0].resolve(available(projects[0])); });
    await waitFor(() => expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(5));
    expect(maximum).toBe(4);

    await act(async () => {
      pending.slice(1).forEach((item, index) => item.resolve(available(projects[index + 1])));
      await Promise.all(pending.map((item) => item.promise));
    });
    await waitFor(() => expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(7));
    expect(maximum).toBe(4);
  });

  it("keeps Retry single-flight and checks only the requested record", async () => {
    const item = project(1);
    const initialAvailability: Record<string, RecentProjectAvailability> = {
      [item.id]: {
        status: "check_failed",
        checkedPath: item.path,
        checkedAt: "2026-08-14T00:00:30Z",
        reasonCode: "UI-PROJECT-PATH-CHECK-REQUEST",
        generation: 3,
      },
    };
    const dispatch = vi.fn();
    const retry = deferred<ProjectAvailabilityResult>();
    api.checkRecentProjectAvailability.mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useProjectAvailability([item], initialAvailability, dispatch));
    await waitFor(() => expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(1));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.retryProjectAvailability(item.id);
      second = result.current.retryProjectAvailability(item.id);
    });
    expect(first).toBe(second);
    expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(1);
    act(() => { retry.resolve(available(item)); });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_PROJECT_AVAILABILITY" })));

    const secondRetry = deferred<ProjectAvailabilityResult>();
    api.checkRecentProjectAvailability.mockReturnValueOnce(secondRetry.promise);
    act(() => {
      first = result.current.retryProjectAvailability(item.id);
      second = result.current.retryProjectAvailability(item.id);
    });
    expect(first).toBe(second);
    expect(api.checkRecentProjectAvailability).toHaveBeenCalledTimes(2);
    await act(async () => { secondRetry.resolve(available(item)); await secondRetry.promise; });
  });
});
