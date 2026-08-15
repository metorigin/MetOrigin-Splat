import { useCallback, useRef, useState } from "react";
import { formatUiError, normalizeCommandError } from "../services/errors";
import { DesktopCommandError, invokeDesktopCommand } from "../services/desktop";
import type { UiError } from "../types";

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
  const inFlight = useRef<Promise<T> | null>(null);
  argsRef.current = args;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uiError, setUiError] = useState<UiError | null>(null);

  const execute = useCallback(
    (overrideArgs?: Record<string, unknown>): Promise<T> => {
      if (inFlight.current) return inFlight.current;
      setLoading(true);
      setError(null);
      setUiError(null);
      const commandPromise = invokeDesktopCommand<T>(
        command,
        overrideArgs ?? argsRef.current,
      );
      const promise = commandPromise
        .then((result) => {
          setData(result);
          return result;
        })
        .catch((cause: unknown) => {
          const normalized = cause instanceof DesktopCommandError
            ? cause.uiError
            : normalizeCommandError(cause, command);
          setUiError(normalized);
          setError(formatUiError(normalized));
          throw cause;
        })
        .finally(() => {
          setLoading(false);
          inFlight.current = null;
        });
      inFlight.current = promise;
      return promise;
    },
    [command],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setUiError(null);
    setLoading(false);
  }, []);

  return { data, loading, error, uiError, execute, reset };
}
