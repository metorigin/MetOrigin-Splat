import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventPage, PipelineEventRecord } from "../../types";
import { desktopApi } from "../../services/desktop";
import { ActivityWorkbench } from "./ActivityWorkbench";
import { mergeActivityEvents } from "./activityEvents";

vi.mock("../../services/desktop", () => ({
  desktopApi: { getPipelineEvents: vi.fn() },
}));

function event(sequence: number, severity: "info" | "warning" | "error" = "info"): PipelineEventRecord {
  return {
    event_id: `event-${sequence}`,
    project_id: "project-1",
    sequence,
    timestamp: `2026-08-14T08:00:${String(sequence).padStart(2, "0")}Z`,
    kind: "stage_progress",
    severity,
    phase_id: "training",
    stage_id: sequence % 2 ? "BrushTraining" : "ModelValidation",
    user_message: `事件 ${sequence}`,
    technical_message: sequence === 2 ? "token=secret C:\\Users\\alice\\private.log" : null,
    metrics: { sequence },
    source_log: null,
  };
}

function page(items: PipelineEventRecord[], nextCursor: number | null = null): EventPage {
  return { items, next_cursor: nextCursor, total: items.length };
}

describe("ActivityWorkbench", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads cursor pages and deterministically de-duplicates 1,000-record histories", async () => {
    const first = Array.from({ length: 800 }, (_, index) => event(index + 201));
    const older = Array.from({ length: 201 }, (_, index) => event(index + 1));
    vi.mocked(desktopApi.getPipelineEvents).mockImplementation(async (_path, query) =>
      query?.cursor === 200 ? page(older, null) : page(first, 200),
    );

    render(<ActivityWorkbench projectPath={"D:\\project"} />);
    expect(await screen.findByText("事件 1000")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));

    await waitFor(() => expect(screen.getByText("事件 1")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /事件 \d+/ })).toHaveLength(1000);
    // Automatic refresh can run while the 1,000 accessible rows are inspected.
    // Verify the pagination request without assuming it remains the latest call.
    expect(desktopApi.getPipelineEvents).toHaveBeenCalledWith(
      "D:\\project",
      expect.objectContaining({ cursor: 200 }),
    );
  });

  it("retains last-good rows on refresh failure and offers a safe retry", async () => {
    vi.mocked(desktopApi.getPipelineEvents)
      .mockResolvedValueOnce(page([event(1)]))
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce(page([event(1), event(2)]));

    render(<ActivityWorkbench projectPath={"D:\\project"} />);
    expect(await screen.findByText("事件 1")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索活动记录" }), { target: { value: "失败" } });
    expect(await screen.findByText(/正在显示最后一次成功获取的数据/)).toBeInTheDocument();
    expect(screen.getByText("事件 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
    expect(await screen.findByText("事件 2")).toBeInTheDocument();
  });

  it("links selected-stage, severity, search, details, and redaction", async () => {
    const onSelectStage = vi.fn();
    vi.mocked(desktopApi.getPipelineEvents).mockResolvedValue(page([event(2, "error")]));
    render(
      <ActivityWorkbench
        projectPath={"D:\\project"}
        selectedStage="ModelValidation"
        onSelectStage={onSelectStage}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /事件 2/ }));
    expect(onSelectStage).toHaveBeenCalledWith("ModelValidation");
    expect(screen.getByLabelText("事件详情")).toHaveTextContent("原始引擎输出已隐藏");
    expect(screen.getByLabelText("事件详情")).not.toHaveTextContent("secret");

    fireEvent.click(screen.getByRole("tab", { name: /错误/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索活动记录" }), { target: { value: "camera" } });
    await waitFor(() => expect(desktopApi.getPipelineEvents).toHaveBeenLastCalledWith(
      "D:\\project",
      expect.objectContaining({ stageId: "ModelValidation", severity: "error", search: "camera" }),
    ));
  });

  it("exposes a complete empty result instead of an indefinite loading state", async () => {
    vi.mocked(desktopApi.getPipelineEvents).mockResolvedValue(page([]));
    render(<ActivityWorkbench projectPath={"D:\\empty"} />);
    expect(await screen.findByText("暂无符合条件的真实事件")).toBeInTheDocument();
  });

  it("uses a single tab stop with automatic arrow activation and linked panels", async () => {
    vi.mocked(desktopApi.getPipelineEvents).mockResolvedValue(page([]));
    render(<ActivityWorkbench projectPath={"D:\\project"} />);
    await screen.findByText("暂无符合条件的真实事件");
    const log = screen.getByRole("tab", { name: "活动日志" });
    const eventTab = screen.getByRole("tab", { name: "事件" });
    log.focus();
    expect(log).toHaveAttribute("tabindex", "0");
    expect(eventTab).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(log, { key: "ArrowRight" });
    expect(eventTab).toHaveFocus();
    expect(eventTab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(eventTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", eventTab.id);
    fireEvent.keyDown(eventTab, { key: "End" });
    expect(screen.getByRole("tab", { name: /错误/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: /错误/ }), { key: "Home" });
    expect(log).toHaveFocus();
  });

  it("redacts canaries and never renders unrelated source logs", async () => {
    const sensitiveEvent: PipelineEventRecord = {
      ...event(9, "error"),
      user_message:
        "处理失败 token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\project\\scene.json",
      technical_message:
        "RAW_ENGINE_OUTPUT_CANARY password=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\engine.log",
      metrics: {
        path: "C:\\Users\\PrivateUser\\metrics.json",
        authorization: "Bearer METORIGIN_TEST_SECRET_DO_NOT_EXPOSE",
      },
      source_log: "UNRELATED_LOG_CANARY C:\\Users\\PrivateUser\\unrelated.log",
    };
    vi.mocked(desktopApi.getPipelineEvents).mockResolvedValue(page([sensitiveEvent]));

    render(<ActivityWorkbench projectPath={"D:\\project"} />);
    const row = await screen.findByRole("button", { name: /处理失败/ });
    fireEvent.click(row);
    const workbench = screen.getByLabelText("Pipeline 活动");

    expect(workbench).not.toHaveTextContent("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(workbench).not.toHaveTextContent("PrivateUser");
    expect(workbench).not.toHaveTextContent("RAW_ENGINE_OUTPUT_CANARY");
    expect(workbench).not.toHaveTextContent("UNRELATED_LOG_CANARY");
    expect(workbench).toHaveTextContent("[REDACTED]");
    expect(workbench).toHaveTextContent("[REDACTED_PATH]");
  });
});

describe("mergeActivityEvents", () => {
  it("orders by sequence and replaces duplicate identities", () => {
    const replacement = { ...event(2), user_message: "更新后的事件 2" };
    const merged = mergeActivityEvents([event(2), event(3)], [event(1), replacement]);
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(merged[1].user_message).toBe("更新后的事件 2");
  });
});
