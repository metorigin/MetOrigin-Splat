import { Cpu, DownloadSimple, FolderOpen, Gear, HardDrives, Path, X } from "@phosphor-icons/react";
import { useRef, useState } from "react";

import { useRovingFocus } from "../../hooks";
import { desktopApi, selectEngineDirectory, selectEngineExecutable } from "../../services/desktop";
import { normalizeCommandError } from "../../services/errors";
import { ErrorNotice } from "../feedback";
import { ModalSurface } from "../primitives";
import type { AppSettings, EngineInfo, ResourceMetrics } from "../../types";

type SettingsTab = "engines" | "defaults" | "performance" | "diagnostics";

function formatBytes(bytes: number) {
  if (!bytes) return "尚未测量";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function SettingsDrawer({ engines, settings, loadError, metrics, projectId, projectPath, onClose, onSettings, onEngines, onError, onRetrySettings }: {
  engines: EngineInfo[];
  settings: AppSettings | null;
  loadError?: string | null;
  metrics: ResourceMetrics | null;
  projectId: string | null;
  projectPath: string | null;
  onClose: () => void;
  onSettings: (settings: AppSettings) => void;
  onEngines: (engines: EngineInfo[]) => void;
  onError: (error: string) => void;
  onRetrySettings?: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("engines");
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabs = ["engines", "defaults", "performance", "diagnostics"] as const;
  const tabRoving = useRovingFocus({
    itemCount: tabs.length,
    orientation: "horizontal",
    initialIndex: 0,
    activateOnFocus: true,
    onActivate: (index) => setTab(tabs[index]),
  });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  const save = (next: AppSettings) => void run(async () => onSettings(await desktopApi.saveAppSettings(next)));
  const refreshEngines = () => void run(async () => onEngines(await desktopApi.checkEngines()));

  if (!settings) {
    const error = normalizeCommandError(loadError ?? "设置数据不可用。", "get_app_settings");
    return (
      <ModalSurface id="settings-drawer" title="应用设置" titleHidden className="settings-drawer" onClose={onClose} initialFocusRef={closeRef}>
        <header><div><Gear size={20} /><div><strong>设置与系统状态</strong><span>设置尚未加载</span></div></div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button></header>
        <div className="settings-content">
          <ErrorNotice
            error={error}
            blocking
            onAction={(action) => {
              if (action.kind === "retry") onRetrySettings?.();
              if (action.kind === "export_diagnostics") onError("请先打开一个项目后再导出诊断。");
            }}
          />
        </div>
      </ModalSurface>
    );
  }

  return (
    <ModalSurface id="settings-drawer" title="应用设置" titleHidden className="settings-drawer" onClose={onClose} busy={busy} initialFocusRef={closeRef}>
      <header><div><Gear size={20} /><div><strong>设置与系统状态</strong><span>更改将在下一次阶段启动时生效</span></div></div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button></header>
      <nav ref={tabRoving.containerRef} role="tablist" aria-label="设置分类">{tabs.map((value, index) => <button id={`settings-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`settings-panel-${value}`} {...tabRoving.getItemProps(index)} key={value} className={tab === value ? "is-active" : ""} onClick={() => { setTab(value); tabRoving.setActiveIndex(index); }}>{value === "engines" ? "引擎" : value === "defaults" ? "项目默认值" : value === "performance" ? "性能" : "诊断"}</button>)}</nav>
      <div id={`settings-panel-${tab}`} className="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "engines" && <section className="settings-section"><div className="settings-section-title"><div><h2>引擎定位</h2><p>发布版优先使用已校验的应用内置引擎；高级外部路径仅用于人工恢复。</p></div><button className="button button-secondary" type="button" disabled={busy} onClick={refreshEngines}>重新检测</button></div>
          {settings.engine_directory && <div className="configured-engine-root"><Path size={16} /><span>{settings.engine_directory}</span><button type="button" onClick={() => void run(async () => onSettings(await desktopApi.clearEngineOverride()))}>恢复自动定位</button></div>}
          <div className="engine-settings-list">{engines.map((engine) => <article key={engine.name}><div className="engine-card-title"><strong>{engine.name}</strong><span className={engine.available ? "analysis-ok" : "analysis-blocked"}>{engine.available ? "已验证" : engine.integrity_status === "invalid" ? "需要修复" : "不可用"}</span></div><dl><div><dt>实际版本</dt><dd>{engine.actual_version ?? engine.version ?? "尚未读取"}</dd></div><div><dt>期望版本</dt><dd>{engine.expected_version ?? "外部版本"}</dd></div><div><dt>来源</dt><dd>{engine.source === "environment" ? "METORIGIN_ENGINE_DIR（调试）" : engine.source === "resource" ? "应用内置资源" : engine.source === "configured_or_path" ? "高级外部路径 / PATH" : "未定位"}</dd></div><div><dt>完整性</dt><dd>{engine.integrity_status === "valid" ? `已校验${engine.pack_version ? ` · ${engine.pack_version}` : ""}` : engine.integrity_status === "invalid" ? "校验失败" : "不适用"}</dd></div><div><dt>路径</dt><dd title={engine.path ?? undefined}>{engine.path ?? "尚未定位"}</dd></div></dl>{engine.diagnostic && <div className={engine.available ? "settings-note" : "inline-blocker"}>{engine.diagnostic}</div>}<div className="engine-card-actions"><button type="button" onClick={() => void run(async () => { const path = await selectEngineExecutable(engine.name); if (path) { onSettings(await desktopApi.setEngineExecutable(engine.name, path)); onEngines(await desktopApi.checkEngines()); } })}>单独定位</button><button type="button" disabled={!engine.path || busy} onClick={() => void run(async () => { await desktopApi.openEngineLocation(engine.name); })}>打开位置</button></div></article>)}</div>
          <button className="button button-secondary" type="button" onClick={() => void run(async () => { const path = await selectEngineDirectory(); if (path) { onSettings(await desktopApi.setEngineDirectory(path)); onEngines(await desktopApi.checkEngines()); } })}><FolderOpen size={16} />定位统一引擎目录</button>
        </section>}

        {tab === "defaults" && <section className="settings-section"><div className="settings-section-title"><div><h2>新项目默认值</h2><p>只影响之后创建的项目。</p></div></div><label className="settings-field"><span>默认质量预设</span><select value={settings.default_preset} onChange={(event) => save({ ...settings, default_preset: event.target.value })}><option value="fast">快速</option><option value="balanced">均衡</option><option value="quality">高质量</option></select></label><label className="settings-toggle"><input type="checkbox" checked={settings.create_and_start} onChange={(event) => save({ ...settings, create_and_start: event.target.checked })} /><span>项目创建后自动开始重建</span></label><label className="settings-field"><span>结构化事件日志保留上限（MiB）</span><input type="number" min={64} max={4096} value={settings.log_retention_mb} onChange={(event) => save({ ...settings, log_retention_mb: Number(event.target.value) })} /></label><div className="settings-note">真实产物预览直接读取项目文件，目前不会创建独立缩略图缓存。</div></section>}

        {tab === "performance" && <section className="settings-section"><div className="settings-section-title"><div><h2>实时资源</h2><p>运行中每 2 秒更新；指标不可用不会使 Pipeline 失败。</p></div></div><div className="resource-card-grid"><article><Cpu size={18} /><span>CPU</span><strong>{metrics ? `${metrics.cpu_usage_percent.toFixed(0)}%` : "尚未测量"}</strong><small>{metrics?.cpu_name ?? "设备信息不可用"}</small></article><article><HardDrives size={18} /><span>系统内存</span><strong>{metrics ? `${formatBytes(metrics.memory_used_bytes)} / ${formatBytes(metrics.memory_total_bytes)}` : "尚未测量"}</strong></article><article><Cpu size={18} /><span>GPU</span><strong>{metrics?.gpu ? `${metrics.gpu.utilization_percent?.toFixed(0) ?? "—"}%` : "指标不可用"}</strong><small>{metrics?.gpu?.name ?? "未检测到 NVIDIA 指标"}</small></article><article><HardDrives size={18} /><span>VRAM</span><strong>{metrics?.gpu ? `${formatBytes(metrics.gpu.memory_used_bytes)} / ${formatBytes(metrics.gpu.memory_total_bytes)}` : "尚未测量"}</strong></article><article><HardDrives size={18} /><span>项目盘可用</span><strong>{formatBytes(metrics?.project_disk_available_bytes ?? 0)}</strong></article><article><Cpu size={18} /><span>GPU 温度</span><strong>{metrics?.gpu?.temperature_celsius != null ? `${metrics.gpu.temperature_celsius.toFixed(0)} °C` : "尚未测量"}</strong></article></div>{metrics?.warnings.map((warning) => <div className="inline-blocker" key={warning}>{warning}</div>)}</section>}

        {tab === "diagnostics" && <section className="settings-section"><div className="settings-section-title"><div><h2>脱敏诊断包</h2><p>包含项目状态、日志尾部、引擎和硬件摘要；不包含视频、图片或 PLY。</p></div></div><button className="button button-primary" type="button" disabled={!projectPath || !projectId || busy} onClick={() => projectPath && projectId && void run(async () => { const result = await desktopApi.exportDiagnostics(projectPath); const fileName = result.path.split(/[\\/]/).pop(); if (!fileName) throw new Error("诊断包路径无效。"); await desktopApi.openProjectLocation({ projectId, projectPath, targetType: "artifact", relativePath: `output/${fileName}` }); })}><DownloadSimple size={16} />导出诊断包</button>{!projectPath && <div className="settings-note">请先打开一个项目。</div>}</section>}
      </div>
    </ModalSurface>
  );
}
