import { useSyncExternalStore } from "react";

const query = "(max-width: 1120px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
function snapshot() {
  return window.matchMedia?.(query).matches ?? false;
}

export function useCompactWindow() {
  return useSyncExternalStore(subscribe, snapshot);
}
