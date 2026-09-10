import { localizeMessage, t } from "../../i18n";
import { useState } from "react";

import { redactSensitiveText } from "../../services/errors";
import type { UiError, UiErrorAction } from "../../types";

interface ErrorNoticeProps {
  error: UiError;
  onAction?: (action: UiErrorAction) => void | Promise<void>;
  blocking?: boolean;
}

export function ErrorNotice({ error, onAction, blocking = false }: ErrorNoticeProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const visibleActions = error.actions.filter(
    (action) => action.kind !== "retry" || error.retryable,
  );
  const runAction = (action: UiErrorAction) => {
    const actionKey = `${action.kind}-${action.label}`;
    if (pendingAction === actionKey) return;
    const result = onAction?.(action);
    if (result && typeof result.then === "function") {
      setPendingAction(actionKey);
      void result.finally(() => setPendingAction((current) => current === actionKey ? null : current));
    }
  };
  return (
    <section className="error-notice" role={blocking ? "alert" : "status"}>
      <div>
        <strong>{localizeMessage(error.title)}</strong>
        <span className="error-code">{error.code}</span>
      </div>
      <p>{localizeMessage(error.message)}</p>
      <p className="error-impact">{t("影响：")}{localizeMessage(error.impact)}</p>
      <ul>
        {error.suggestions.map((suggestion) => (
          <li key={suggestion}>{localizeMessage(suggestion)}</li>
        ))}
      </ul>
      {error.technicalDetails ? (
        <details>
          <summary>{t("技术详情")}</summary>
          <pre>{redactSensitiveText(error.technicalDetails)}</pre>
        </details>
      ) : null}
      {visibleActions.length > 0 ? (
        <div className="error-actions">
          {visibleActions.map((action) => {
            const actionKey = `${action.kind}-${action.label}`;
            return (
            <button
              key={actionKey}
              type="button"
              disabled={!action.enabled || pendingAction === actionKey}
              aria-busy={pendingAction === actionKey || undefined}
              title={localizeMessage(action.disabledReason)}
              onClick={() => runAction(action)}
            >
              {pendingAction === actionKey ? t("{0}中…", localizeMessage(action.label)) : localizeMessage(action.label)}
            </button>
          );})}
        </div>
      ) : null}
    </section>
  );
}
