import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

interface UseMenuFocusOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemCount: number;
  isDisabled?: (index: number) => boolean;
}

function findEnabled(
  start: number,
  direction: 1 | -1,
  count: number,
  isDisabled: (index: number) => boolean,
) {
  for (let attempt = 0; attempt < count; attempt += 1) {
    const index = (start + direction * attempt + count) % count;
    if (!isDisabled(index)) return index;
  }
  return -1;
}

export function useMenuFocus({
  open,
  onOpenChange,
  itemCount,
  isDisabled = () => false,
}: UseMenuFocusOptions) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(0);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const focusItem = useCallback((index: number) => {
    const item = menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
    if (item) item.focus();
    else window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`)?.focus();
    });
  }, []);

  const openMenu = useCallback((position: "first" | "last" = "first") => {
    const start = position === "first" ? 0 : Math.max(0, itemCount - 1);
    const direction = position === "first" ? 1 : -1;
    pendingFocus.current = findEnabled(start, direction, itemCount, isDisabled);
    onOpenChangeRef.current(true);
  }, [isDisabled, itemCount]);

  const closeMenu = useCallback((restoreFocus = true) => {
    onOpenChangeRef.current(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open || pendingFocus.current < 0) return;
    focusItem(pendingFocus.current);
  }, [focusItem, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [closeMenu, open]);

  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" ? "last" : "first");
    }
  }, [openMenu]);

  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = Number((document.activeElement as HTMLElement | null)?.dataset.menuIndex ?? -1);
    let next = -1;
    if (event.key === "ArrowDown") next = findEnabled(current + 1, 1, itemCount, isDisabled);
    if (event.key === "ArrowUp") next = findEnabled(current - 1, -1, itemCount, isDisabled);
    if (event.key === "Home") next = findEnabled(0, 1, itemCount, isDisabled);
    if (event.key === "End") next = findEnabled(itemCount - 1, -1, itemCount, isDisabled);
    if (next >= 0) {
      event.preventDefault();
      focusItem(next);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab") {
      triggerRef.current?.focus();
      closeMenu(false);
    }
  }, [closeMenu, focusItem, isDisabled, itemCount]);

  const getItemProps = useCallback((index: number) => ({
    "data-menu-index": index,
    tabIndex: -1,
    role: "menuitem" as const,
  }), []);

  return {
    triggerRef,
    menuRef,
    openMenu,
    closeMenu,
    onTriggerKeyDown,
    onMenuKeyDown,
    getItemProps,
  };
}
