import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { OverlayContainerContext } from "@/components/ui/overlay-context";
import { cn } from "@/lib/utils";

interface ModalSurfaceProps {
  id: string;
  title: string;
  titleHidden?: boolean;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFallbackId?: string;
  closeOnBackdrop?: boolean;
  ariaDescribedBy?: string;
}

/** Radix owns the focus trap; task safety and return-focus policy stay here. */
export function ModalSurface({ id, title, titleHidden = false, children, onClose, busy = false,
  role = "dialog", className, initialFocusRef, returnFallbackId, closeOnBackdrop = true, ariaDescribedBy,
}: ModalSurfaceProps) {
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const attachContent = useCallback((node: HTMLDivElement | null) => { contentRef.current = node; setContainer(node); }, []);

  useLayoutEffect(() => {
    if (!busy) return;
    const active = document.activeElement;
    if (!active || active.hasAttribute("disabled") || !contentRef.current?.contains(active)) contentRef.current?.focus();
  }, [busy]);

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      ref={attachContent}
      id={id}
      role={role}
      data-keyboard-overlay="true"
      data-modal-host={id}
      aria-busy={busy || undefined}
      aria-describedby={ariaDescribedBy}
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      showCloseButton={false}
      className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-auto bg-card text-card-foreground sm:max-w-none", className)}
      onOpenAutoFocus={(event) => {
        if (busy) { event.preventDefault(); contentRef.current?.focus(); }
        else if (initialFocusRef?.current && !initialFocusRef.current.hasAttribute("disabled")) { event.preventDefault(); initialFocusRef.current.focus(); }
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestAnimationFrame(() => {
          const target = opener?.isConnected && !opener.hasAttribute("disabled") ? opener : returnFallbackId ? document.getElementById(returnFallbackId) : null;
          target?.focus();
        });
      }}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      onPointerDownOutside={(event) => { if (busy || !closeOnBackdrop || role === "alertdialog") event.preventDefault(); }}
      onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
    >
      <DialogTitle id={`${id}-title`} className={titleHidden ? "sr-only" : undefined}>{title}</DialogTitle>
      <OverlayContainerContext.Provider value={container ?? undefined}>{children}</OverlayContainerContext.Provider>
    </DialogContent>
  </Dialog>;
}
