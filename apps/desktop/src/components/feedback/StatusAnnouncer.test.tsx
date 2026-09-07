import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusAnnouncer } from "./StatusAnnouncer";

describe("StatusAnnouncer", () => {
  it("keeps the last meaningful message and de-duplicates empty polling updates", async () => {
    const view = render(<StatusAnnouncer message="任务已暂停" />);

    expect(screen.getByRole("status")).toHaveTextContent("任务已暂停");
    view.rerender(<StatusAnnouncer message="" />);
    expect(screen.getByRole("status")).toHaveTextContent("任务已暂停");
    view.rerender(<StatusAnnouncer message="任务已暂停" />);
    expect(screen.getByRole("status")).toHaveTextContent("任务已暂停");

    view.rerender(<StatusAnnouncer message="任务已恢复" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("任务已恢复"));
  });

  it("uses the assertive channel only for blocking feedback", () => {
    render(<StatusAnnouncer message="操作未执行" assertive />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });
});
