import { localizeMessage, t } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from "react";

import { desktopApi, DesktopCommandError } from "../../services/desktop";
import { normalizeCommandError } from "../../services/errors";
import type {
  ActionImpactPreview,
  ActionReceipt as ActionReceiptModel,
  UiError,
  WorkspaceActionRequest,
} from "../../types";
import { ActionReceipt, ErrorNotice } from "../feedback";
import { ModalSurface } from "../primitives";

function formatBytes(value: number | null): string | null {
  if (value == null) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function WorkspaceActionDialog({
  request,
  onClose,
  onCompleted,
}: {
  request: WorkspaceActionRequest;
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

  const loadPreview = useCallback(async (reason: "initial" | "stale" | "retry" = "initial") => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setPreviewUsable(false);
    setError(null);
    if (reason !== "initial") setConflictMessage(t("项目状态已变化，尚未执行任何操作，正在刷新影响说明。"));
    try {
      const next = await desktopApi.previewWorkspaceAction(request);
      if (generation.current !== currentGeneration) return;
      setPreview(next);
      setPreviewUsable(true);
      if (reason !== "initial") {
        setConflictMessage(t("影响说明已更新。请重新检查以下变化并再次确认；尚未执行任何操作。"));
        window.requestAnimationFrame(() => updatedHeadingRef.current?.focus());
      }
    } catch (cause) {
      if (generation.current !== currentGeneration) return;
      setError(cause instanceof DesktopCommandError
        ? cause.uiError
        : normalizeCommandError(cause, "preview_workspace_action"));
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [request]);

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
          setConflictMessage(t("{0} 影响说明已更新，请重新确认。", result.message));
          window.requestAnimationFrame(() => updatedHeadingRef.current?.focus());
          return;
        }
        setReceipt(result.receipt);
        await onCompleted?.(result.receipt);
      } catch (cause) {
        const normalized = cause instanceof DesktopCommandError
          ? cause.uiError
          : normalizeCommandError(cause, "execute_workspace_action");
        if (["UI-ACTION-PREVIEW-EXPIRED", "UI-ACTION-PREVIEW-INVALID"].includes(normalized.code)) {
          setConflictMessage(t("操作确认已过期或失效，尚未执行任何操作，正在刷新影响说明。"));
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
      title={t("确认操作影响")}
      role="alertdialog"
      busy={busy}
      onClose={onClose}
      initialFocusRef={cancelRef}
      closeOnBackdrop={!busy}
    >
      {conflictMessage ? (
        <h3 ref={updatedHeadingRef} tabIndex={-1} role="alert" className="impact-refresh-message">
          {localizeMessage(conflictMessage)}
        </h3>
      ) : null}
      {loading ? <p role="status">{t("正在读取当前项目状态并计算影响…")}</p> : null}
      {error ? (
        <>
          <ErrorNotice error={error} blocking />
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || busy}
            onClick={() => void loadPreview("retry")}
          >
            {t("重新读取影响说明")}</button>
        </>
      ) : null}
      {preview ? (
        <div className={conflictMessage ? "impact-preview is-refreshed" : "impact-preview"}>
          <div className="impact-target">
            <strong>{localizeMessage(preview.targetLabel)}</strong>
            {formatBytes(preview.sizeBytes) ? <span>{t("涉及约")}{formatBytes(preview.sizeBytes)}</span> : null}
          </div>
          {!preview.allowed ? <p role="alert">{localizeMessage(preview.blockedReason)}</p> : null}
          <div className="impact-columns">
            <section><h3>{t("会保留")}</h3><ul>{preview.preserved.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
            <section><h3>{t("会失效或删除")}</h3><ul>{preview.invalidated.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
            <section><h3>{t("需要重新生成")}</h3><ul>{preview.regenerated.map((item) => <li key={item}>{localizeMessage(item)}</li>)}</ul></section>
          </div>
          {preview.warnings.length ? <ul className="impact-warnings">{preview.warnings.map((warning) => <li key={warning}>{localizeMessage(warning)}</li>)}</ul> : null}
          {preview.irreversible ? <p className="impact-irreversible">{t("此操作不可撤销。")}</p> : null}
        </div>
      ) : null}
      {receipt ? <ActionReceipt receipt={receipt} /> : null}
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="button button-secondary" disabled={busy} onClick={onClose}>
          {receipt ? t("关闭") : t("取消")}
        </button>
        {!receipt && preview?.allowed ? (
          <button type="button" className={preview.irreversible ? "button button-danger" : "button button-warning"} disabled={busy || loading || !previewUsable} onClick={confirm}>
            {busy ? t("正在执行…") : t("确认并执行")}
          </button>
        ) : null}
      </div>
    </ModalSurface>
  );
}
