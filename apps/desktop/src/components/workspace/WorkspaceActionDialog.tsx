import { Button } from "@/components/ui/button";
import { localizeMessage, t } from "../../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { desktopApi, DesktopCommandError } from "../../services/desktop";
import { normalizeCommandError } from "../../services/errors";
import type {
  ActionImpactPreview,
  ActionReceipt as ActionReceiptModel,
  UiError,
  WorkspaceActionRequest,
} from "../../types";
import { ActionReceipt, ErrorNotice, Notification } from "../feedback";
import { ModalSurface } from "../primitives";

function formatBytes(value: number | null): string | null {
  if (value == null) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export function WorkspaceActionDialog({
  request,
  projectName,
  onClose,
  onCompleted,
}: {
  request: WorkspaceActionRequest;
  projectName?: string;
  onClose: () => void;
  onCompleted?: (receipt: ActionReceiptModel) => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<ActionImpactPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UiError | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ActionReceiptModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUsable, setPreviewUsable] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const updatedHeadingRef = useRef<HTMLHeadingElement>(null);
  const deletion = request.action === "delete_project" || request.action === "delete_checkpoint";
  const confirmationQuestion = request.action === "delete_checkpoint"
    ? request.checkpointIteration != null
      ? t("确认删除恢复点 {0} 吗？", String(request.checkpointIteration))
      : t("确认删除这个恢复点吗？")
    : !preview ? t("确认删除这个项目吗？")
      : preview.irreversible
        ? projectName ? t("确认永久删除项目“{0}”吗？", projectName) : t("确认永久删除这个项目吗？")
        : projectName ? t("确认删除项目“{0}”的记录吗？", projectName) : t("确认删除这个项目的记录吗？");

  useLayoutEffect(() => {
    // Own focus after the refreshed heading has committed and the busy guard
    // has settled. A frame queued from the promise may precede that commit.
    if (conflictMessage && previewUsable && !loading && !busy) {
      updatedHeadingRef.current?.focus();
    }
  }, [conflictMessage, previewUsable, loading, busy]);

  const loadPreview = useCallback(async (reason: "initial" | "stale" | "retry" = "initial") => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setPreviewUsable(false);
    setError(null);
    if (reason !== "initial") setConflictMessage(deletion ? t("项目状态已变化，请重新确认。") : t("项目状态已变化，尚未执行任何操作，正在刷新影响说明。"));
    try {
      const next = await desktopApi.previewWorkspaceAction(request);
      if (generation.current !== currentGeneration) return;
      setPreview(next);
      setPreviewUsable(true);
      if (reason !== "initial") {
        setConflictMessage(deletion ? t("项目状态已变化，请重新确认。") : t("影响说明已更新。请重新检查以下变化并再次确认；尚未执行任何操作。"));
      }
    } catch (cause) {
      if (generation.current !== currentGeneration) return;
      setError(cause instanceof DesktopCommandError
        ? cause.uiError
        : normalizeCommandError(cause, "preview_workspace_action"));
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [request, deletion]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const confirm = () => {
    if (!preview?.allowed || !previewUsable || busy || inFlight.current || receipt) return;
    const submittedToken = preview.previewToken;
    setBusy(true);
    setPreviewUsable(false);
    setError(null);
    const operation = (async () => {
      try {
        const result = await desktopApi.executeWorkspaceAction(submittedToken);
        if (result.kind === "stale") {
          generation.current += 1;
          setPreview(result.preview);
          setPreviewUsable(true);
          setConflictMessage(deletion ? t("项目状态已变化，请重新确认。") : t("{0} 影响说明已更新，请重新确认。", result.message));
          return;
        }
        setReceipt(result.receipt);
        await onCompleted?.(result.receipt);
      } catch (cause) {
        const normalized = cause instanceof DesktopCommandError
          ? cause.uiError
          : normalizeCommandError(cause, "execute_workspace_action");
        if (["UI-ACTION-PREVIEW-EXPIRED", "UI-ACTION-PREVIEW-INVALID"].includes(normalized.code)) {
          setConflictMessage(deletion ? t("项目状态已变化，请重新确认。") : t("操作确认已过期或失效，尚未执行任何操作，正在刷新影响说明。"));
          await loadPreview("stale");
        } else {
          setError(normalized);
        }
      }
    })().finally(() => {
      setBusy(false);
      inFlight.current = null;
    });
    inFlight.current = operation;
  };

  return (
    <ModalSurface
      id="workspace-action-dialog"
      title={deletion ? receipt ? t("操作已完成") : confirmationQuestion : t("确认操作影响")}
      role="alertdialog"
      className={deletion ? "w-[min(420px,calc(100vw-2rem))]" : "w-[min(720px,calc(100vw-2rem))]"}
      busy={busy}
      onClose={onClose}
      initialFocusRef={cancelRef}
      closeOnBackdrop={!busy}
    >
      {conflictMessage ? (
        <Notification variant="warning" message={<h3 ref={updatedHeadingRef} tabIndex={-1} role="alert" className="m-0 text-sm font-medium">
          {localizeMessage(conflictMessage)}
        </h3>} />
      ) : null}
      {loading ? <p role="status">{t("正在读取当前项目状态并计算影响…")}</p> : null}
      {error ? (
        <>
          <ErrorNotice error={error} blocking />
          <Button variant="outline"
            type="button"

            disabled={loading || busy}
            onClick={() => void loadPreview("retry")}
          >
            {deletion ? t("重试") : t("重新读取影响说明")}</Button>
        </>
      ) : null}
      {preview && (!deletion || !preview.allowed) ? (
        <div className={deletion ? undefined : conflictMessage ? "impact-preview is-refreshed" : "impact-preview"}>
          {!deletion && <div className="impact-target">
            <strong>{localizeMessage(preview.targetLabel)}</strong>
            {formatBytes(preview.sizeBytes) ? <span>{t("涉及约")}{formatBytes(preview.sizeBytes)}</span> : null}
          </div>}
          {!preview.allowed ? <Notification variant="error" message={localizeMessage(preview.blockedReason)} /> : null}
          {!deletion && <div className="impact-columns">
            <section><h3>{t("会保留")}</h3><ul>{preview.preserved.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
            <section><h3>{t("会失效或删除")}</h3><ul>{preview.invalidated.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
            <section><h3>{t("需要重新生成")}</h3><ul>{preview.regenerated.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
          </div>}
          {!deletion && preview.warnings.length ? <Notification variant="warning"><ul className="m-0 list-disc space-y-1 pl-4">{preview.warnings.map((warning) => <li key={warning}>{localizeMessage(warning)}</li>)}</ul></Notification> : null}
          {!deletion && preview.irreversible ? <Notification variant="warning" message={t("此操作不可撤销。")}/> : null}
        </div>
      ) : null}
      {receipt ? <ActionReceipt receipt={receipt} placement="inline" /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" ref={cancelRef} type="button" disabled={busy} onClick={onClose}>
          {receipt ? t("关闭") : t("取消")}
        </Button>
        {!receipt && preview?.allowed ? (
          <Button type="button" variant={deletion || preview.irreversible ? "destructive" : "warning"} disabled={busy || loading || !previewUsable} onClick={confirm}>
            {deletion ? busy ? t("正在删除…") : t("删除") : busy ? t("正在执行…") : t("确认并执行")}
          </Button>
        ) : null}
      </div>
    </ModalSurface>
  );
}
