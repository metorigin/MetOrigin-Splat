import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactSummary, ColmapQualityDecision } from "@/types";
import { QualityReportDialog } from "./QualityReportDialog";

function artifacts(decision: ColmapQualityDecision | null): ArtifactSummary {
  const item = { relative_path: "colmap/sparse/0", exists: true, validated: true, size_bytes: 1024, updated_at: null, error: null };
  return {
    frames_manifest: item, colmap_result: item, scene_ply: item, output_manifest: item, latest_checkpoint: null,
    registered_images: 0, total_images: 12, sparse_points: 0, mean_reprojection_error: null, splat_count: null, colmap_attempts: [],
    colmap_validation: decision ? {
      passed: decision === "pass", decision, checks: [{ name: "Registered image coverage", passed: decision === "pass", detail: "0 / 12", severity: "Warning" }],
      largest_component_images: 0, largest_component_coverage: 0, largest_missing_segment: 12, automatic_fallbacks_exhausted: true, model_hash: "test-model-identity",
    } : null,
  };
}

const props = () => ({ open: true, busy: false, pipelineBusy: false, onClose: vi.fn(), onConfirm: vi.fn().mockResolvedValue(undefined) });

describe("quality decision presentation and interaction", () => {
  it.each(["pass", "accepted_with_warning", "blocked"] as const)("keeps %s report readable without offering an acceptance action", (decision) => {
    const handlers = props();
    render(<QualityReportDialog {...handlers} artifacts={artifacts(decision)} />);
    const dialog = screen.getByRole("dialog", { name: "质量评估结果" });
    expect(within(dialog).getByText("Registered image coverage")).toBeVisible();
    expect(within(within(dialog).getByRole("region", { name: "质量指标" })).getByText("0 / 12")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "确认风险并继续" })).not.toBeInTheDocument();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("does not infer an accept decision from an absent report (%s)", (value) => {
    const handlers = props();
    render(<QualityReportDialog {...handlers} artifacts={value === null ? null : artifacts(null)} />);
    expect(screen.getByText(/质量报告尚未生成/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认风险并继续" })).not.toBeInTheDocument();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it("offers the guarded callback only for requires_confirmation", () => {
    const handlers = props();
    render(<QualityReportDialog {...handlers} artifacts={artifacts("requires_confirmation")} />);
    fireEvent.click(screen.getByRole("button", { name: "确认风险并继续" }));
    expect(handlers.onConfirm).toHaveBeenCalledOnce();
  });

  it("blocks confirmation and dismissal during an in-flight acceptance", () => {
    const handlers = props();
    render(<QualityReportDialog {...handlers} busy artifacts={artifacts("requires_confirmation")} />);
    const confirm = screen.getByRole("button", { name: "确认风险并继续" });
    const close = screen.getByRole("button", { name: "关闭" });
    expect(confirm).toBeDisabled();
    expect(close).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("blocks continuation while the viewed pipeline is active but permits closing the report", () => {
    const handlers = props();
    render(<QualityReportDialog {...handlers} pipelineBusy artifacts={artifacts("requires_confirmation")} />);
    const confirm = screen.getByRole("button", { name: "确认风险并继续" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});
