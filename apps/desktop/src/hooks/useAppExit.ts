import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopApi, isDesktopRuntime } from "../services/desktop";

/** The native quit path waits for the editor's existing save/discard/cancel UI. */
export function useAppExit(leaveEditor: () => Promise<boolean>, onError: (message: string) => void) {
  const current = useRef({ leaveEditor, onError });
  current.current = { leaveEditor, onError };
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let pending = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) => {
      void promise.then((cleanup) => {
        if (disposed) cleanup(); else cleanups.push(cleanup);
      }).catch((error) => current.current.onError(String(error)));
    };
    register(listen("app-exit-requested", () => {
      if (pending || disposed) return;
      pending = true;
      void (async () => {
        try {
          if (await current.current.leaveEditor() && !disposed) await desktopApi.finishAppExit();
        } catch (error) {
          current.current.onError(String(error));
        } finally {
          pending = false;
        }
      })();
    }));
    register(listen<string>("app-exit-failed", ({ payload }) => current.current.onError(payload)));
    return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); };
  }, []);
}
