import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionImpactPreview, ArtifactSummary, EventPage, ImagePreview, MediaAnalysis, PipelineSnapshot, Project, ProjectInfo, ProjectPreflight, WorkspaceActionRequest } from "../types";
import { isUiPreviewMode, resolveUiPreviewCommand } from "./uiPreview";
import { normalizeCommandError } from "./errors";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
  resolveUiPreviewCommand("app_version");
});

describe("development preview action impacts", () => {
  const baseRequest = { projectId: "preview-courtyard-scan", projectPath: "D:\\MetOrigin\\courtyard-scan" };
  function select(status = "completed") {
    window.history.replaceState(null, "", `/?ui-preview&preview-page=workspace&preview-state=${status}`);
  }
  function preview(request: WorkspaceActionRequest): ActionImpactPreview {
    return resolveUiPreviewCommand("preview_workspace_action", { request }) as ActionImpactPreview;
  }
  function failure(command: string, args?: Record<string, unknown>) {
    let cause: unknown;
    try { resolveUiPreviewCommand(command, args); } catch (error) { cause = error; }
    expect(cause).toBeTypeOf("string");
    return normalizeCommandError(cause, command);
  }

  it("returns no invented project photograph and validates preview thumbnail identity", () => {
    select();
    expect(resolveUiPreviewCommand("get_project_thumbnail", baseRequest)).toBeNull();
    expect(() => resolveUiPreviewCommand("get_project_thumbnail", { ...baseRequest, projectId: "another-project" })).toThrow("identity");
    expect(() => resolveUiPreviewCommand("get_project_thumbnail", { ...baseRequest, projectPath: "D:\\missing" })).toThrow("does not provide project");
  });

  it.each(["pause", "cancel", "rerun_stage", "restore_checkpoint", "delete_checkpoint", "delete_project"] as const)("provides the real impact shape for %s without changing a project", (action) => {
    select(action === "pause" || action === "cancel" ? "running" : "completed");
    const project = resolveUiPreviewCommand("open_project", { path: baseRequest.projectPath });
    const result = preview({ ...baseRequest, action, ...(action === "rerun_stage" ? { stageId: "BrushTraining" } : {}), ...(["restore_checkpoint", "delete_checkpoint"].includes(action) ? { checkpointIteration: 15_000 } : {}) });
    expect(result).toMatchObject({ action, allowed: true, blockedReason: null });
    expect(result.targetLabel).toContain("Courtyard Scan");
    expect(result.previewToken).toMatch(new RegExp(`^ui-preview-only:${baseRequest.projectId}:${action}:`));
    expect(result.preserved.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("示例数据");
    expect(Array.isArray(result.invalidated)).toBe(true);
    expect(Array.isArray(result.regenerated)).toBe(true);
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(5 * 60_000);
    expect(resolveUiPreviewCommand("open_project", { path: baseRequest.projectPath })).toEqual(project);
  });

  it("rejects missing or mismatched project identity and malformed action targets", () => {
    select();
    for (const request of [
      { projectId: baseRequest.projectId, action: "cancel" },
      { ...baseRequest, projectPath: null, action: "cancel" },
      { ...baseRequest, projectId: "preview-museum-hall", action: "cancel" },
      { ...baseRequest, action: "unknown_action" },
      { ...baseRequest, action: "rerun_stage" },
      { ...baseRequest, action: "rerun_stage", stageId: "UnknownStage" },
      { ...baseRequest, action: "restore_checkpoint", checkpointIteration: -1 },
      { ...baseRequest, action: "delete_checkpoint", checkpointIteration: 1.5 },
      { ...baseRequest, action: "cancel", checkpointIteration: 15_000 },
    ]) expect(failure("preview_workspace_action", { request }).retryable).toBe(false);
    expect(() => preview({ ...baseRequest, projectPath: "D:\\missing", action: "cancel" })).toThrow("does not provide project");
  });

  it("keeps active-project isolation and current-checkpoint protection visible", () => {
    select("running");
    const museum = { projectId: "preview-museum-hall", projectPath: "D:\\MetOrigin\\museum-hall", action: "cancel" as const };
    expect(preview(museum)).toMatchObject({ allowed: false, blockedReason: "该项目当前没有活动处理任务。" });
    expect(preview({ ...baseRequest, action: "rerun_stage", stageId: "BrushTraining" })).toMatchObject({ allowed: false });
    select();
    expect(preview({ ...baseRequest, action: "delete_checkpoint", checkpointIteration: 20_000 })).toMatchObject({ allowed: false, irreversible: true, blockedReason: "不能删除当前使用或唯一合法的 Checkpoint。" });
    expect(preview({ ...baseRequest, action: "restore_checkpoint", checkpointIteration: 99_999 })).toMatchObject({ allowed: false, blockedReason: "未找到指定 Checkpoint。" });
  });

  it("never executes fixture actions and rejects reused, expired or cross-session tokens", () => {
    select("running");
    const request = { ...baseRequest, action: "cancel" as const };
    const before = resolveUiPreviewCommand("get_active_pipeline_summary");
    const first = preview(request);
    const second = preview(request);
    expect(first.previewToken).not.toBe(second.previewToken);
    expect(failure("execute_workspace_action", { previewToken: first.previewToken })).toMatchObject({ code: "UI-PREVIEW-EXECUTION-DISABLED", retryable: false });
    expect(failure("execute_workspace_action", { previewToken: first.previewToken }).code).toBe("UI-ACTION-PREVIEW-INVALID");
    expect(resolveUiPreviewCommand("get_active_pipeline_summary")).toEqual(before);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(second.expiresAt) + 1);
    expect(failure("execute_workspace_action", { previewToken: second.previewToken }).code).toBe("UI-ACTION-PREVIEW-EXPIRED");
    const third = preview(request);
    select("paused");
    expect(failure("execute_workspace_action", { previewToken: third.previewToken }).code).toBe("UI-ACTION-PREVIEW-INVALID");
    expect(failure("execute_workspace_action", { previewToken: "real-looking-backend-token" }).code).toBe("UI-ACTION-PREVIEW-INVALID");
  });

  it("exposes no action preview handler outside the development preview gate", () => {
    const request = { ...baseRequest, action: "cancel" as const };
    expect(() => preview(request)).toThrow("requires development preview mode");
    select("running");
    vi.stubEnv("DEV", false);
    expect(() => preview(request)).toThrow("requires development preview mode");
  });
});

describe("UI preview project identity", () => {
  it("opens every listed project with matching identity and pipeline instead of overwriting Courtyard", () => {
    const projects = resolveUiPreviewCommand("list_recent_project_index") as ProjectInfo[];
    for (const project of projects) {
      const opened = resolveUiPreviewCommand("open_project", { path: project.path }) as Project;
      const snapshot = resolveUiPreviewCommand("get_pipeline_state", { projectPath: project.path }) as PipelineSnapshot;
      expect(opened).toMatchObject({ id: project.id, name: project.name, status: project.status, updated_at: project.updated_at });
      expect(snapshot).toMatchObject({ project_id: project.id, project_path: project.path, status: project.status });
      expect(opened.pipeline_state).toEqual(snapshot.state);
      expect(opened.current_stage).toBe(project.stage_label);
      if (project.status === "completed") {
        expect(snapshot.state.overall_progress).toBe(1);
        expect(Object.values(snapshot.state.stages).every((stage) => stage.status === "completed")).toBe(true);
      }
      if (project.status === "ready") {
        expect(snapshot.state.overall_progress).toBe(0);
        expect(Object.values(snapshot.state.stages).every((stage) => stage.status === "pending")).toBe(true);
      }
    }
    expect(resolveUiPreviewCommand("list_recent_project_index")).toEqual(projects);
  });

  it.each(["running", "paused", "completed", "failed"])("keeps preview-state=%s scoped to Courtyard and the active summary", (status) => {
    window.history.replaceState(null, "", `/?ui-preview&preview-state=${status}`);
    const projects = resolveUiPreviewCommand("list_recent_project_index") as ProjectInfo[];
    const primary = projects[0];
    const museum = projects.find((project) => project.name === "Museum Hall")!;
    const opened = resolveUiPreviewCommand("open_project", { path: primary.path }) as Project;
    const activeBefore = resolveUiPreviewCommand("get_active_pipeline_summary") as PipelineSnapshot;
    expect(opened.status).toBe(status);
    expect(opened.pipeline_state).toEqual(activeBefore.state);
    expect(activeBefore).toMatchObject({ project_id: primary.id, project_path: primary.path, status });
    const museumProject = resolveUiPreviewCommand("open_project", { path: museum.path }) as Project;
    const museumPipeline = resolveUiPreviewCommand("get_pipeline_state", { projectPath: museum.path }) as PipelineSnapshot;
    expect(museumProject).toMatchObject({ id: museum.id, name: museum.name, status: "completed" });
    expect(museumPipeline.project_id).toBe(museum.id);
    expect(resolveUiPreviewCommand("get_active_pipeline_summary")).toEqual(activeBefore);
    expect(resolveUiPreviewCommand("get_pipeline_state", { projectPath: null })).toEqual(activeBefore);
  });

  it("keeps the new-project preview free of an active pipeline", () => {
    window.history.replaceState(null, "", "/?ui-preview&preview-page=new-project");
    expect(resolveUiPreviewCommand("get_active_pipeline_summary")).toBeNull();
  });

  it("does not silently open a different fixture for an unknown explicit project path", () => {
    expect(() => resolveUiPreviewCommand("open_project", { path: "D:\\missing" })).toThrow("UI preview does not provide project");
    expect(() => resolveUiPreviewCommand("get_pipeline_state", { projectPath: "D:\\missing" })).toThrow("UI preview does not provide project");
  });

  it("rejects an unknown or mismatched availability identity instead of returning Courtyard", () => {
    expect(() => resolveUiPreviewCommand("check_recent_project_availability", { projectId: "unknown" })).toThrow("requested project identity");
    expect(() => resolveUiPreviewCommand("check_recent_project_availability", { projectId: "preview-museum-hall", projectPath: "D:\\missing" })).toThrow("requested project identity");
  });
});

const videoPath = "D:\\Captures\\courtyard_walkthrough.mp4";
const imagesPath = "D:\\Captures\\courtyard_images";
const fixturePath = "D:\\MetOrigin\\courtyard-scan";

describe("UI preview source kind", () => {
  it("analyzes selected images with their own path and image metadata, without video metadata", () => {
    const images = resolveUiPreviewCommand("analyze_media", { path: imagesPath }) as MediaAnalysis;
    const video = resolveUiPreviewCommand("analyze_media", { path: videoPath }) as MediaAnalysis;
    expect(images).toMatchObject({ source_kind: "images", source_path: imagesPath, display_name: "courtyard_images", video_metadata: null });
    expect(images.image_set_metadata?.image_count).toBe(286);
    expect(video).toMatchObject({ source_kind: "video", source_path: videoPath, image_set_metadata: null });
    expect(video.video_metadata?.frame_count).toBe(1846);
    const preflight = resolveUiPreviewCommand("preflight_project", { request: { sourcePath: imagesPath, preset: "quality" } }) as ProjectPreflight;
    expect(preflight.estimated_frames).toBe(286);
    expect(preflight.estimated_frames).toBe(images.preset_estimates.find((item) => item.id === "quality")!.estimated_frames);
  });

  it("provides only offline synthetic PNG thumbnails for the matching image source", () => {
    const images = resolveUiPreviewCommand("get_image_previews", { path: imagesPath }) as ImagePreview[];
    expect(images).toHaveLength(6);
    expect(new Set(images.map((item) => item.relative_path)).size).toBe(6);
    for (const thumbnail of images) {
      expect(thumbnail.data_url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      expect(thumbnail.display_name).toContain("示例数据");
      expect(thumbnail).toMatchObject({ width: 96, height: 64 });
    }
    expect(resolveUiPreviewCommand("get_image_previews", { path: videoPath })).toEqual([]);
    expect(() => resolveUiPreviewCommand("analyze_media", { path: "D:\\unknown-images" })).toThrow("does not provide media");
    expect(() => resolveUiPreviewCommand("get_image_previews", { path: "D:\\unknown-images" })).toThrow("does not provide media");
  });
});

describe("development preview visual scenarios", () => {
  function select(scenario: string) {
    window.history.replaceState(null, "", `/?ui-preview&preview-scenario=${scenario}`);
  }
  function normalizedFailure(command: string, args?: Record<string, unknown>) {
    let failure: unknown;
    try { resolveUiPreviewCommand(command, args); } catch (cause) { failure = cause; }
    expect(failure).toBeTypeOf("string");
    return normalizeCommandError(failure, command);
  }

  it("ignores scenario values without the preview marker, in production, or outside the allowlist", () => {
    window.history.replaceState(null, "", "/?preview-scenario=engines-error");
    expect(isUiPreviewMode()).toBe(false);
    expect(resolveUiPreviewCommand("check_engines")).toBeInstanceOf(Array);
    select("unknown-value");
    expect(resolveUiPreviewCommand("check_engines")).toBeInstanceOf(Array);
    select("engines-error");
    vi.stubEnv("DEV", false);
    expect(isUiPreviewMode()).toBe(false);
    expect(resolveUiPreviewCommand("check_engines")).toBeInstanceOf(Array);
  });

  it("shows a repeatable structured engine error and keeps project reads intact", () => {
    select("engines-error");
    for (let retry = 0; retry < 2; retry++) {
      const error = normalizedFailure("check_engines");
      expect(error).toMatchObject({ code: "UI-PREVIEW-ENGINES-ERROR", retryable: true });
      expect(error.message).toContain("示例数据");
    }
    expect(resolveUiPreviewCommand("open_project", { path: fixturePath })).toMatchObject({ id: "preview-courtyard-scan" });
  });

  it("installs valid StrictMode warm-up results per project before failing later refreshes without mutating them", () => {
    select("workspace-stale");
    const first = resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath }) as ArtifactSummary;
    const original = JSON.stringify(first);
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath })).toEqual(first);
    expect(normalizedFailure("get_project_artifacts", { projectPath: fixturePath })).toMatchObject({ code: "UI-PREVIEW-ARTIFACTS-STALE", retryable: true });
    expect(JSON.stringify(first)).toBe(original);
    expect(normalizedFailure("get_pipeline_state", { projectPath: fixturePath }).code).toBe("UI-PREVIEW-PIPELINE-STALE");
    const museumPath = "D:\\MetOrigin\\museum-hall";
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: museumPath })).toMatchObject({ registered_images: 281 });
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: museumPath })).toMatchObject({ registered_images: 281 });
    expect(normalizedFailure("get_project_artifacts", { projectPath: museumPath }).code).toBe("UI-PREVIEW-ARTIFACTS-STALE");
    expect(resolveUiPreviewCommand("open_project", { path: museumPath })).toMatchObject({ id: "preview-museum-hall", status: "completed" });
    window.history.replaceState(null, "", "/?ui-preview");
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath })).toEqual(first);
    select("workspace-stale");
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath })).toEqual(first);
  });

  it("shows an activity read failure rather than inventing an empty successful event list", () => {
    select("activity-error");
    expect(normalizedFailure("get_pipeline_events", { projectPath: fixturePath })).toMatchObject({ code: "UI-PREVIEW-ACTIVITY-ERROR", retryable: true });
    window.history.replaceState(null, "", "/?ui-preview");
    const events = resolveUiPreviewCommand("get_pipeline_events", { projectPath: "D:\\MetOrigin\\museum-hall" }) as EventPage;
    expect(events.items.every((event) => event.project_id === "preview-museum-hall")).toBe(true);
  });

  it("keeps empty checkpoints consistent with the artifact summary", () => {
    select("checkpoints-empty");
    expect(resolveUiPreviewCommand("list_checkpoints", { projectPath: fixturePath })).toEqual([]);
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath })).toMatchObject({ latest_checkpoint: null });
  });

  it.each([['quality-confirmation', 'requires_confirmation'], ['quality-blocked', 'blocked']] as const)("provides %s only as labeled visual data and never performs risk acceptance", (scenario, decision) => {
    select(scenario);
    const report = resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath }) as ArtifactSummary;
    expect(report.colmap_validation?.decision).toBe(decision);
    expect(report.colmap_validation?.checks.every((check) => check.detail.includes("示例数据"))).toBe(true);
    expect(report.registered_images).toBe(report.colmap_validation?.largest_component_images);
    expect(() => resolveUiPreviewCommand("accept_colmap_quality_risk", { projectPath: fixturePath })).toThrow("does not provide command");
    expect(resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath })).toEqual(report);
    expect(() => resolveUiPreviewCommand("get_project_artifacts", { projectPath: "D:\\unknown-project" })).toThrow("does not provide project");
    window.history.replaceState(null, "", `/?preview-scenario=${scenario}`);
    expect((resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath }) as ArtifactSummary).colmap_validation).toBeNull();
    select(scenario);
    vi.stubEnv("DEV", false);
    expect((resolveUiPreviewCommand("get_project_artifacts", { projectPath: fixturePath }) as ArtifactSummary).colmap_validation).toBeNull();
  });

  it("returns a blocked preflight while retaining the selected image source estimates", () => {
    select("preflight-blocked");
    const result = resolveUiPreviewCommand("preflight_project", { request: { sourcePath: imagesPath, preset: "quality" } }) as ProjectPreflight;
    expect(result.can_continue).toBe(false);
    expect(result.blockers[0]).toContain("示例数据");
    expect(result.engine_checks.find((engine) => engine.name === "COLMAP")?.available).toBe(false);
    expect(result.estimated_frames).toBe(286);
    expect(result.available_disk_bytes).toBeLessThan(result.estimated_disk_bytes);
  });

  it.each(["get_project_artifacts", "list_checkpoints", "get_pipeline_events"])("does not hide an unknown path behind %s scenarios", (command) => {
    select("workspace-stale");
    expect(() => resolveUiPreviewCommand(command, { projectPath: "D:\\unknown-project" })).toThrow("does not provide project");
  });
});
