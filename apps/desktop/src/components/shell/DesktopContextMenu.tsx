import { useRef } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { ContextMenu } from "radix-ui";
import { useOverlayContainer } from "@/components/ui/overlay-context";
import { cn } from "@/lib/utils";

/** Pointer-anchored desktop menu, separate from the more-button dropdown. */
export function DesktopContextMenu({ trigger, children, label, open, onOpenChange, onReturnFocus }: {
  trigger: ReactElement;
  children: ReactNode;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus: () => void;
}) {
  const container = useOverlayContainer();
  const restoreFocus = useRef(false);
  return <ContextMenu.Root open={open} onOpenChange={onOpenChange}>
    <ContextMenu.Trigger asChild>{trigger}</ContextMenu.Trigger>
    <ContextMenu.Portal container={container}>
      <ContextMenu.Content
        aria-label={label}
        data-keyboard-overlay="true"
        className="z-50 max-h-(--radix-context-menu-content-available-height) max-w-[min(320px,calc(100vw-32px))] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        onContextMenu={(event) => event.preventDefault()}
        onPointerUpCapture={(event) => {
          // Radix Menu.Item synthesizes .click() for a release over a new item.
          // Opening a context menu must never turn that secondary release into
          // a project action, including Control-click on macOS.
          if (event.button !== 0 || event.ctrlKey) event.preventDefault();
        }}
        onClickCapture={(event) => {
          if (event.button !== 0 || event.ctrlKey) event.preventDefault();
        }}
        onEscapeKeyDown={() => { restoreFocus.current = true; }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          restoreFocus.current = true;
          onOpenChange(false);
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus.current) return;
          event.preventDefault();
          restoreFocus.current = false;
          onReturnFocus();
        }}
      >{children}</ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function DesktopContextMenuItem({ className, ...props }: ComponentProps<typeof ContextMenu.Item>) {
  return <ContextMenu.Item className={cn("relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0", className)} {...props} />;
}

export function DesktopContextMenuSeparator() {
  return <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />;
}
