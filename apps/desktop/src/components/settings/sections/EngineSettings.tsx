import { localizeMessage, t } from "@/i18n";
import { FolderOpen } from "@/components/primitives/icons";
import { Notification } from "@/components/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resourceMemory } from "@/lib/resourcePresentation";
import { isMacPlatform, isWindowsPlatform } from "@/lib/platformShortcuts";
import { NativeSelect } from "@/components/ui/native-select";
import type { AppSettings, EngineInfo, ResourceMetrics } from "@/types";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";
import { formatSettingsBytes as formatBytes, settingsDefinitionClass as definitionClass, settingsNoteClass as noteClass } from "../settingsPresentation";

export function EngineSettings({ engines, loading, error, allReady, busy, metrics, version, settings, onSave, onExportDiagnostics, onRefresh, onLocateEngine, onOpenEngine, onLocateDirectory }: {
  engines: EngineInfo[]; loading: boolean; error: string | null; allReady: boolean; busy: boolean;
  settings: AppSettings; onSave: (settings: AppSettings) => void; onExportDiagnostics: () => void;
  metrics: ResourceMetrics | null; version: string | null;
  onRefresh: () => void; onLocateEngine: (name: string) => void; onOpenEngine: (name: string) => void; onLocateDirectory: () => void;
}) {
  const memory = resourceMemory(metrics);
  return <div className="space-y-3">
    <SettingsSection title={t("重建引擎")} description={t("此处检查引擎是否可启动及版本；GPU 计算能力由项目预检和训练启动检查确认。")}>
      <div className="mb-4"><Badge variant={allReady ? "success" : "warning"}>{allReady ? t("引擎检查通过") : t("待检查")}</Badge></div>
      {loading && <p role="status" className={noteClass}>{t("正在检测引擎…")}</p>}
      {error && <Notification variant="error" className="mb-4" message={<>{t("引擎检测失败：")}{localizeMessage(error)}</>}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>{t("重试检测")}</Button>}
      />}
      {!loading && !error && engines.length === 0 && <p className="mb-4 text-sm text-muted-foreground">{t("尚未检测")}</p>}
      <div className="divide-y divide-border/40">
        {engines.map((engine) => <article key={engine.name} className="space-y-3 py-4 first:pt-0">
          <div className="flex items-center justify-between gap-3"><strong className="text-sm font-medium">{engine.name}</strong><Badge variant={engine.available ? "success" : "destructive"}>{engine.available ? t("版本检查通过") : t("不可用")}</Badge></div>
          <p className="text-sm">{t("版本：")}{engine.actual_version ?? engine.version ?? t("尚未检测")}</p>
          <p className="break-all text-xs text-muted-foreground">{engine.path?.split(/[\\/]/).pop() ?? t("尚未定位")}</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => onLocateEngine(engine.name)}>{t("单独定位")}</Button><Button variant="ghost" size="sm" disabled={!engine.path || busy} onClick={() => onOpenEngine(engine.name)}>{t("打开位置")}</Button></div>
        </article>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={onRefresh}>{t("重新检测")}</Button><Button variant="outline" disabled={busy} onClick={onLocateDirectory}><FolderOpen size={16} />{t("定位引擎与缓存目录")}</Button></div>
    </SettingsSection>
    <SettingsSection title={t("GPU 计算检查")} description={t("每次项目预检和启动训练都会执行真实计算检查。已创建项目继续使用冻结的后端和设备。")}>
      {isWindowsPlatform() && <SettingsRow label={t("新项目训练后端")} htmlFor="windows-training-backend" description={t("自动优先检查 DX12；计算失败后独立检查 Vulkan。显式选择只检查指定后端。高级启动配置优先于此设置。") }>
        <NativeSelect id="windows-training-backend" disabled={busy} value={settings.windows_training_backend ?? "auto"} onChange={(event) => onSave({ ...settings, windows_training_backend: event.target.value as AppSettings["windows_training_backend"] })}>
          <option value="auto">{t("自动")}</option><option value="dx12">DX12</option><option value="vulkan">Vulkan</option>
        </NativeSelect>
      </SettingsRow>}
      {isMacPlatform() && <p className="text-sm">{t("训练后端：Metal")}</p>}
      <p className={`${noteClass} mt-3`}>{metrics?.runtime ? `${t("当前项目后端：")}${metrics.runtime.brush_backend}${metrics.runtime.device_name ? ` · ${metrics.runtime.device_name}` : ""}` : t("尚未获得当前项目的计算验证结果。请在新建项目中执行预检。")}</p>
      <Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={onExportDiagnostics}>{t("导出训练诊断")}</Button>
    </SettingsSection>
    <SettingsSection title={t("系统与应用")}><dl className={definitionClass}>
      <div><dt>GPU</dt><dd>{metrics?.gpu?.name ?? t("尚未检测")}</dd></div>
      <div><dt>{t("GPU 使用率")}</dt><dd>{metrics?.gpu?.utilization_percent == null ? t("尚未测量") : `${metrics.gpu.utilization_percent.toFixed(0)}%`}</dd></div>
      <div><dt>{memory.unified ? t("统一内存") : t("显存（VRAM）")}</dt><dd>{memory.used != null && memory.total != null ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : t("尚未测量")}</dd></div>
      <div><dt>{t("操作系统")}</dt><dd>{metrics?.operating_system ?? t("尚未检测")}</dd></div>
      <div><dt>{t("应用版本")}</dt><dd>{version ? `v${version}` : t("尚未获取")}</dd></div>
    </dl></SettingsSection>
  </div>;
}
