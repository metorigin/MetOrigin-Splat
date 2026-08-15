import { describe, expect, it } from "vitest";

import type { PipelineSnapshot, ProjectInfo } from "../types";
import {
  initialState,
  reducer,
  selectActivePipelineSnapshot,
  selectPipelineConflict,
  selectProjectPipelineSnapshot,
} from "./appContextValue";

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
