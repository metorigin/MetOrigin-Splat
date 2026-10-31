import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuntimeResources } from "./RuntimeResources";
import type { ResourceMetrics } from "../../types";

const metrics: ResourceMetrics = {
  timestamp: "2026-10-30T12:00:00Z", operating_system: "Windows", cpu_name: null,
  cpu_usage_percent: null, memory_total_bytes: 32 * 1024 ** 3, memory_used_bytes: 16 * 1024 ** 3,
  project_disk_available_bytes: null, disk_path: null, gpu: null, warnings: [],
  memory: { kind: "system", available_bytes: 16 * 1024 ** 3, pressure: null,
    pressure_source: null, swap_total_bytes: null, swap_used_bytes: null },
  processes: [{ pid: 42, role: "webview2", resident_bytes: 1024 ** 3 }],
};

describe("RuntimeResources platform accounting", () => {
  it("shows system RAM separately and keeps unknown Windows adapter budget unknown", () => {
    render(<RuntimeResources metrics={metrics} />);
    const row = screen.getByText("训练设备可用预算").parentElement;
    expect(row).toHaveTextContent("尚未测量");
    expect(screen.getByText("系统可用内存").parentElement).toHaveTextContent("16.0 GiB");
    expect(screen.getByText("WebView2")).toBeInTheDocument();
    expect(screen.queryByText("Metal 建议工作集")).not.toBeInTheDocument();
  });

  it("retains Mac unified memory wording and Metal working set", () => {
    render(<RuntimeResources metrics={{ ...metrics, processes: [], memory: { ...metrics.memory!, kind: "unified" } }} />);
    expect(screen.getByText("Metal 建议工作集")).toBeInTheDocument();
    expect(screen.queryByText("训练设备可用预算")).not.toBeInTheDocument();
    expect(screen.getByText("资源预算是训练策略，不是进程内存硬上限；统一内存由系统、训练和预览共享。")).toBeInTheDocument();
  });
});
