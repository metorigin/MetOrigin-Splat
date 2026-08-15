export type UiErrorCategory =
  | "user"
  | "environment"
  | "media"
  | "engine"
  | "filesystem"
  | "resource"
  | "internal"
  | "unknown";

export type UiErrorActionKind =
  | "retry"
  | "recheck"
  | "open_settings"
  | "show_activity"
  | "reveal_safe_log"
  | "export_diagnostics"
  | "dismiss";

export interface UiErrorAction {
  kind: UiErrorActionKind;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface UiError {
  code: string;
  category: UiErrorCategory;
  title: string;
  message: string;
  impact: string;
  suggestions: string[];
  retryable: boolean;
  actions: UiErrorAction[];
  technicalDetails: string | null;
  logReference: string | null;
}
