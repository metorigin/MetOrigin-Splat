// Adapted from shadcn/ui (MIT), using the pinned react-resizable-panels v3 API.
import type { ComponentProps } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof PanelGroup>) {
  return <PanelGroup className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)} {...props} />;
}
export const ResizablePanel = Panel;
export function ResizableHandle({ withHandle, className, ...props }: ComponentProps<typeof PanelResizeHandle> & { withHandle?: boolean }) {
  return <PanelResizeHandle className={cn("relative flex w-px shrink-0 items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full", className)} {...props}>
    {withHandle && <span className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border bg-muted"><GripVertical className="size-3" /></span>}
  </PanelResizeHandle>;
}
