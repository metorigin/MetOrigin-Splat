import type { UiError } from "./errors";

export type WorkspaceAction =
  | "pause"
  | "cancel"
  | "rerun_stage"
  | "restore_checkpoint"
  | "delete_checkpoint"
  | "delete_project";

export interface WorkspaceActionRequest {
  projectId: string;
  projectPath: string;
  action: WorkspaceAction;
  stageId?: string | null;
  checkpointIteration?: number | null;
}

export interface ActionImpactPreview {
  action: WorkspaceAction;
  targetLabel: string;
  allowed: boolean;
  blockedReason: string | null;
  irreversible: boolean;
  preserved: string[];
  invalidated: string[];
  regenerated: string[];
  warnings: string[];
  sizeBytes: number | null;
  previewToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface ActionReceipt {
  id: string;
  action: WorkspaceAction;
  status: "success" | "error";
  title: string;
  message: string;
  completedAt: string;
  affectedResources: string[];
  dismissible: boolean;
  error?: UiError;
}

export type WorkspaceActionExecution =
  | { kind: "completed"; receipt: ActionReceipt }
  | {
      kind: "stale";
      code: "UI-ACTION-PREVIEW-STALE";
      message: string;
      preview: ActionImpactPreview;
    };

export interface OverlayState {
  id: string;
  kind: "dialog" | "drawer" | "menu";
  trigger: HTMLElement | null;
  busy: boolean;
  returnFallbackId: string | null;
}
