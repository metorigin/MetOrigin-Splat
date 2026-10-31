import { describe, expect, it } from "vitest";

import type { PipelineSnapshot, ProjectInfo } from "../types";
import {
  initialState,
  reducer,
  selectActivePipelineSnapshot,
  selectPipelineConflict,
  selectProjectPipelineSnapshot,
} from "./appContextValue";
import type { Page } from "./appContextValue";

function snapshot(sequence: number, status: PipelineSnapshot["status"]): PipelineSnapshot {
  return {
    project_id: "project-1",
    project_path: "D:\\projects\\project-1",
    status,
    state: { stages: {}, current_stage: null, overall_progress: 0.25 },
    sequence,
    accepted_at: sequence > 0 ? "2026-07-14T00:00:00Z" : null,
    started_at: null,
    control_intent: "none",
  };
}

function project(id = "project-1", path = "D:\\projects\\project-1"): ProjectInfo {
  return {
    id,
    name: `项目 ${id}`,
    path,
    status: "ready",
    updated_at: "2026-08-14T00:00:00Z",
  };
}

function projectPage(id: string, path = `D:\\projects\\${id}`): Page {
  return { type: "project-detail", projectId: id, projectPath: path };
}

describe("global error events", () => {
  it("identifies each non-null error event while clearing or ordinary updates preserve its revision", () => {
    const first = reducer(initialState, { type: "SET_ERROR", error: "项目位置不可用" });
    const repeated = reducer(first, { type: "SET_ERROR", error: "项目位置不可用" });
    expect(first.errorRevision).toBe(1);
    expect(repeated.errorRevision).toBe(2);
    const refreshed = reducer(repeated, { type: "SET_ENGINES", engines: [] });
    expect(refreshed.errorRevision).toBe(repeated.errorRevision);
    const dismissed = reducer(refreshed, { type: "SET_ERROR", error: null });
    expect(dismissed.error).toBeNull();
    expect(dismissed.errorRevision).toBe(repeated.errorRevision);
    expect(reducer(dismissed, { type: "SET_ERROR", error: "项目位置不可用" }).errorRevision).toBe(3);
  });
});

describe("recent project visits", () => {
  it("promotes a successfully opened sixth project while ordinary status updates preserve visit order", () => {
    const projects = Array.from({ length: 6 }, (_, index) => project(`project-${index + 1}`, `D:\\projects\\${index + 1}`));
    const listed = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects });
    const opened = reducer(listed, { type: "ADD_RECENT_PROJECT", project: projects[5], recentlyOpened: true });
    const expectedOrder = ["project-6", "project-1", "project-2", "project-3", "project-4", "project-5"];
    expect(opened.recentProjects.map((entry) => entry.id)).toEqual(expectedOrder);

    const refreshed = reducer(opened, {
      type: "ADD_RECENT_PROJECT",
      project: { ...projects[2], status: "running" },
    });
    expect(refreshed.recentProjects.map((entry) => entry.id)).toEqual(expectedOrder);
    expect(refreshed.recentProjects.find((entry) => entry.id === "project-3")?.status).toBe("running");
  });

  it("keeps fresher project data and its checked path when a stale successful open changes visit order", () => {
    const original = project("project-6", "D:\\projects\\old");
    const fresh = { ...original, path: "E:\\projects\\current", name: "较新的项目", status: "running" as const, updated_at: "2026-08-14T00:03:00Z" };
    const listed = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects: [project("project-1"), fresh] });
    const availability = { status: "available" as const, checkedPath: fresh.path, checkedAt: "2026-08-14T00:03:01Z", reasonCode: null, generation: 4 };
    const checked = { ...listed, projectAvailability: { ...listed.projectAvailability, [fresh.id]: availability } };
    const reopened = reducer(checked, { type: "ADD_RECENT_PROJECT", project: original, recentlyOpened: true });

    expect(reopened.recentProjects.map((entry) => entry.id)).toEqual([fresh.id, "project-1"]);
    expect(reopened.recentProjects[0]).toBe(fresh);
    expect(reopened.recentProjects[0].updated_at).toBe("2026-08-14T00:03:00Z");
    expect(reopened.projectAvailability[fresh.id]).toBe(availability);
  });
});

describe("page navigation history", () => {
  it("navigates backward and forward without adding visits and stops at both ends", () => {
    expect(reducer(initialState, { type: "NAVIGATE_BACK" })).toBe(initialState);
    expect(reducer(initialState, { type: "NAVIGATE_FORWARD" })).toBe(initialState);
    const first = reducer(initialState, { type: "NAVIGATE", page: projectPage("a") });
    const second = reducer(first, { type: "NAVIGATE", page: projectPage("b") });
    const back = reducer({ ...second, error: "old error" }, { type: "NAVIGATE_BACK" });
    expect(back.page).toEqual(projectPage("a"));
    expect(back.navigationIndex).toBe(1);
    expect(back.navigationHistory).toBe(second.navigationHistory);
    expect(back.error).toBeNull();
    const forward = reducer(back, { type: "NAVIGATE_FORWARD" });
    expect(forward.page).toEqual(projectPage("b"));
    expect(forward.navigationIndex).toBe(2);
    expect(reducer(forward, { type: "NAVIGATE_FORWARD" })).toBe(forward);
  });

  it("deduplicates the same destination without losing forward history, then replaces a forward branch", () => {
    const first = reducer(initialState, { type: "NAVIGATE", page: projectPage("a") });
    const second = reducer(first, { type: "NAVIGATE", page: projectPage("b") });
    const back = reducer(second, { type: "NAVIGATE_BACK" });
    const sameDestination = reducer(back, { type: "NAVIGATE", page: projectPage("a") });
    expect(sameDestination.navigationHistory).toBe(second.navigationHistory);
    expect(sameDestination.navigationIndex).toBe(1);
    const branch = reducer(sameDestination, { type: "NAVIGATE", page: projectPage("c") });
    expect(branch.navigationHistory).toEqual([{ type: "home" }, projectPage("a"), projectPage("c")]);
    expect(reducer(branch, { type: "NAVIGATE_FORWARD" })).toBe(branch);
  });

  it("includes project identity and full path when comparing destinations", () => {
    const first = reducer(initialState, { type: "NAVIGATE", page: projectPage("a", "D:\\projects\\old") });
    const second = reducer(first, { type: "NAVIGATE", page: projectPage("a", "D:\\projects\\new") });
    const third = reducer(second, { type: "NAVIGATE", page: projectPage("b", "D:\\projects\\new") });
    expect(third.navigationHistory).toHaveLength(4);
    expect(reducer(third, { type: "NAVIGATE_BACK" }).page).toEqual(projectPage("a", "D:\\projects\\new"));
  });

  it("keeps creation transient and preserves forward visits when safely exiting back to the same page", () => {
    const visited = reducer(initialState, { type: "NAVIGATE", page: projectPage("a") });
    const home = reducer(visited, { type: "NAVIGATE_BACK" });
    const creating = reducer(home, { type: "NAVIGATE", page: { type: "new-project" } });
    expect(creating.page).toEqual({ type: "new-project" });
    expect(creating.navigationHistory).toBe(home.navigationHistory);
    expect(reducer(creating, { type: "NAVIGATE_BACK" })).toBe(creating);
    expect(reducer(creating, { type: "NAVIGATE_FORWARD" })).toBe(creating);
    const safelyExited = reducer(creating, { type: "NAVIGATE", page: { type: "home" } });
    expect(safelyExited.page).toEqual({ type: "home" });
    expect(safelyExited.navigationHistory).toBe(home.navigationHistory);
    expect(reducer(safelyExited, { type: "NAVIGATE_FORWARD" }).page).toEqual(projectPage("a"));
  });

  it("records a newly created project without leaving an empty wizard in back history", () => {
    const visited = reducer(initialState, { type: "NAVIGATE", page: projectPage("a") });
    const home = reducer(visited, { type: "NAVIGATE_BACK" });
    const creating = reducer(home, { type: "NAVIGATE", page: { type: "new-project" } });
    const created = reducer(creating, { type: "NAVIGATE", page: projectPage("new") });
    expect(created.navigationHistory).toEqual([{ type: "home" }, projectPage("new")]);
    expect(reducer(created, { type: "NAVIGATE_BACK" }).page).toEqual({ type: "home" });
    expect(reducer(created, { type: "NAVIGATE_FORWARD" })).toBe(created);
  });

  it("bounds memory to the last fifty visits while retaining a valid current index", () => {
    let state = initialState;
    for (let index = 0; index < 60; index += 1) {
      state = reducer(state, { type: "NAVIGATE", page: projectPage(String(index)) });
    }
    expect(state.navigationHistory).toHaveLength(50);
    expect(state.navigationHistory[0]).toEqual(projectPage("10"));
    expect(state.navigationIndex).toBe(49);
    expect(state.page).toEqual(projectPage("59"));
    for (let index = 0; index < 50; index += 1) state = reducer(state, { type: "NAVIGATE_BACK" });
    expect(state.page).toEqual(projectPage("10"));
    expect(state.navigationIndex).toBe(0);
  });

  it("removes all visits to removed projects and keeps remaining navigation usable", () => {
    let state = initialState;
    for (const id of ["a", "b", "a", "b"]) state = reducer(state, { type: "NAVIGATE", page: projectPage(id) });
    const withoutA = reducer(state, { type: "REMOVE_RECENT_PROJECT", projectId: "a" });
    expect(withoutA.navigationHistory).toEqual([{ type: "home" }, projectPage("b")]);
    expect(withoutA.navigationIndex).toBe(1);
    expect(withoutA.page).toEqual(projectPage("b"));
    const back = reducer(withoutA, { type: "NAVIGATE_BACK" });
    expect(reducer(back, { type: "NAVIGATE_FORWARD" }).page).toEqual(projectPage("b"));
    const withoutCurrent = reducer(withoutA, { type: "REMOVE_RECENT_PROJECT", projectId: "b" });
    expect(withoutCurrent.navigationHistory).toEqual([{ type: "home" }]);
    expect(withoutCurrent.page).toEqual({ type: "home" });
    expect(withoutCurrent.navigationIndex).toBe(0);
  });

  it("rewrites relocated paths in both current and prior visits without adding a navigation", () => {
    const oldPath = "D:\\projects\\old";
    const newPath = "E:\\工程 中文\\new";
    let state = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects: [project("a", oldPath)] });
    state = reducer(state, { type: "NAVIGATE", page: projectPage("a", oldPath) });
    state = reducer(state, { type: "NAVIGATE", page: projectPage("b") });
    state = reducer(state, { type: "NAVIGATE", page: projectPage("a", oldPath) });
    const relinked = reducer(state, { type: "RELINK_RECENT_PROJECT", previousPath: oldPath, project: project("a", newPath) });
    expect(relinked.navigationHistory).toEqual([{ type: "home" }, projectPage("a", newPath), projectPage("b"), projectPage("a", newPath)]);
    expect(relinked.page).toEqual(projectPage("a", newPath));
    expect(relinked.navigationIndex).toBe(3);
    const previousVisit = reducer(reducer(relinked, { type: "NAVIGATE_BACK" }), { type: "NAVIGATE_BACK" });
    expect(previousVisit.page).toEqual(projectPage("a", newPath));
  });
});

describe("pipeline snapshot reducer", () => {
  it("rejects an older active snapshot for the same project", () => {
    const current = reducer(initialState, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(12, "running"),
    });
    const stale = reducer(current, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(4, "running"),
    });
    expect(stale.pipelineSnapshot?.sequence).toBe(12);
  });

  it("rejects a sequence-zero ready snapshot produced while opening a project", () => {
    const current = reducer(initialState, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(12, "running"),
    });
    const stale = reducer(current, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(0, "ready"),
    });
    expect(stale.pipelineSnapshot?.status).toBe("running");
    expect(stale.pipelineSnapshot?.sequence).toBe(12);
  });

  it("accepts a persisted terminal snapshot after the active run is removed", () => {
    const current = reducer(initialState, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(12, "running"),
    });
    const completed = reducer(current, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: snapshot(0, "completed"),
    });
    expect(completed.pipelineSnapshot?.status).toBe("completed");
  });

  it("keeps active and viewed project snapshots isolated", () => {
    const active = reducer(initialState, {
      type: "SET_ACTIVE_PIPELINE",
      snapshot: snapshot(12, "running"),
    });
    const viewed = reducer(active, {
      type: "SET_PIPELINE_SNAPSHOT",
      snapshot: { ...snapshot(0, "ready"), project_id: "project-2", project_path: "D:\\projects\\project-2" },
    });

    expect(selectActivePipelineSnapshot(viewed)?.project_id).toBe("project-1");
    expect(selectProjectPipelineSnapshot(viewed, "project-2")?.project_id).toBe("project-2");
  });

  it("clears only the active selector when the backend reports no active pipeline", () => {
    const running = reducer(initialState, {
      type: "SET_ACTIVE_PIPELINE",
      snapshot: snapshot(12, "running"),
    });
    const inactive = reducer(running, { type: "SET_ACTIVE_PIPELINE", snapshot: null });

    expect(selectActivePipelineSnapshot(inactive)).toBeNull();
    expect(selectProjectPipelineSnapshot(inactive, "project-1")?.sequence).toBe(12);
  });

  it("records a conflict without replacing either project's snapshot", () => {
    const running = reducer(initialState, {
      type: "SET_ACTIVE_PIPELINE",
      snapshot: snapshot(12, "running"),
    });
    const conflicted = reducer(running, {
      type: "SET_PIPELINE_CONFLICT",
      requestedProjectId: "project-2",
      activeProjectId: "project-1",
    });

    expect(selectPipelineConflict(conflicted, "project-2")).toEqual({
      requestedProjectId: "project-2",
      activeProjectId: "project-1",
    });
    expect(selectActivePipelineSnapshot(conflicted)?.sequence).toBe(12);
  });
});

describe("recent-project availability reducer", () => {
  it("moves from unknown through checking to a terminal result", () => {
    const listed = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects: [project()] });
    expect(listed.projectAvailability["project-1"]).toMatchObject({
      status: "unknown",
      checkedPath: "D:\\projects\\project-1",
      generation: 0,
    });

    const checking = reducer(listed, {
      type: "BEGIN_PROJECT_AVAILABILITY",
      projectId: "project-1",
      projectPath: "D:\\projects\\project-1",
      generation: 1,
    });
    expect(checking.projectAvailability["project-1"].status).toBe("checking");

    const available = reducer(checking, {
      type: "SET_PROJECT_AVAILABILITY",
      generation: 1,
      result: {
        project_id: "project-1",
        checked_path: "D:\\projects\\project-1",
        availability: "available",
        checked_at: "2026-08-14T00:01:00Z",
        reason_code: null,
        refreshed_project: null,
      },
    });
    expect(available.projectAvailability["project-1"]).toMatchObject({
      status: "available",
      checkedAt: "2026-08-14T00:01:00Z",
      generation: 1,
    });
  });

  it("rejects late responses for an old generation or path", () => {
    const oldPath = "D:\\projects\\old";
    const newPath = "D:\\projects\\new";
    const listed = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects: [project("project-1", oldPath)] });
    const checking = reducer(listed, {
      type: "BEGIN_PROJECT_AVAILABILITY",
      projectId: "project-1",
      projectPath: oldPath,
      generation: 2,
    });
    const relinked = reducer(checking, {
      type: "RELINK_RECENT_PROJECT",
      previousPath: oldPath,
      project: project("project-1", newPath),
    });
    const stale = reducer(relinked, {
      type: "SET_PROJECT_AVAILABILITY",
      generation: 2,
      result: {
        project_id: "project-1",
        checked_path: oldPath,
        availability: "missing",
        checked_at: "2026-08-14T00:02:00Z",
        reason_code: "UI-PROJECT-PATH-MISSING",
        refreshed_project: null,
      },
    });
    expect(stale).toBe(relinked);
    expect(stale.projectAvailability["project-1"]).toMatchObject({
      status: "unknown",
      checkedPath: newPath,
      generation: 3,
    });
  });

  it("merges non-regressing refreshed metadata in place while active pipeline lifecycle wins", () => {
    const listed = reducer(initialState, { type: "SET_RECENT_PROJECTS", projects: [project()] });
    const active = reducer(listed, {
      type: "SET_ACTIVE_PIPELINE",
      snapshot: { ...snapshot(9, "running"), state: { stages: {}, current_stage: "BrushTraining", overall_progress: 0.5 } },
    });
    const checking = reducer(active, {
      type: "BEGIN_PROJECT_AVAILABILITY",
      projectId: "project-1",
      projectPath: "D:\\projects\\project-1",
      generation: 1,
    });
    const refreshed = reducer(checking, {
      type: "SET_PROJECT_AVAILABILITY",
      generation: 1,
      result: {
        project_id: "project-1",
        checked_path: "D:\\projects\\project-1",
        availability: "available",
        checked_at: "2026-08-14T00:03:00Z",
        reason_code: null,
        refreshed_project: {
          ...project(),
          name: "磁盘中的新名称",
          status: "completed",
          updated_at: "2026-08-14T00:03:00Z",
          stage_label: "Export",
        },
      },
    });
    expect(refreshed.recentProjects).toHaveLength(1);
    expect(refreshed.recentProjects[0]).toMatchObject({
      name: "磁盘中的新名称",
      status: "running",
      stage_label: "BrushTraining",
      updated_at: "2026-08-14T00:03:00Z",
    });

    const regressed = reducer(refreshed, {
      type: "SET_PROJECT_AVAILABILITY",
      generation: 1,
      result: {
        project_id: "project-1",
        checked_path: "D:\\projects\\project-1",
        availability: "available",
        checked_at: "2026-08-14T00:04:00Z",
        reason_code: null,
        refreshed_project: { ...project(), updated_at: "2026-08-13T00:00:00Z" },
      },
    });
    expect(regressed.recentProjects[0].name).toBe("磁盘中的新名称");
  });

  it("removes availability with a record and invalidates only an exact relink", () => {
    const two = reducer(initialState, {
      type: "SET_RECENT_PROJECTS",
      projects: [project(), project("project-2", "D:\\projects\\project-2")],
    });
    const unchanged = reducer(two, {
      type: "RELINK_RECENT_PROJECT",
      previousPath: "D:\\projects\\stale",
      project: project("project-1", "D:\\projects\\new"),
    });
    expect(unchanged).toBe(two);

    const removed = reducer(two, { type: "REMOVE_RECENT_PROJECT", projectId: "project-1" });
    expect(removed.projectAvailability["project-1"]).toBeUndefined();
    expect(removed.projectAvailability["project-2"]).toBeDefined();
  });
});
