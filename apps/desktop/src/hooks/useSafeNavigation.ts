import { useCallback, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action, AppState, Page } from "../context/appContextValue";

/** Navigation waits for the existing editor leave/save guard before changing page history. */
export function useSafeNavigation({ state, dispatch, leaveEditor }: {
  state: Pick<AppState, "page" | "navigationIndex" | "navigationHistory">;
  dispatch: Dispatch<Action>;
  leaveEditor: () => Promise<boolean>;
}) {
  const [historyNavigating, setHistoryNavigating] = useState(false);
  const historyNavigationPending = useRef(false);
  const navigate = useCallback(async (page: Page) => {
    if (await leaveEditor()) dispatch({ type: "NAVIGATE", page });
  }, [dispatch, leaveEditor]);
  const navigateHistory = useCallback(async (direction: "back" | "forward") => {
    if (state.page.type === "new-project" || historyNavigationPending.current) return;
    const targetIndex = state.navigationIndex + (direction === "back" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= state.navigationHistory.length) return;
    historyNavigationPending.current = true;
    setHistoryNavigating(true);
    try {
      if (await leaveEditor()) dispatch({ type: direction === "back" ? "NAVIGATE_BACK" : "NAVIGATE_FORWARD" });
    } finally {
      historyNavigationPending.current = false;
      setHistoryNavigating(false);
    }
  }, [state.page.type, state.navigationIndex, state.navigationHistory.length, leaveEditor, dispatch]);
  return { navigate, navigateHistory, historyNavigating };
}
