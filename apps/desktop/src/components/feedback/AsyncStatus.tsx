import { localizeMessage, t, getLocale } from "../../i18n";
import type { AsyncResource } from "../../types";

interface AsyncStatusProps<T> {
  resource: AsyncResource<T>;
  label: string;
  empty?: boolean;
  onRetry?: () => void;
}

export function AsyncStatus<T>({ resource, label, empty = false, onRetry }: AsyncStatusProps<T>) {
  if (resource.status === "idle") return null;
  if (resource.status === "loading") {
    return <p role="status" aria-live="polite">{t("正在加载{0}…", label)}</p>;
  }
  if (resource.status === "error") {
    return (
      <div className="async-error-state" role="alert">
        <strong>{t("{0}加载失败", label)}</strong>
        <p>{localizeMessage(resource.error?.message)}</p>
        {resource.error?.retryable && onRetry ? <button type="button" onClick={onRetry}>{t("重试")}</button> : null}
      </div>
    );
  }
  if (empty && resource.completeness === "complete") {
    return <p className="empty-state">{t("暂无{0}", label)}</p>;
  }
  if (resource.status === "refreshing") {
    return <p role="status">{t("正在刷新{0}，当前显示上次结果。", label)}</p>;
  }
  if (resource.status === "stale") {
    return (
      <div role="status" className="async-stale-state">
        <span>
          {t("{0}可能已过期", label)}{resource.lastSuccessfulAt
            ? t("，最后更新于 {0}", new Date(resource.lastSuccessfulAt).toLocaleTimeString(getLocale()))
            : ""}
        </span>
        {resource.error?.retryable && onRetry ? <button type="button" onClick={onRetry}>{t("重试刷新")}</button> : null}
      </div>
    );
  }
  if (resource.completeness === "partial") {
    return (
      <div role="status" className="async-partial-state">
        <strong>{t("{0}仅部分可用", label)}</strong>
        <ul>
          {resource.partialIssues.map((issue) => (
            <li key={`${issue.scope}-${issue.error.code}`}>
              <span>{t("{0}：{1}", localizeMessage(issue.scope), localizeMessage(issue.error.message))}</span>
              {issue.retryActionKey && onRetry ? <button type="button" onClick={onRetry}>{t("重试")}</button> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}
