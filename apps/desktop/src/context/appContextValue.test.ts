import { describe, expect, it } from "vitest";

import type { PipelineSnapshot } from "../types";
import { initialState, reducer } from "./appContextValue";

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
});
