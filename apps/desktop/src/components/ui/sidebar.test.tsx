import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarResizeRail } from "./sidebar";

function pointer(node: HTMLElement, type: string, clientX: number, pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(node, event);
}

function capture(node: HTMLElement) {
  Object.assign(node, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
}

describe("controlled sidebar resizing", () => {
  it("supports keyboard adjustment and clamps both limits", () => {
    function Harness() {
      const [width, setWidth] = useState(240);
      return <SidebarResizeRail width={width} onWidthChange={setWidth} />;
    }
    render(<Harness />);
    const rail = screen.getByRole("separator", { name: "调整项目栏宽度" });
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(rail).toHaveAttribute("aria-valuenow", "248");
    fireEvent.keyDown(rail, { key: "ArrowLeft", shiftKey: true });
    expect(rail).toHaveAttribute("aria-valuenow", "224");
    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(rail).toHaveAttribute("aria-valuenow", "224");
    fireEvent.keyDown(rail, { key: "End" });
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(rail).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(rail, { key: "Home" });
    expect(rail).toHaveAttribute("aria-valuenow", "224");
  });

  it("captures a single drag, ignores other pointers and finishes on release", () => {
    const change = vi.fn();
    const dragging = vi.fn();
    render(<SidebarResizeRail width={240} onWidthChange={change} onDraggingChange={dragging} />);
    const rail = screen.getByRole("separator");
    capture(rail);
    pointer(rail, "pointerdown", 240);
    pointer(rail, "pointerdown", 100, 9);
    pointer(rail, "pointermove", 500, 9);
    expect(change).not.toHaveBeenCalled();
    pointer(rail, "pointermove", 500);
    expect(change).toHaveBeenLastCalledWith(320);
    pointer(rail, "pointermove", 100);
    expect(change).toHaveBeenLastCalledWith(224);
    pointer(rail, "pointerup", 100);
    expect(dragging.mock.calls).toEqual([[true], [false]]);
    const count = change.mock.calls.length;
    pointer(rail, "pointermove", 280);
    expect(change).toHaveBeenCalledTimes(count);
  });

  it("restores iframe interaction when a dragging rail unmounts using the latest callback", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<SidebarResizeRail width={240} onWidthChange={vi.fn()} onDraggingChange={first} />);
    const rail = screen.getByRole("separator");
    capture(rail);
    pointer(rail, "pointerdown", 240);
    view.rerender(<SidebarResizeRail width={250} onWidthChange={vi.fn()} onDraggingChange={latest} />);
    expect(first.mock.calls).toEqual([[true]]);
    expect(latest).not.toHaveBeenCalled();
    view.unmount();
    expect(latest).toHaveBeenCalledWith(false);
  });
});
