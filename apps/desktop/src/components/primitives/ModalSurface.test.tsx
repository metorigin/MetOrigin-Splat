import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModalSurface } from "./ModalSurface";

function Harness({ busy = false, onClose = vi.fn() }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="background">
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {open ? (
        <ModalSurface
          id="test-dialog"
          title="测试对话框"
          busy={busy}
          initialFocusRef={cancelRef}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button" ref={cancelRef}>取消</button>
          <button type="button">确认</button>
        </ModalSurface>
      ) : null}
    </div>
  );
}

function NestedHarness({ onOuterClose, onInnerClose }: { onOuterClose: () => void; onInnerClose: () => void }) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return <>
    <button type="button" onClick={() => setOuter(true)}>打开外层</button>
    {outer ? <ModalSurface id="outer-dialog" title="外层" onClose={() => { onOuterClose(); setOuter(false); }}>
      <button type="button" onClick={() => setInner(true)}>打开内层</button>
      {inner ? <ModalSurface id="inner-dialog" title="内层" onClose={() => { onInnerClose(); setInner(false); }}>
        <button type="button">内层操作</button>
      </ModalSurface> : null}
    </ModalSurface> : null}
  </>;
}

describe("ModalSurface", () => {
  it("focuses the safe target, traps Tab in both directions, and inerts background", async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toHaveFocus());
    expect(view.container).toHaveAttribute("aria-hidden", "true");

    const confirm = screen.getByRole("button", { name: "确认" });
    confirm.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("closes only the topmost non-busy surface with Escape and restores its opener", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps a busy surface open and focusable", async () => {
    const onClose = vi.fn();
    render(<Harness busy onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-busy", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("restores inert state after unmount", async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() => expect(view.container).toHaveAttribute("aria-hidden", "true"));

    view.unmount();
    expect(view.container).not.toHaveAttribute("aria-hidden", "true");
  });

  it("lets only the topmost nested surface consume Escape", async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(<NestedHarness onOuterClose={outerClose} onInnerClose={innerClose} />);
    fireEvent.click(screen.getByRole("button", { name: "打开外层" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开内层" }));
    expect(await screen.findByRole("dialog", { name: "内层" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "外层" })).toBeInTheDocument();
  });
});
