import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProvider } from "../context";
import { NewProjectPage } from "./NewProjectPage";

const analyzeMedia = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../services/desktop", () => ({
  selectVideoFile: vi.fn().mockResolvedValue("D:\\dataset\\bike.mp4"),
  selectImageDirectory: vi.fn(),
  selectProjectRoot: vi.fn(),
  desktopApi: {
    analyzeMedia: (...args: unknown[]) => analyzeMedia(...args),
    preflightProject: vi.fn(),
    createProject: vi.fn(),
    cancelProjectCreation: vi.fn(),
    startPipeline: vi.fn(),
  },
}));

describe("NewProjectPage", () => {
  beforeEach(() => {
    analyzeMedia.mockResolvedValue({
      source_kind: "video",
      source_path: "D:\\dataset\\bike.mp4",
      display_name: "bike.mp4",
      size_bytes: 1_675_000_000,
      valid: true,
      video_metadata: {
        width: 3840,
        height: 2160,
        fps: 29.97002997,
        frame_count: 3990,
        duration_seconds: 133.135,
        codec: "hevc",
        rotation: null,
      },
      image_set_metadata: null,
      preset_estimates: [
        { id: "fast", name: "Quick Preview", description: "", fps: 2, max_frames: 300, target_long_edge: 1280, iterations: 3000, sh_degree: 0, checkpoint_interval: 500, estimated_frames: 266, estimated_disk_bytes: 85_120_000 },
      ],
      preview_items: [],
      warnings: [],
      blockers: [],
    });
  });

  it("shows real video metadata and Fast estimate after native selection", async () => {
    render(<AppProvider><NewProjectPage /></AppProvider>);
    fireEvent.click(screen.getByRole("button", { name: /选择视频/ }));
    await waitFor(() => expect(screen.getByText("3840 × 2160")).toBeInTheDocument());
    expect(screen.getByText("29.97 fps")).toBeInTheDocument();
    expect(screen.getByText("2 分 13.1 秒")).toBeInTheDocument();
    expect(screen.getByText("HEVC")).toBeInTheDocument();
    expect(screen.getByText(/预计 266 帧/)).toBeInTheDocument();
  });
});
