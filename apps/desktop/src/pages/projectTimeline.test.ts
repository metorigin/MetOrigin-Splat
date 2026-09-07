import { describe, expect, it } from "vitest";
import { failedStageId, phaseProgressPercent, PHASES } from "./projectTimeline";
import type { PipelineState, StageState } from "../types";

function stage(stage_id: StageState["stage_id"], status: StageState["status"], progress: number): StageState {
  return { stage_id, status, progress, started_at: null, ended_at: null, error: null, retry_count: 0, log_path: null };
}

describe("measured phase progress", () => {
  it("combines cached work with actual partial progress", () => {
    const state: PipelineState = { current_stage: "FrameExtraction", overall_progress: .1, stages: {
      MediaValidation: stage("MediaValidation", "skipped", 0),
      FrameExtraction: stage("FrameExtraction", "running", .5),
      ImagePreprocessing: stage("ImagePreprocessing", "pending", 0),
    } };
    expect(phaseProgressPercent(state, PHASES[0])).toBe(50);
  });

  it("never presents invalid or missing progress as a measurement", () => {
    const state: PipelineState = { current_stage: null, overall_progress: 0, stages: {
      MediaValidation: stage("MediaValidation", "failed", Number.NaN),
      FrameExtraction: stage("FrameExtraction", "pending", -1),
    } };
    expect(phaseProgressPercent(state, PHASES[0])).toBe(0);
    expect(failedStageId(state)).toBe("MediaValidation");
    expect(failedStageId(null)).toBeNull();
  });
});
