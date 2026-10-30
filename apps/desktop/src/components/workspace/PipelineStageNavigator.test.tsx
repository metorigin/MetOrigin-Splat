import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PipelineStageId } from "@/types";
import { PipelineStageNavigator } from "./PipelineStageNavigator";

function Navigator({ onSelectStage = vi.fn() }: { onSelectStage?: (stage: PipelineStageId) => void }) {
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [stageFocus, setStageFocus] = useState<PipelineStageId | null>(null);
  return <>
    <PipelineStageNavigator
      pipelineError={null}
      pipelineUpdatedAt={null}
      pipelineState={{ stages: {}, current_stage: null, overall_progress: 0 }}
      expandedPhase={expandedPhase}
      setExpandedPhase={setExpandedPhase}
      currentStage={null}
      stageFocus={stageFocus}
      setStageFocus={setStageFocus}
      selectedStage={null}
      moveStageFocus={vi.fn()}
      onSelectStage={onSelectStage}
    />
    <button type="button">页面其他区域</button>
  </>;
}

describe("stage detail dismissal", () => {
  it("keeps stage actions available and dismisses when the user presses outside", () => {
    const onSelectStage = vi.fn();
    render(<Navigator onSelectStage={onSelectStage} />);
    const trigger = screen.getByRole("button", { name: /^1\./ });
    fireEvent.click(trigger);
    const stage = screen.getByRole("button", { name: /媒体验证|媒体校验/ });
    fireEvent.pointerDown(stage);
    fireEvent.click(stage);
    expect(onSelectStage).toHaveBeenCalledWith("MediaValidation");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "页面其他区域" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("still toggles from the trigger and switches directly to another phase", () => {
    render(<Navigator />);
    const first = screen.getByRole("button", { name: /^1\./ });
    const second = screen.getByRole("button", { name: /^2\./ });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(first);
    fireEvent.pointerDown(second);
    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list")).toHaveAttribute("id", "phase-stage-list-camera");
  });

  it("closes with Escape and returns focus to the phase trigger", () => {
    render(<Navigator />);
    const trigger = screen.getByRole("button", { name: /^1\./ });
    fireEvent.click(trigger);
    const stage = screen.getByRole("button", { name: /媒体验证|媒体校验/ });
    act(() => stage.focus());
    fireEvent.keyDown(stage, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("dismisses when keyboard focus leaves without stealing the new focus", () => {
    render(<Navigator />);
    const trigger = screen.getByRole("button", { name: /^1\./ });
    fireEvent.click(trigger);
    const outside = screen.getByRole("button", { name: "页面其他区域" });
    act(() => outside.focus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(outside).toHaveFocus();
  });
});
