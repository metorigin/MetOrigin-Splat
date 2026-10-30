import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Adds desktop ArrowUp/Tab entry and exit behavior; Radix owns item navigation and focus. */
export function DesktopMenu({ trigger, children, open: controlledOpen, onOpenChange }: {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const openAtEnd = useRef(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next); };
  useEffect(() => {
    if (!open || !openAtEnd.current) return;
    const timer = setTimeout(() => {
      const items = contentRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([data-disabled])");
      items?.[items.length - 1]?.focus();
      openAtEnd.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild onKeyDown={(event) => {
      if (event.key === "ArrowUp") { event.preventDefault(); openAtEnd.current = true; setOpen(true); }
      else openAtEnd.current = false;
    }} onPointerDown={() => { openAtEnd.current = false; }}>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent data-keyboard-overlay="true" ref={contentRef} align="end" className="max-w-[min(320px,calc(100vw-32px))]" onKeyDown={(event) => {
      if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }}>{children}</DropdownMenuContent>
  </DropdownMenu>;
}
