import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSidebar } from "./ProjectSidebar";

const noop = vi.fn();

describe("ProjectSidebar", () => {
  it("keeps the project name and uses a compact lifecycle status", () => {
    const longName = "20260701_C0115_自行车超长项目名称用于验证侧栏不会挤压名称";
    render(
      <ProjectSidebar
        projects={[{
          id: "project-1",
          name: longName,
          path: "D:\\projects\\bike.splat-project",
          status: "running",
          stage_label: "ColmapFeatureExtraction",
          updated_at: "2026-07-14T00:00:00Z",
        }]}
        activeProjectPath={null}
        collapsed={false}
        onToggle={noop}
        onHome={noop}
        onNewProject={noop}
        onOpenProject={noop}
        onSelectProject={noop}
        onRevealProject={noop}
        onRemoveProject={noop}
        onDeleteProject={noop}
      />,
    );

    const name = screen.getByText(longName);
    expect(name).toHaveClass("project-row-title");
    expect(name).toHaveAttribute("title", longName);
    expect(screen.getByText("运行中")).toHaveAttribute("title", expect.stringContaining("COLMAP"));
    expect(screen.queryByText("COLMAP 特征提取")).not.toBeInTheDocument();
  });
});
