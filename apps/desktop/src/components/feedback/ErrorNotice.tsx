import { localizeMessage, t } from "../../i18n";
import { useRef, useState } from "react";
import { normalizeCommandError, redactSensitiveText } from "../../services/errors";
import type { UiError, UiErrorAction } from "../../types";
import { CaretDown, WarningCircle } from "../primitives/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface ErrorNoticeProps {
  error: UiError;
  onAction?: (action: UiErrorAction) => void | Promise<void>;
  blocking?: boolean;
}

const safeText = (value: string) => redactSensitiveText(localizeMessage(value));

export function ErrorNotice({ error, onAction, blocking = false }: ErrorNoticeProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const visibleActions = error.actions.filter((action) => action.kind !== "retry" || error.retryable);
  const runAction = async (action: UiErrorAction) => {
    if (inFlight.current || !onAction || !action.enabled) return;
    inFlight.current = true;
    setPendingAction(`${action.kind}-${action.label}`);
    setActionFailure(null);
    try {
      await onAction(action);
    } catch (failure) {
      setActionFailure(safeText(normalizeCommandError(failure, action.kind).message));
    } finally {
      inFlight.current = false;
      setPendingAction(null);
    }
  };
  return (
    <Alert variant="destructive" role={blocking ? "alert" : "status"}>
      <WarningCircle size={16} />
      <AlertTitle className="line-clamp-none break-words leading-relaxed">{safeText(error.title)}<Badge variant="outline" className="ml-2 font-mono text-xs">{safeText(error.code)}</Badge></AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{safeText(error.message)}</p>
        <p>{t("影响：")}{safeText(error.impact)}</p>
        {error.suggestions.length ? <ul className="list-disc space-y-1 pl-4">{error.suggestions.map((suggestion) => <li key={suggestion}>{safeText(suggestion)}</li>)}</ul> : null}
        {error.technicalDetails ? (
          <Collapsible className="w-full rounded-md border border-border bg-background text-foreground">
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="w-full justify-between [&[data-state=open]>svg]:rotate-180">{t("技术详情")}<CaretDown size={14} /></Button></CollapsibleTrigger>
            <CollapsibleContent><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3 font-mono text-xs">{redactSensitiveText(error.technicalDetails)}</pre></CollapsibleContent>
          </Collapsible>
        ) : null}
        {actionFailure ? <p className="rounded-md border border-destructive/30 p-2" role="alert">{actionFailure === t("操作未完成") ? actionFailure : t("{0}：{1}", t("操作未完成"), actionFailure)}</p> : null}
        {visibleActions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {visibleActions.map((action) => {
              const actionKey = `${action.kind}-${action.label}`;
              return (
                <Button
                  key={actionKey}
                  variant="outline"
                  size="sm"
                  disabled={!action.enabled || pendingAction !== null || !onAction}
                  aria-busy={pendingAction === actionKey || undefined}
                  title={action.disabledReason ? safeText(action.disabledReason) : undefined}
                  onClick={() => void runAction(action)}
                >
                  {pendingAction === actionKey ? t("{0}中…", safeText(action.label)) : safeText(action.label)}
                </Button>
              );
            })}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
