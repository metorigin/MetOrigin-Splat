import { useLayoutEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "metorigin.ui.theme";
const CHANGE_EVENT = "metorigin-theme-change";
let fallbackTheme: Theme = "light";

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return fallbackTheme;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
    media?.removeEventListener("change", callback);
  };
}

function snapshot() {
  const theme = readTheme();
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  return `${theme}:${dark ? "dark" : "light"}` as const;
}

export function useTheme() {
  const value = useSyncExternalStore(subscribe, snapshot);
  const [theme, resolvedTheme] = value.split(":") as [Theme, "light" | "dark"];
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);
  const setTheme = (next: Theme) => {
    fallbackTheme = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage may be unavailable in a restricted webview. */ }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return { theme, resolvedTheme, setTheme };
}
