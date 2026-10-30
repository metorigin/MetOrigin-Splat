import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FramePreviewItem, ProjectInfo } from "../../types";
import { ProjectThumbnail } from "./ProjectThumbnail";

const hook = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useProjectThumbnail", () => ({ useProjectThumbnail: hook }));

const project: ProjectInfo = { id: "scene", name: "院落场景", path: "/captures/courtyard", status: "completed", updated_at: "2026-10-29T10:00:00Z" };
const preview: FramePreviewItem = { relative_path: "frames/000001.jpg", width: 320, height: 180, data_url: "data:image/jpeg;base64,cGhvdG8=" };

describe("ProjectThumbnail", () => {
  beforeEach(() => hook.mockReturnValue({ containerRef: vi.fn(), data: preview, status: "ready" }));

  it("labels the real input image as source material and falls back on decode failure", () => {
    render(<ProjectThumbnail project={project} />);
    const image = screen.getByRole("img", { name: "院落场景的素材预览" });
    expect(image).toHaveAttribute("src", preview.data_url);
    expect(image).toHaveAttribute("width", "320");
    fireEvent.error(image);
    expect(screen.queryByRole("img", { name: "院落场景的素材预览" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "素材预览不可用" })).toBeInTheDocument();
  });

  it("keeps a broken previous image from hiding a new project identity", () => {
    const view = render(<ProjectThumbnail project={project} />);
    fireEvent.error(screen.getByRole("img", { name: "院落场景的素材预览" }));
    const nextPreview = { ...preview, data_url: "data:image/jpeg;base64,bmV3LXBob3Rv" };
    hook.mockReturnValue({ containerRef: vi.fn(), data: nextPreview, status: "ready" });
    view.rerender(<ProjectThumbnail project={{ ...project, path: "/captures/relocated" }} />);
    expect(screen.getByRole("img", { name: "院落场景的素材预览" })).toHaveAttribute("src", nextPreview.data_url);
  });

  it("suppresses any previous photo when the current project location is missing", () => {
    render(<ProjectThumbnail project={project} availability={{ status: "missing", checkedPath: project.path, checkedAt: null, reasonCode: null, generation: 1 }} />);
    expect(screen.queryByRole("img", { name: "院落场景的素材预览" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "项目位置不可用" })).toBeInTheDocument();
  });
});
