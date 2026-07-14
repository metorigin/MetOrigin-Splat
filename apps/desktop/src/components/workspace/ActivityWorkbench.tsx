import { ArrowDown, CheckCircle, MagnifyingGlass, Warning, XCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { desktopApi } from "../../services/desktop";
import type { PipelineEventRecord } from "../../types";

type ActivityTab = "log" | "event" | "warning" | "error";

export function ActivityWorkbench({ projectPath }: { projectPath: string }) {
  const [tab, setTab] = useState<ActivityTab>("log");
  const [events, setEvents] = useState<PipelineEventRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PipelineEventRecord | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const page = await desktopApi.getPipelineEvents(projectPath, { search: search || undefined });
        if (!disposed) setEvents(page.items);
      } catch {
        if (!disposed) setEvents([]);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projectPath, search]);

  const filtered = useMemo(() => events.filter((event) => {
    if (tab === "warning") return event.severity === "warning";
    if (tab === "error") return event.severity === "error";
    return true;
  }), [events, tab]);
  const warningCount = events.filter((event) => event.severity === "warning").length;
  const errorCount = events.filter((event) => event.severity === "error").length;

  useEffect(() => {
    if (autoFollow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [autoFollow, filtered]);

  return (
    <section className="activity-panel panel">
      <div className="activity-tabs">
        {(["log", "event", "warning", "error"] as ActivityTab[]).map((value) => (
          <button key={value} type="button" className={tab === value ? "is-active" : ""} onClick={() => setTab(value)}>
            {value === "log" ? "活动日志" : value === "event" ? "事件" : value === "warning" ? `警告 (${warningCount})` : `错误 (${errorCount})`}
          </button>
        ))}
        <label className="activity-search"><MagnifyingGlass size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索日志" /></label>
      </div>
      <div className="activity-workbench-body">
        <div className="activity-content" ref={listRef} onScroll={(event) => {
          const target = event.currentTarget;
          setAutoFollow(target.scrollHeight - target.scrollTop - target.clientHeight < 32);
        }}>
          <div className="activity-table-header"><span>时间</span><span>级别</span><span>阶段</span><span>消息</span></div>
          {filtered.length === 0 ? <div className="activity-empty-row"><CheckCircle size={17} weight="fill" /><span>暂无符合条件的真实事件</span><span>Pipeline 运行后将在此持续记录</span></div> : filtered.map((event) => (
            <button type="button" className={`activity-event-row severity-${event.severity} ${selected?.event_id === event.event_id ? "is-selected" : ""}`} key={event.event_id} onClick={() => setSelected(event)}>
              <span>{new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</span>
              <span>{event.severity === "error" ? <XCircle size={14} weight="fill" /> : event.severity === "warning" ? <Warning size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}{event.severity.toUpperCase()}</span>
              <span>{event.stage_id ?? "Pipeline"}</span>
              <span>{event.user_message}</span>
            </button>
          ))}
        </div>
        <aside className="event-detail">
          {selected ? <><strong>{selected.user_message}</strong><span>{selected.stage_id ?? "Pipeline"} · {new Date(selected.timestamp).toLocaleString("zh-CN")}</span><p>{selected.technical_message ?? "没有额外技术详情。"}</p><code>{JSON.stringify(selected.metrics, null, 2)}</code></> : <><strong>事件详情</strong><p>选择一条日志查看完整上下文。</p></>}
        </aside>
      </div>
      {!autoFollow && <button className="back-to-latest" type="button" onClick={() => setAutoFollow(true)}><ArrowDown size={14} />回到最新</button>}
    </section>
  );
}
