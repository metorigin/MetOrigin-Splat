import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Hook for listening to Tauri events emitted from the Rust backend.
 *
 * Automatically cleans up the listener on unmount.
 *
 * @example
 * useTauriEvent<TaskProgress>("pipeline://progress", (progress) => {
 *   setProgress(progress);
 * });
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const setup = async () => {
      unlisten = await listen<T>(eventName, (event) => {
        handler(event.payload);
      });
    };

    setup();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [eventName, handler]);
}
