import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { formatCommandError } from "../localization";

/**
 * Hook for calling Tauri backend commands with loading/error state.
 *
 * @example
 * const { data, loading, error, execute } = useTauriCommand<string>("app_version");
 * // Later: await execute();
 */
export function useTauriCommand<T>(
  command: string,
  args?: Record<string, unknown>,
) {
  const argsRef = useRef(args);
  argsRef.current = args;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (overrideArgs?: Record<string, unknown>) => {
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<T>(command, overrideArgs ?? argsRef.current);
        setData(result as T);
        return result;
      } catch (e) {
        const msg = formatCommandError(e, command);
        setError(msg);
        throw msg;
      } finally {
        setLoading(false);
      }
    },
    [command],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { data, loading, error, execute, reset };
}
