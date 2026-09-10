import { localizeMessage, t } from "../../i18n";
import {
  CheckCircle,
  Cpu,
  DownloadSimple,
  FolderOpen,
  HardDrives,
  Path,
  WarningCircle,
} from "../primitives/icons";
import { useRef, useState } from "react";

import { useRovingFocus } from "../../hooks";
import { desktopApi, selectEngineDirectory, selectEngineExecutable } from "../../services/desktop";
import { normalizeCommandError } from "../../services/errors";
import { useTheme } from "../../hooks/useTheme";
import type { Theme } from "../../hooks/useTheme";
import type { AppSettings, EngineInfo, ResourceMetrics } from "../../types";
import { ErrorNotice } from "../feedback";
import { ModalSurface } from "../primitives";
import { LanguageSelector } from "./LanguageSelector";
import { useLanguage } from "../../hooks/useLanguage";

type SettingsTab = "engines" | "defaults" | "performance" | "diagnostics";

const visibleTabLabel: Record<SettingsTab, string> = {
  get engines() { return t("引擎"); },
  get defaults() { return t("常规"); },
  get performance() { return t("性能与存储"); },
  get diagnostics() { return t("外观与诊断"); },
};

const accessibleTabLabel: Record<SettingsTab, string> = {
  get engines() { return t("引擎"); },
  get defaults() { return t("项目默认值"); },
  get performance() { return t("性能"); },
  get diagnostics() { return t("诊断"); },
};

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return t("尚未测量");
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function SettingsDrawer({ engines, enginesLoading = false, enginesError = null, version = null, settings, loadError, metrics, projectId, projectPath, onClose, onSettings, onEngines, onError, onRetrySettings }: {
  engines: EngineInfo[];
  enginesLoading?: boolean;
  enginesError?: string | null;
  version?: string | null;
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
  const { theme, setTheme } = useTheme();
  useLanguage();
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
    const error = normalizeCommandError(loadError ?? t("设置数据不可用。"), "get_app_settings");
    return (
      <ModalSurface id="settings-drawer" title={t("应用设置")} titleHidden className="settings-drawer" onClose={onClose} initialFocusRef={closeRef}>
        <header>
          <strong>{t("设置与引擎")}</strong>
          <button ref={closeRef} className="settings-close-button" type="button" onClick={onClose} aria-label={t("关闭设置")}>{t("关闭")}</button>
        </header>
        <div className="settings-content">
          <LanguageSelector />
          <ErrorNotice
            error={error}
            blocking
            onAction={(action) => {
              if (action.kind === "retry") onRetrySettings?.();
              if (action.kind === "export_diagnostics") onError(t("请先打开一个项目后再导出诊断。"));
            }}
          />
        </div>
      </ModalSurface>
    );
  }

  const readyEngine = engines.find((engine) => engine.name.toLowerCase().includes("brush")) ?? engines[0];
  const allReady = engines.length > 0 && engines.every((engine) => engine.available);

  return (
    <ModalSurface id="settings-drawer" title={t("应用设置")} titleHidden className="settings-drawer" onClose={onClose} busy={busy} initialFocusRef={closeRef}>
      <header>
        <strong>{t("设置与引擎")}</strong>
        <button ref={closeRef} className="settings-close-button" type="button" onClick={onClose} aria-label={t("关闭设置")}>{t("关闭")}</button>
      </header>

      <LanguageSelector />
      <nav ref={tabRoving.containerRef} role="tablist" aria-label={t("设置分类")}>
        {tabs.map((value, index) => (
          <button
            id={`settings-tab-${value}`}
            key={value}
            type="button"
            role="tab"
            aria-label={accessibleTabLabel[value]}
            aria-selected={tab === value}
            aria-controls={`settings-panel-${value}`}
            {...tabRoving.getItemProps(index)}
            className={tab === value ? "is-active" : ""}
            onClick={() => { setTab(value); tabRoving.setActiveIndex(index); }}
          >
            <span aria-hidden="true">{visibleTabLabel[value]}</span>
          </button>
        ))}
      </nav>

      <div id={`settings-panel-${tab}`} className="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "engines" ? (
          <section className="settings-section settings-engine-panel">
            <div className="settings-section-title"><div><h2>{t("重建引擎")}</h2><p>{t("查看组件状态，启动任务前会再次检查运行环境。")}</p></div></div>
            {enginesLoading ? <p role="status">{t("正在检测引擎…")}</p> : null}
            {enginesError ? <div className="inline-warning" role="alert"><WarningCircle size={16} /><span>{t("引擎检测失败：")}{localizeMessage(enginesError)}</span><button type="button" className="button button-secondary" disabled={busy} onClick={refreshEngines}>{t("重试检测")}</button></div> : null}
            <div className="settings-engine-summary">
              <article><span>{t("引擎版本")}</span><strong>{readyEngine ? `v${(readyEngine.actual_version ?? readyEngine.version ?? "—").replace(/^v/i, "")}` : t("未检测")}</strong><span className={`status-pill ${readyEngine?.available ? "status-completed" : "status-failed"}`}><i />{readyEngine?.available ? t("已完成") : t("需修复")}</span></article>
              <article><span>{t("组件状态")}</span><strong>{allReady ? t("已就绪") : t("待检查")}</strong><span className={`status-pill ${allReady ? "status-completed" : "status-failed"}`}><i />{allReady ? t("已完成") : t("需修复")}</span></article>
              <article><span>{t("默认 GPU")}</span><strong>{metrics?.gpu?.name?.replace("GeForce ", "") ?? t("未检测")}</strong><span className={`status-pill ${metrics?.gpu ? "status-completed" : "status-failed"}`}><i />{metrics?.gpu ? t("已完成") : t("需修复")}</span></article>
            </div>

            <div className="settings-policy-heading"><h2>{t("运行策略")}</h2></div>
            <label className="settings-policy-row"><span><strong>{t("创建后开始重建")}</strong><small>{t("新项目默认完成创建后启动任务")}</small></span><input type="checkbox" checked={settings.create_and_start} onChange={(event) => save({ ...settings, create_and_start: event.target.checked })} /></label>

            <details className="settings-engine-details" open>
              <summary>{t("引擎组件详情")}</summary>
              <div className="engine-settings-list">
                {engines.map((engine) => (
                  <article key={engine.name}>
                    <div className="engine-card-title"><strong>{engine.name}</strong><span className={engine.available ? "analysis-ok" : "analysis-blocked"}>{engine.available ? t("已验证") : t("不可用")}</span></div>
                    <p className="engine-version">{t("版本：")}{engine.actual_version ?? engine.version ?? t("尚未检测")}</p>
                    <p title={engine.path ?? undefined}>{engine.path ?? localizeMessage(engine.diagnostic) ?? t("尚未定位")}</p>
                    <div className="engine-card-actions">
                      <button type="button" onClick={() => void run(async () => {
                        const path = await selectEngineExecutable(engine.name);
                        if (path) { onSettings(await desktopApi.setEngineExecutable(engine.name, path)); onEngines(await desktopApi.checkEngines()); }
                      })}>{t("单独定位")}</button>
                      <button type="button" disabled={!engine.path || busy} onClick={() => void run(async () => { await desktopApi.openEngineLocation(engine.name); })}>{t("打开位置")}</button>
                    </div>
                  </article>
                ))}
              </div>
            </details>

            <section className="settings-system-info" aria-labelledby="settings-system-heading">
              <h2 id="settings-system-heading">{t("系统与应用")}</h2>
              <dl>
                <div><dt>GPU</dt><dd>{metrics?.gpu?.name ?? t("尚未检测")}</dd></div>
                <div><dt>{t("GPU 使用率")}</dt><dd>{metrics?.gpu?.utilization_percent == null ? t("尚未测量") : `${metrics.gpu.utilization_percent.toFixed(0)}%`}</dd></div>
                <div><dt>{t("显存（VRAM）")}</dt><dd>{metrics?.gpu ? `${(metrics.gpu.memory_used_bytes / 1024 ** 3).toFixed(1)} / ${(metrics.gpu.memory_total_bytes / 1024 ** 3).toFixed(1)} GB` : t("尚未测量")}</dd></div>
                <div><dt>{t("操作系统")}</dt><dd>{metrics?.operating_system ?? t("尚未检测")}</dd></div>
                <div><dt>{t("应用版本")}</dt><dd>{version ? `v${version}` : t("尚未获取")}</dd></div>
              </dl>
            </section>

            <div className="settings-footer-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={refreshEngines}>{t("重新检测")}</button><button className="button button-primary" type="button" disabled={busy} onClick={() => save(settings)}>{t("保存设置")}</button></div>
          </section>
        ) : null}

        {tab === "defaults" ? (
          <section className="settings-section">
            <div className="settings-section-title"><div><h2>{t("常规")}</h2><p>{t("配置新项目的默认创建方式。")}</p></div></div>
            <label className="settings-field"><span>{t("默认质量预设")}</span><select value={settings.default_preset} onChange={(event) => save({ ...settings, default_preset: event.target.value })}><option value="fast">{t("快速")}</option><option value="balanced">{t("均衡")}</option><option value="quality">{t("高质量")}</option></select></label>
            <label className="settings-toggle"><input type="checkbox" checked={settings.create_and_start} onChange={(event) => save({ ...settings, create_and_start: event.target.checked })} /><span>{t("项目创建后自动开始重建")}</span></label>
            <div className="settings-note">{t("更改会应用到之后创建的项目，不影响当前运行中的任务。")}</div>
          </section>
        ) : null}

        {tab === "performance" ? (
          <section className="settings-section">
            <div className="settings-section-title"><div><h2>{t("存储")}</h2><p>{t("管理默认路径、日志与预览缓存。")}</p></div></div>
            {settings.default_project_root ? <div className="configured-engine-root"><Path size={16} /><span>{settings.default_project_root}</span></div> : null}
            <label className="settings-field"><span>{t("结构化事件日志上限（MiB）")}</span><input type="number" min={64} max={4096} value={settings.log_retention_mb} onChange={(event) => save({ ...settings, log_retention_mb: Number(event.target.value) })} /></label>
            <label className="settings-field"><span>{t("预览缓存上限（MiB）")}</span><input type="number" min={64} max={8192} value={settings.thumbnail_cache_mb} onChange={(event) => save({ ...settings, thumbnail_cache_mb: Number(event.target.value) })} /></label>
            <div className="resource-card-grid"><article title={metrics?.disk_path ?? undefined}><HardDrives size={18} /><span>{t("磁盘可用空间")}</span><strong>{formatBytes(metrics?.project_disk_available_bytes)}</strong></article><article><Cpu size={18} /><span>{t("系统内存")}</span><strong>{metrics ? `${formatBytes(metrics.memory_used_bytes)} / ${formatBytes(metrics.memory_total_bytes)}` : t("尚未测量")}</strong></article></div>
            <button className="button button-secondary" type="button" onClick={() => void run(async () => {
              const path = await selectEngineDirectory();
              if (path) { onSettings(await desktopApi.setEngineDirectory(path)); onEngines(await desktopApi.checkEngines()); }
            })}><FolderOpen size={16} />{t("定位引擎与缓存目录")}</button>
          </section>
        ) : null}

        {tab === "diagnostics" ? (
          <section className="settings-section">
            <div className="settings-section-title"><div><h2>{t("外观与诊断")}</h2><p>{t("选择工作区主题，或跟随系统外观。")}</p></div></div>
            <label className="settings-field"><span>{t("界面主题")}</span><select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option><option value="system">{t("跟随系统")}</option></select></label>
            <div className="settings-diagnostic-state">{allReady ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}<span>{allReady ? t("引擎诊断通过") : t("部分引擎需要处理")}</span></div>
            <button className="button button-primary" type="button" disabled={!projectPath || !projectId || busy} onClick={() => projectPath && projectId && void run(async () => {
              const result = await desktopApi.exportDiagnostics(projectPath);
              const fileName = result.path.split(/[\\/]/).pop();
              if (!fileName) throw new Error(t("诊断包路径无效。"));
              await desktopApi.openProjectLocation({ projectId, projectPath, targetType: "artifact", relativePath: `output/${fileName}` });
            })}><DownloadSimple size={16} />{t("导出脱敏诊断包")}</button>
            {!projectPath ? <div className="settings-note">{t("打开项目后可导出项目状态、日志尾部、引擎和硬件摘要。")}</div> : null}
          </section>
        ) : null}
      </div>
    </ModalSurface>
  );
}
