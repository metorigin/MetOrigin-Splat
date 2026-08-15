import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type RovingOrientation = "horizontal" | "vertical" | "both";

interface UseRovingFocusOptions {
  itemCount: number;
  orientation?: RovingOrientation;
  initialIndex?: number;
  loop?: boolean;
  isDisabled?: (index: number) => boolean;
  onActivate?: (index: number) => void;
  activateOnFocus?: boolean;
}

function findEnabled(
  start: number,
  direction: 1 | -1,
  count: number,
  loop: boolean,
  isDisabled: (index: number) => boolean,
): number {
  if (count <= 0) return -1;
  let index = start;
  for (let attempts = 0; attempts < count; attempts += 1) {
    if (index < 0 || index >= count) {
      if (!loop) return -1;
      index = (index + count) % count;
    }
    if (!isDisabled(index)) return index;
    index += direction;
  }
  return -1;
}

export function useRovingFocus({
  itemCount,
  orientation = "vertical",
  initialIndex = 0,
  loop = true,
  isDisabled = () => false,
  onActivate,
  activateOnFocus = false,
}: UseRovingFocusOptions) {
  const containerRef = useRef<HTMLElement>(null);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, findEnabled(initialIndex, 1, itemCount, true, isDisabled)),
  );

  const focusIndex = useCallback((index: number) => {
    setActiveIndex(index);
    if (activateOnFocus) onActivate?.(index);
    const element = containerRef.current
      ?.querySelector<HTMLElement>(`[data-roving-index="${index}"]`);
    if (element) element.focus();
    else requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-roving-index="${index}"]`)
        ?.focus();
    });
  }, [activateOnFocus, onActivate]);

  const getItemProps = useCallback(
    (index: number) => ({
      "data-roving-index": index,
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveIndex(index),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        const nextKeys = orientation === "horizontal"
          ? ["ArrowRight"]
          : orientation === "vertical"
            ? ["ArrowDown"]
            : ["ArrowRight", "ArrowDown"];
        const previousKeys = orientation === "horizontal"
          ? ["ArrowLeft"]
          : orientation === "vertical"
            ? ["ArrowUp"]
            : ["ArrowLeft", "ArrowUp"];
        let next = -1;
        if (nextKeys.includes(event.key)) {
          next = findEnabled(index + 1, 1, itemCount, loop, isDisabled);
        } else if (previousKeys.includes(event.key)) {
          next = findEnabled(index - 1, -1, itemCount, loop, isDisabled);
        } else if (event.key === "Home") {
          next = findEnabled(0, 1, itemCount, false, isDisabled);
        } else if (event.key === "End") {
          next = findEnabled(itemCount - 1, -1, itemCount, false, isDisabled);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate?.(index);
          return;
        }
        if (next >= 0) {
          event.preventDefault();
          focusIndex(next);
        }
      },
    }),
    [activeIndex, focusIndex, isDisabled, itemCount, loop, onActivate, orientation],
  );

  return { containerRef, activeIndex, setActiveIndex, focusIndex, getItemProps };
}
