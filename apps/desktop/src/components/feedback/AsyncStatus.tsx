import { localizeMessage, t, getLocale } from "../../i18n";
import type { AsyncResource } from "../../types";
import { redactSensitiveText } from "../../services/errors";
import { SpinnerGap } from "../primitives/icons";
import { Button } from "@/components/ui/button";
import { Notification } from "./Notification";

interface AsyncStatusProps<T> {
  resource: AsyncResource<T>;
  label: string;
  empty?: boolean;
  onRetry?: () => void;
}

export function AsyncStatus<T>({ resource, label, empty = false, onRetry }: AsyncStatusProps<T>) {
  if (resource.status === "idle") return null;
  if (resource.status === "loading") {
    return <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status" aria-live="polite"><SpinnerGap size={16} className="animate-spin motion-reduce:animate-none" />{t("正在加载{0}…", label)}</p>;
  }
  if (resource.status === "error") {
    return (
      <Notification variant="error" title={t("{0}加载失败", label)}
        message={redactSensitiveText(localizeMessage(resource.error?.message ?? ""))}
        actions={resource.error?.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试")}</Button> : undefined}
      />
    );
  }
  // Freshness remains visible even when the last successful result was empty.
  if (resource.status === "refreshing") {
    return <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status"><SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />{t("正在刷新{0}，当前显示上次结果。", label)}</p>;
  }
  if (resource.status === "stale") {
    return (
      <Notification variant="warning"
        message={<>{t("{0}可能已过期", label)}{resource.lastSuccessfulAt
          ? t("，最后更新于 {0}", new Date(resource.lastSuccessfulAt).toLocaleTimeString(getLocale())) : ""}</>}
        actions={resource.error?.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试刷新")}</Button> : undefined}
      />
    );
  }
  if (resource.completeness === "partial") {
    return (
      <Notification variant="warning" title={t("{0}仅部分可用", label)}>
          <ul className="space-y-2">
            {resource.partialIssues.map((issue) => (
              <li className="flex min-w-0 flex-wrap items-center justify-between gap-2" key={`${issue.scope}-${issue.error.code}`}>
                <span className="min-w-0 [overflow-wrap:anywhere]">{redactSensitiveText(t("{0}：{1}", localizeMessage(issue.scope), localizeMessage(issue.error.message)))}</span>
                {issue.retryActionKey && issue.error.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试")}</Button> : null}
              </li>
            ))}
          </ul>
      </Notification>
    );
  }
  if (empty && resource.completeness === "complete") {
    return <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("暂无{0}", label)}</p>;
  }
  return null;
}
