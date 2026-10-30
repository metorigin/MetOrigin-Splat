import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSidebar } from "./ProjectSidebar";

const noop = vi.fn();

describe("ProjectSidebar", () => {
  it("marks the project hub current only when no project is active", () => {
    const view = render(
      <ProjectSidebar
        activeProjectPath={null}
        collapsed={false}
        onHome={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "项目中心" })).toHaveAttribute("aria-current", "page");

    view.rerender(<ProjectSidebar activeProjectPath="D:\\projects\\bike.splat-project" collapsed={false} onHome={noop} />);

    expect(screen.getByRole("button", { name: "项目中心" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("textbox", { name: "按项目名称或路径搜索" })).not.toBeInTheDocument();
  });

  it("keeps only a single project hub entry and settings without a recent-project section", () => {
    const onHome = vi.fn();
    const onOpenSettings = vi.fn();
    render(<ProjectSidebar
      activeProjectPath={null}
      collapsed={false}
      onHome={onHome}
      onOpenSettings={onOpenSettings}
    />);

    expect(screen.queryByText("MetOrigin Splat")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回项目库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "项目中心" })).toHaveLength(1);
    expect(screen.queryByText("最近项目")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "项目中心" }));
    expect(onHome).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "设置与引擎" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
