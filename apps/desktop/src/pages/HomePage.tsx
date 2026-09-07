import { ClockCounterClockwise, Cube, Cpu, FolderOpen, HardDrives, MagnifyingGlass, Plus, Stack, WarningCircle } from "../components/primitives/icons";
import { useMemo, useState } from "react";
import { selectActivePipelineSnapshot, useAppContext } from "../context";
import { getProjectStatusLabel, getStageLabel } from "../localization";
import type { EngineInfo, ProjectInfo, ResourceMetrics } from "../types";

interface HomePageProps {
  engines: EngineInfo[];
  metrics: ResourceMetrics | null;
  onOpenProject: () => void;
  onRetry?: () => void;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
function formatProjectTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "更新时间未知";
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function HomePage({ engines, metrics, onOpenProject, onRetry }: HomePageProps) {
  const { state, dispatch } = useAppContext();
  const [search, setSearch] = useState("");
  const active = selectActivePipelineSnapshot(state);
  const query = search.trim().toLocaleLowerCase("zh-CN");
  const filtered = useMemo(() => state.recentProjects.filter((project) =>
    !query || `${project.name} ${project.path}`.toLocaleLowerCase("zh-CN").includes(query)), [query, state.recentProjects]);
  const diskAvailable = metrics?.project_disk_available_bytes;
  const diskMeasured = diskAvailable != null && Number.isFinite(diskAvailable) && diskAvailable >= 0;
  const diskSpace = diskMeasured ? gib(diskAvailable) : "尚未测量";
  const installationDrive = metrics?.disk_path?.match(/^([a-z]:)[\\/]/i)?.[1];
  const diskLabel = installationDrive ? `应用安装盘 · ${installationDrive}` : "应用安装盘";
  const readyEngines = engines.filter((engine) => engine.available).length;
  const readiness = [
    { name: "重建组件", value: engines.length ? `${readyEngines} / ${engines.length} 个组件可用` : "等待检测", ready: engines.length > 0 && readyEngines === engines.length },
    { name: "GPU", value: metrics?.gpu?.name.replace("NVIDIA GeForce ", "") ?? "指标尚未获取", ready: Boolean(metrics?.gpu) },
    { name: "显存容量", value: metrics?.gpu ? `${gib(metrics.gpu.memory_used_bytes)} / ${gib(metrics.gpu.memory_total_bytes)}` : "尚未测量", ready: Boolean(metrics?.gpu) },
    { name: diskLabel, value: diskMeasured ? `${diskSpace} 可用` : diskSpace, ready: diskMeasured },
  ];
  const open = (project: ProjectInfo) => dispatch({ type: "NAVIGATE", page: { type: "project-detail", projectId: project.id, projectPath: project.path } });
  const create = () => dispatch({ type: "NAVIGATE", page: { type: "new-project" } });

  return (
    <div className="hub-page">
      <header className="hub-header">
        <div className="hub-title" aria-hidden="true">项目中心</div>
        <div className="hub-header-actions">
          <label className="hub-search"><MagnifyingGlass size={16} aria-hidden="true" /><span className="sr-only">搜索项目名称或路径</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目…" /></label>
          <button type="button" className="button button-secondary" onClick={onOpenProject}><FolderOpen size={16} />打开项目</button>
        </div>
      </header>

      <section className="hub-metrics" aria-label="项目概览">
        <article><span>最近项目</span><Stack size={19} /><strong>{state.recentProjects.length}</strong><small>本机项目记录</small></article>
        <article><span>进行中的任务</span><Cpu size={19} /><strong>{active ? 1 : 0}</strong><small>{active ? getStageLabel(active.state.current_stage ?? "") || "正在准备" : "准备好开始下一次重建"}</small></article>
        <article><span>磁盘可用空间</span><HardDrives size={19} /><strong>{diskSpace}</strong><small title={metrics?.disk_path ?? undefined}>{diskLabel}</small></article>
      </section>

      <div className="hub-content-grid">
        <section className="hub-recent-section" aria-labelledby="recent-project-heading">
          <div className="hub-section-heading"><h2 id="recent-project-heading">最近项目</h2><span><ClockCounterClockwise size={14} />按最近打开排序</span></div>
          {state.recentProjectsError ? <div className="inline-warning" role="alert"><WarningCircle size={16} /><span>最近项目读取失败，正在显示已加载的记录。</span>{onRetry ? <button className="button button-subtle" type="button" onClick={onRetry}>重新加载</button> : null}</div> : null}
          <div className="hub-project-list">
            {filtered.map((project) => <button type="button" className="recent-project-row" key={project.id} onClick={() => open(project)}><Cube size={20} /><span><strong>{project.name}</strong><small>{project.path}</small></span><span className={`status-pill status-${project.status}`}><i />{getProjectStatusLabel(project.status)}</span><time dateTime={project.updated_at}>{formatProjectTime(project.updated_at)}</time></button>)}
            {!filtered.length ? <div className="hub-empty-project"><FolderOpen size={32} /><h3>{state.recentProjectsLoading ? "正在加载项目" : query ? "没有匹配的项目" : "创建你的第一个场景"}</h3><p>{query ? "试试其他关键词，或清除搜索条件。" : "导入连续照片或视频，逐步完成三维重建。"}</p><div>{query ? <button className="button button-secondary" type="button" onClick={() => setSearch("")}>清除搜索</button> : <button type="button" className="button button-primary" onClick={create}><Plus size={17} />新建项目</button>}</div></div> : null}
          </div>
        </section>
        <aside className="readiness-panel" aria-labelledby="readiness-heading">
          <h2 id="readiness-heading">运行环境</h2>
          <div className="readiness-list">{readiness.map((item) => <article className={item.ready ? "is-ready" : "is-warning"} key={item.name}><div><span>{item.name}</span><strong>{item.value}</strong></div><span className="readiness-status" aria-label={item.ready ? "已获取" : "待检查"}><i /></span></article>)}</div>
        </aside>
      </div>
    </div>
  );
}
