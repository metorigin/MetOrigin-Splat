import { useCallback, useMemo, useReducer, useRef, useState } from "react";

import type {
  AsyncCompleteness,
  AsyncLoadResult,
  AsyncPartialIssue,
  AsyncResource,
  UiError,
} from "../types";

type AsyncResourceAction<T> =
  | { type: "request"; requestKey: string; requestedAt: number }
  | {
      type: "success";
      requestKey: string;
      data: T;
      completeness: AsyncCompleteness;
      partialIssues: AsyncPartialIssue[];
      receivedAt: number;
    }
  | { type: "failure"; requestKey: string; error: UiError }
  | { type: "reset" };

function sanitizePartialIssues(issues: AsyncPartialIssue[]): AsyncPartialIssue[] {
  return issues.map((issue) => ({
    ...issue,
    retryActionKey: issue.error.retryable ? issue.retryActionKey : null,
  }));
}

export function createAsyncResourceState<T>(data: T | null = null): AsyncResource<T> {
  return {
    data,
    status: data === null ? "idle" : "success",
    completeness: data === null ? null : "complete",
    partialIssues: [],
    lastSuccessfulAt: data === null ? null : Date.now(),
    requestedAt: null,
    error: null,
    requestKey: null,
  };
}

export function asyncResourceReducer<T>(
  state: AsyncResource<T>,
  action: AsyncResourceAction<T>,
): AsyncResource<T> {
  switch (action.type) {
    case "request":
      return {
        ...state,
        status: state.data === null ? "loading" : "refreshing",
        requestedAt: action.requestedAt,
        requestKey: action.requestKey,
        error: null,
      };
    case "success":
      if (state.requestKey !== action.requestKey) return state;
      return {
        data: action.data,
        status: "success",
        completeness: action.completeness,
        partialIssues:
          action.completeness === "partial"
            ? sanitizePartialIssues(action.partialIssues)
            : [],
        lastSuccessfulAt: action.receivedAt,
        requestedAt: state.requestedAt,
        error: null,
        requestKey: action.requestKey,
      };
    case "failure":
      if (state.requestKey !== action.requestKey) return state;
      return {
        ...state,
        status: state.data === null ? "error" : "stale",
        error: action.error,
      };
    case "reset":
      return createAsyncResourceState<T>();
  }
}

function isLoadResult<T>(value: T | AsyncLoadResult<T>): value is AsyncLoadResult<T> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "data"),
  );
}

export function useAsyncResource<T>(initialData: T | null = null) {
  const [resource, dispatch] = useReducer(
    asyncResourceReducer<T>,
    initialData,
    createAsyncResourceState,
  );
  const activeMutations = useRef(new Map<string, Promise<unknown>>());
  const [, setPendingVersion] = useState(0);

  const load = useCallback(
    async (
      requestKey: string,
      loader: () => Promise<T | AsyncLoadResult<T>>,
      normalizeError: (error: unknown) => UiError,
    ): Promise<T> => {
      dispatch({ type: "request", requestKey, requestedAt: Date.now() });
      try {
        const raw = await loader();
        const result: AsyncLoadResult<T> = isLoadResult(raw)
          ? raw
          : { data: raw, completeness: "complete", partialIssues: [] };
        dispatch({
          type: "success",
          requestKey,
          data: result.data,
          completeness: result.completeness ?? "complete",
          partialIssues: result.partialIssues ?? [],
          receivedAt: Date.now(),
        });
        return result.data;
      } catch (error) {
        dispatch({ type: "failure", requestKey, error: normalizeError(error) });
        throw error;
      }
    },
    [],
  );

  const runMutation = useCallback(
    <R,>(actionKey: string, mutation: () => Promise<R>): Promise<R> => {
      const existing = activeMutations.current.get(actionKey);
      if (existing) return existing as Promise<R>;

      const promise = mutation().finally(() => {
        if (activeMutations.current.get(actionKey) === promise) {
          activeMutations.current.delete(actionKey);
          setPendingVersion((version) => version + 1);
        }
      });
      activeMutations.current.set(actionKey, promise);
      setPendingVersion((version) => version + 1);
      return promise;
    },
    [],
  );

  const isActionPending = useCallback(
    (actionKey: string) => activeMutations.current.has(actionKey),
    [],
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return useMemo(
    () => ({ resource, load, runMutation, isActionPending, reset }),
    [resource, load, runMutation, isActionPending, reset],
  );
}
