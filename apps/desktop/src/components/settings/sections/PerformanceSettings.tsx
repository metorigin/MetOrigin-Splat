import { localizeMessage, t } from "@/i18n";
import type { AppSettings, ResourceMetrics } from "@/types";
import { isMacPlatform } from "@/lib/platformShortcuts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RuntimeResources } from "../RuntimeResources";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";
import { formatSettingsBytes as formatBytes, settingsDefinitionClass as definitionClass, settingsNoteClass as noteClass } from "../settingsPresentation";

export function PerformanceSettings({ settings, metrics, busy, logLimit, cacheLimit, logValid, cacheValid, storageChanged, onLogLimit, onCacheLimit, onSaveStorage, onSave }: {
  settings: AppSettings; metrics: ResourceMetrics | null; busy: boolean;
  logLimit: string; cacheLimit: string; logValid: boolean; cacheValid: boolean; storageChanged: boolean;
  onLogLimit: (value: string) => void; onCacheLimit: (value: string) => void; onSaveStorage: () => void; onSave: (settings: AppSettings) => void;
}) {
  return <div className="space-y-3">
    <SettingsSection title={t("存储")} description={t("管理默认路径、日志与预览缓存。")}>
      {settings.default_project_root && <p className="mb-4 break-all rounded-md bg-muted p-3 text-xs">{settings.default_project_root}</p>}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (logValid && cacheValid && storageChanged && !busy) onSaveStorage(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="log-limit">{t("结构化事件日志上限（MiB）")}</Label><Input id="log-limit" type="number" min={64} max={4096} step={1} disabled={busy} value={logLimit} onChange={(event) => onLogLimit(event.target.value)} aria-invalid={!logValid} aria-describedby="log-limit-description" /><p id="log-limit-description" className={logValid ? noteClass : "text-xs text-destructive"}>{t("请输入 {0} 至 {1} 之间的整数。", 64, 4096)}</p></div>
          <div className="grid gap-2"><Label htmlFor="cache-limit">{t("预览缓存上限（MiB）")}</Label><Input id="cache-limit" type="number" min={64} max={8192} step={1} disabled={busy} value={cacheLimit} onChange={(event) => onCacheLimit(event.target.value)} aria-invalid={!cacheValid} aria-describedby="cache-limit-description" /><p id="cache-limit-description" className={cacheValid ? noteClass : "text-xs text-destructive"}>{t("请输入 {0} 至 {1} 之间的整数。", 64, 8192)}</p></div>
        </div>
        <Button type="submit" disabled={busy || !logValid || !cacheValid || !storageChanged}>{busy ? t("正在保存") : t("保存设置")}</Button>
      </form>
      <dl className={`${definitionClass} mt-5`}><div><dt>{t("磁盘可用空间")}</dt><dd title={metrics?.disk_path ?? undefined}>{formatBytes(metrics?.project_disk_available_bytes)}</dd></div><div><dt>{t("系统内存")}</dt><dd>{metrics ? `${formatBytes(metrics.memory_used_bytes)} / ${formatBytes(metrics.memory_total_bytes)}` : t("尚未测量")}</dd></div></dl>
    </SettingsSection>
    {isMacPlatform() && <SettingsSection>
      <SettingsRow label={t("任务运行时防止空闲睡眠")} htmlFor="idle-sleep">
        <Switch id="idle-sleep" checked={settings.prevent_idle_sleep} disabled={busy} aria-describedby="idle-sleep-description" onCheckedChange={(checked) => onSave({ ...settings, prevent_idle_sleep: checked })} />
      </SettingsRow>
      <p id="idle-sleep-description" className={`${noteClass} mt-3`}>{t("仅影响之后启动的任务。允许屏幕休眠；合盖、手动睡眠和低电量仍可能中断任务。")}</p>
    </SettingsSection>}
    <SettingsSection><RuntimeResources metrics={metrics} />{metrics?.warnings.map((warning) => <p className={`${noteClass} mt-3`} role="status" key={warning}>{localizeMessage(warning)}</p>)}</SettingsSection>
  </div>;
}
