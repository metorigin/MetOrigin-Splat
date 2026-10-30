import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localizeMessage, t, getLocale } from "../../i18n";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  MagnifyingGlass,
  Warning,
  XCircle,
} from "../primitives/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAsyncResource } from "../../hooks";
import { getStageLabel } from "../../localization";
import { desktopApi } from "../../services/desktop";
import { normalizeCommandError, redactSensitiveText } from "../../services/errors";
import type { PipelineEventRecord } from "../../types";
import { AsyncStatus, StatusAnnouncer } from "../feedback";
import { mergeActivityEvents } from "./activityEvents";

type ActivityTab = "log" | "event" | "warning" | "error";

interface ActivityWorkbenchProps {
  projectPath: string;
  selectedStage?: string | null;
  onSelectStage?: (stageId: string) => void;
  refreshSignal?: number;
}

function safeMetricSummary(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const safeEntries = Object.entries(metrics as Record<string, unknown>).filter(([, value]) =>
    typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)),
  );
  return safeEntries.length > 0
    ? JSON.stringify(Object.fromEntries(safeEntries), null, 2)
    : null;
}

export function ActivityWorkbench({
  projectPath,
  selectedStage = null,
  onSelectStage,
  refreshSignal = 0,
}: ActivityWorkbenchProps) {
  const [tab, setTab] = useState<ActivityTab>("log");
  const [search, setSearch] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuerySearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [selected, setSelected] = useState<PipelineEventRecord | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const activity = useAsyncResource<PipelineEventRecord[]>();
  const eventsRef = useRef<PipelineEventRecord[]>([]);
  const queryKeyRef = useRef("");
  const requestSequence = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(activity.resource.status);
  const previousRefreshSignal = useRef(refreshSignal);

  const queryKey = `${projectPath}|${selectedStage ?? "all"}|${tab}|${querySearch}`;
  const activeQuery = useRef(queryKey);
  activeQuery.current = queryKey;
  const load = useCallback(async (mode: "replace" | "refresh" | "older") => {
    const requestId = ++requestSequence.current;
    const requestKey = `${queryKey}:${mode}:${requestId}`;
    const cursor = mode === "older" ? nextCursor ?? undefined : undefined;
    const severity = tab === "warning" || tab === "error" ? tab : undefined;
    const isSameQuery = queryKeyRef.current === queryKey;
    const base = mode === "replace" || !isSameQuery ? [] : eventsRef.current;
    try {
      const data = await activity.load(
        requestKey,
        async () => {
          const page = await desktopApi.getPipelineEvents(projectPath, {
            stageId: selectedStage ?? undefined,
            severity,
            search: querySearch || undefined,
            cursor,
          });
          const filtered = tab === "event"
            ? page.items.filter((event) => event.kind !== "log")
            : page.items;
          if (requestSequence.current === requestId && activeQuery.current === queryKey) {
            setNextCursor(page.next_cursor);
          }
          return mergeActivityEvents(base, filtered);
        },
        (error) => normalizeCommandError(error, "get_pipeline_events"),
      );
      if (requestSequence.current === requestId && activeQuery.current === queryKey) {
        queryKeyRef.current = queryKey;
        eventsRef.current = data;
      }
    } catch {
      // AsyncResource retains the last good page and normalized failure.
    }
  }, [activity, nextCursor, projectPath, queryKey, querySearch, selectedStage, tab]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    eventsRef.current = [];
    queryKeyRef.current = queryKey;
    setNextCursor(null);
    setSelected(null);
    void load("replace");
    const timer = window.setInterval(() => {
      if (!document.hidden) void load("refresh");
    }, 3_000);
    return () => { window.clearInterval(timer); requestSequence.current += 1; };
    // queryKey is the intentional reset boundary; load also changes as resource state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    if (previousRefreshSignal.current === refreshSignal) return;
    previousRefreshSignal.current = refreshSignal;
    void loadRef.current("refresh");
  }, [refreshSignal]);

  useEffect(() => {
    const before = previousStatus.current;
    const current = activity.resource.status;
    if (current === "stale" && before !== "stale") {
      setAnnouncement(t("活动记录刷新失败，正在显示上次结果。"));
    } else if (before === "stale" && current === "success") {
      setAnnouncement(t("活动记录已恢复更新。"));
    }
    previousStatus.current = current;
  }, [activity.resource.status]);

  const events = useMemo(() => activity.resource.data ?? [], [activity.resource.data]);
  const warningCount = events.filter((event) => event.severity === "warning").length;
  const errorCount = events.filter((event) => event.severity === "error").length;

  useEffect(() => {
    if (autoFollow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [autoFollow, events]);

  const tabs = [
    ["log", t("活动日志")],
    ["event", t("事件")],
    ["warning", t("警告 ({0})", warningCount)],
    ["error", t("错误 ({0})", errorCount)],
  ] as const;

  return (
    <section className="activity-panel relative flex min-h-0 flex-1 flex-col bg-card" aria-label={t("Pipeline 活动")} aria-busy={["loading", "refreshing"].includes(activity.resource.status)}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as ActivityTab)} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <TabsList aria-label={t("Pipeline 活动筛选")}>
          {tabs.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
        </TabsList>
        <label className="activity-search">
          <MagnifyingGlass size={14} />
          <Input aria-label={t("搜索活动记录")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索日志")} />
        </label>
      </div>
      <AsyncStatus resource={activity.resource} label={t("活动记录")} empty={events.length === 0} onRetry={() => void load("refresh")} />
      {activity.resource.error && activity.resource.data !== null ? (
        <div className="activity-load-warning" role="status">
          <Warning size={15} weight="fill" />
          {t("活动记录更新失败，正在显示最后一次成功获取的数据。")}
        </div>
      ) : null}
      <TabsContent value={tab} className="activity-workbench-body m-0 min-h-0 flex-1">
        <div className="activity-content" ref={listRef} onScroll={(event) => {
          const target = event.currentTarget;
          setAutoFollow(target.scrollHeight - target.scrollTop - target.clientHeight < 32);
        }}>
          <div className="activity-table-header"><span>{t("时间")}</span><span>{t("级别")}</span><span>{t("阶段")}</span><span>{t("消息")}</span></div>
          {events.length === 0 ? activity.resource.status === "error" ? null : (
            <div className="activity-empty-row">
              <CheckCircle size={17} weight="fill" />
              <span>{["idle", "loading"].includes(activity.resource.status) ? t("正在加载活动日志…") : t("暂无符合条件的真实事件")}</span>
              <span>{["idle", "loading"].includes(activity.resource.status) ? t("请稍候") : t("Pipeline 运行后将在此持续记录")}</span>
            </div>
          ) : events.map((event) => (
            <Button variant="ghost"
              type="button"
              aria-pressed={selected?.event_id === event.event_id}
              className={`activity-event-row grid h-auto w-full justify-start rounded-none px-3 py-2 text-left text-xs severity-${event.severity} ${selected?.event_id === event.event_id ? "is-selected" : ""}`}
              key={event.event_id || `${event.project_id}:${event.sequence}`}
              onClick={() => {
                setSelected(event);
                if (event.stage_id) onSelectStage?.(event.stage_id);
              }}
            >
              <span>{new Date(event.timestamp).toLocaleTimeString(getLocale(), { hour12: false })}</span>
              <span>{event.severity === "error" ? <XCircle size={14} weight="fill" /> : event.severity === "warning" ? <Warning size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}{event.severity.toUpperCase()}</span>
              <span>{event.stage_id ? getStageLabel(event.stage_id) : "Pipeline"}</span>
              <span>{localizeMessage(redactSensitiveText(event.user_message))}</span>
            </Button>
          ))}
          {nextCursor != null ? (
            <Button variant="outline" className="activity-load-more m-3" type="button" onClick={() => void load("older")}>
              <ArrowUp size={14} /> {t("加载更早记录")}</Button>
          ) : null}
        </div>
        <aside className="event-detail" aria-label={t("事件详情")}>
          {selected ? <>
            <strong>{localizeMessage(redactSensitiveText(selected.user_message))}</strong>
            <span>{selected.stage_id ? getStageLabel(selected.stage_id) : "Pipeline"} · {new Date(selected.timestamp).toLocaleString(getLocale())}</span>
            <p>{selected.technical_message
              ? t("原始引擎输出已隐藏；需要排查时请导出脱敏诊断。")
              : t("没有额外技术详情。")}</p>
            {safeMetricSummary(selected.metrics) ? (
              <code>{safeMetricSummary(selected.metrics)}</code>
            ) : null}
          </> : <><strong>{t("事件详情")}</strong><p>{t("选择一条日志查看完整上下文。")}</p></>}
        </aside>
      </TabsContent>
      </Tabs>
      {!autoFollow && <Button variant="secondary" className="back-to-latest absolute bottom-3 left-1/2 -translate-x-1/2 border border-border bg-popover shadow-sm" type="button" onClick={() => setAutoFollow(true)}><ArrowDown size={14} />{t("回到最新")}</Button>}
      <StatusAnnouncer message={announcement} />
    </section>
  );
}
