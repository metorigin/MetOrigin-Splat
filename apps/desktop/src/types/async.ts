import type { UiError } from "./errors";

export type AsyncResourceStatus =
  | "idle"
  | "loading"
  | "success"
  | "refreshing"
  | "stale"
  | "error";

export type AsyncCompleteness = "complete" | "partial";

export interface AsyncPartialIssue {
  scope: string;
  error: UiError;
  retryActionKey: string | null;
}

export interface AsyncResourceMeta {
  status: AsyncResourceStatus;
  completeness: AsyncCompleteness | null;
  partialIssues: AsyncPartialIssue[];
  lastSuccessfulAt: number | null;
  requestedAt: number | null;
  error: UiError | null;
  requestKey: string | null;
}

export interface AsyncResource<T> extends AsyncResourceMeta {
  data: T | null;
}

export interface AsyncLoadResult<T> {
  data: T;
  completeness?: AsyncCompleteness;
  partialIssues?: AsyncPartialIssue[];
}
