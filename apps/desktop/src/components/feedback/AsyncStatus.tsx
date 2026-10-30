import { localizeMessage, t, getLocale } from "../../i18n";
import type { AsyncResource } from "../../types";
import { redactSensitiveText } from "../../services/errors";
import { SpinnerGap, WarningCircle } from "../primitives/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
      <Alert variant="destructive">
        <WarningCircle size={16} />
        <AlertTitle className="line-clamp-none break-words leading-relaxed">{t("{0}加载失败", label)}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{redactSensitiveText(localizeMessage(resource.error?.message ?? ""))}</p>
          {resource.error?.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试")}</Button> : null}
        </AlertDescription>
      </Alert>
    );
  }
  // Freshness remains visible even when the last successful result was empty.
  if (resource.status === "refreshing") {
    return <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status"><SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />{t("正在刷新{0}，当前显示上次结果。", label)}</p>;
  }
  if (resource.status === "stale") {
    return (
      <Alert role="status" className="border-warning/30 bg-warning/10">
        <WarningCircle size={16} />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("{0}可能已过期", label)}{resource.lastSuccessfulAt
            ? t("，最后更新于 {0}", new Date(resource.lastSuccessfulAt).toLocaleTimeString(getLocale())) : ""}</span>
          {resource.error?.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试刷新")}</Button> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (resource.completeness === "partial") {
    return (
      <Alert role="status" className="border-warning/30 bg-warning/10">
        <WarningCircle size={16} />
        <AlertTitle className="line-clamp-none break-words leading-relaxed">{t("{0}仅部分可用", label)}</AlertTitle>
        <AlertDescription>
          <ul className="space-y-2">
            {resource.partialIssues.map((issue) => (
              <li className="flex flex-wrap items-center justify-between gap-2" key={`${issue.scope}-${issue.error.code}`}>
                <span>{redactSensitiveText(t("{0}：{1}", localizeMessage(issue.scope), localizeMessage(issue.error.message)))}</span>
                {issue.retryActionKey && issue.error.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t("重试")}</Button> : null}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  if (empty && resource.completeness === "complete") {
    return <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("暂无{0}", label)}</p>;
  }
  return null;
}
