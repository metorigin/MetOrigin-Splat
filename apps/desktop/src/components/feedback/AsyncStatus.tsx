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
    return <p role="status" aria-live="polite">正在加载{label}…</p>;
  }
  if (resource.status === "error") {
    return (
      <div className="async-error-state" role="alert">
        <strong>{label}加载失败</strong>
        <p>{resource.error?.message}</p>
        {resource.error?.retryable && onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
      </div>
    );
  }
  if (empty && resource.completeness === "complete") {
    return <p className="empty-state">暂无{label}</p>;
  }
  if (resource.status === "refreshing") {
    return <p role="status">正在刷新{label}，当前显示上次结果。</p>;
  }
  if (resource.status === "stale") {
    return (
      <div role="status" className="async-stale-state">
        <span>
          {label}可能已过期
          {resource.lastSuccessfulAt
            ? `，最后更新于 ${new Date(resource.lastSuccessfulAt).toLocaleTimeString("zh-CN")}`
            : ""}
        </span>
        {resource.error?.retryable && onRetry ? <button type="button" onClick={onRetry}>重试刷新</button> : null}
      </div>
    );
  }
  if (resource.completeness === "partial") {
    return (
      <div role="status" className="async-partial-state">
        <strong>{label}仅部分可用</strong>
        <ul>
          {resource.partialIssues.map((issue) => (
            <li key={`${issue.scope}-${issue.error.code}`}>
              <span>{issue.scope}：{issue.error.message}</span>
              {issue.retryActionKey && onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}
