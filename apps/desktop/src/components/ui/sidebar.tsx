/* Adapted from Jan ui/sidebar.tsx at b8d58255baf6d9e870025d3f0c60a5b80a63143b.
 * Copyright 2025 Menlo Research. Apache-2.0; see licenses/jan-LICENSE.
 * Local adaptation: controlled layout, React 19 refs, no store/cookie/hotkey. */
import type { ComponentProps, CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 320;
export const DEFAULT_SIDEBAR_WIDTH = 240;

export function SidebarSurface({ className, ...props }: ComponentProps<"aside">) {
  return <aside data-sidebar="sidebar" className={cn("relative flex min-h-0 shrink-0 flex-col border-r border-border/60 bg-sidebar text-sidebar-foreground", className)} {...props} />;
}

export function SidebarInset({ className, ...props }: ComponentProps<"section">) {
  return <section data-sidebar="inset" className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background", className)} {...props} />;
}

export function SidebarMenuButton({ className, active = false, asChild = false, ...props }: ComponentProps<"button"> & { active?: boolean; asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp type={asChild ? undefined : "button"} data-sidebar="menu-button" data-active={active}
    className={cn("peer/menu-button flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm outline-none ring-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0", className)} {...props} />;
}

/** Jan's 14–20rem width constraint with local pointer capture and keyboard access.
 * No document listeners or persistence; App remains the sole layout owner. */
export function SidebarResizeRail({ width, onWidthChange, onDraggingChange }: {
  width: number; onWidthChange: (width: number) => void; onDraggingChange?: (dragging: boolean) => void;
}) {
  const drag = useRef<{ id: number; startX: number; width: number } | null>(null);
  const draggingCallback = useRef(onDraggingChange);
  draggingCallback.current = onDraggingChange;
  useEffect(() => () => {
    if (drag.current) draggingCallback.current?.(false);
    drag.current = null;
  }, []);
  const clamp = (value: number) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, value));
  const finish = () => { drag.current = null; onDraggingChange?.(false); };
  return <div role="separator" aria-label={t("调整项目栏宽度")} aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH}
    aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={width} tabIndex={0} data-sidebar="rail"
    style={{ touchAction: "none" } as CSSProperties}
    className="absolute inset-y-0 -right-1 z-20 w-2 cursor-ew-resize rounded-full outline-none after:absolute after:inset-y-2 after:left-1/2 after:w-0.5 after:rounded-full hover:after:bg-ring/60 focus-visible:after:bg-ring"
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      drag.current = { id: event.pointerId, startX: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
      onDraggingChange?.(true);
    }}
    onPointerMove={(event) => {
      if (!drag.current || drag.current.id !== event.pointerId) return;
      onWidthChange(clamp(drag.current.width + event.clientX - drag.current.startX));
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      finish();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(event) => {
      const next = event.key === "ArrowLeft" ? width - (event.shiftKey ? 24 : 8)
        : event.key === "ArrowRight" ? width + (event.shiftKey ? 24 : 8)
          : event.key === "Home" ? MIN_SIDEBAR_WIDTH : event.key === "End" ? MAX_SIDEBAR_WIDTH : null;
      if (next === null) return;
      event.preventDefault(); onWidthChange(clamp(next));
    }}
  />;
}
