import { describe, expect, it } from "vitest";

import type { PipelineState, StageState } from "../types";
import { phaseStatus, plyActionState, stageStatusLabel } from "./projectTimeline";

function stage(stageId: StageState["stage_id"], status: StageState["status"], progress = 0): StageState {
  return {
    stage_id: stageId,
    status,
    progress,
    started_at: null,
    ended_at: null,
    retry_count: 0,
    error: null,
    log_path: null,
  };
}

const mediaPhase = {
  id: "media",
  label: "素材准备",
  description: "",
  stages: ["MediaValidation", "FrameExtraction", "ImagePreprocessing"] as const,
};

describe("project timeline status", () => {
  it("marks a phase running when frame extraction is active", () => {
    const state: PipelineState = {
      stages: {
        MediaValidation: stage("MediaValidation", "completed", 1),
        FrameExtraction: stage("FrameExtraction", "running", 0.57),
        ImagePreprocessing: stage("ImagePreprocessing", "pending"),
      },
      current_stage: "FrameExtraction",
      overall_progress: 0.04,
    };
    expect(phaseStatus(state, { ...mediaPhase, stages: [...mediaPhase.stages] })).toBe("running");
    expect(stageStatusLabel("running", 0.57)).toBe("运行中 · 57%");
  });

  it("treats completed and cached stages as a completed phase", () => {
    const state: PipelineState = {
      stages: {
        MediaValidation: stage("MediaValidation", "completed", 1),
        FrameExtraction: stage("FrameExtraction", "skipped", 1),
        ImagePreprocessing: stage("ImagePreprocessing", "completed", 1),
      },
      current_stage: null,
      overall_progress: 0.08,
    };
    expect(phaseStatus(state, { ...mediaPhase, stages: [...mediaPhase.stages] })).toBe("completed");
  });
});

describe("PLY quality action", () => {
  it("explains missing and invalid PLY states", () => {
    expect(plyActionState(null).ready).toBe(false);
    expect(plyActionState({
      relative_path: "output/scene.ply",
      exists: true,
      validated: false,
      size_bytes: 10,
      updated_at: null,
      error: "文件损坏",
    })).toEqual({ ready: false, message: "文件损坏" });
  });

  it("enables a validated PLY", () => {
    expect(plyActionState({
      relative_path: "output/scene.ply",
      exists: true,
      validated: true,
      size_bytes: 10,
      updated_at: null,
      error: null,
    }).ready).toBe(true);
  });
});
