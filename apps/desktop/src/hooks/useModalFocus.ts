import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const modalStack: string[] = [];
const inertStates = new Map<
  HTMLElement,
  { count: number; inert: boolean; ariaHidden: string | null }
>();

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function acquireInert(element: HTMLElement) {
  const existing = inertStates.get(element);
  if (existing) {
    existing.count += 1;
    return;
  }
  inertStates.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function releaseInert(element: HTMLElement) {
  const state = inertStates.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
  inertStates.delete(element);
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

interface UseModalFocusOptions {
  id: string;
  containerRef: RefObject<HTMLElement>;
  host: HTMLElement;
  busy: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFallbackId?: string;
}

export function useModalFocus({
  id,
  containerRef,
  host,
  busy,
  onClose,
  initialFocusRef,
  returnFallbackId,
}: UseModalFocusOptions) {
  const openerRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!busy) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.hasAttribute("disabled") || !containerRef.current?.contains(active)) {
      containerRef.current?.focus();
    }
  }, [busy, containerRef]);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    modalStack.push(id);
    const backgrounds = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== host,
    );
    backgrounds.forEach(acquireInert);

    const container = containerRef.current;
    const initial = initialFocusRef?.current ?? (container ? getFocusable(container)[0] : null);
    (initial ?? container)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;
      const current = containerRef.current;
      if (!current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable(current);
      if (focusable.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const atEnd = activeIndex === focusable.length - 1;
      const atStart = activeIndex <= 0;
      if ((!event.shiftKey && atEnd) || (event.shiftKey && atStart)) {
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      const stackIndex = modalStack.lastIndexOf(id);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      backgrounds.forEach(releaseInert);
      const opener = openerRef.current;
      const fallback = returnFallbackId
        ? document.getElementById(returnFallbackId)
        : null;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.hasAttribute("disabled")) opener.focus();
        else fallback?.focus();
      });
    };
  }, [containerRef, host, id, initialFocusRef, returnFallbackId]);
}
