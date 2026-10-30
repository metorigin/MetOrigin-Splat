import { localizeMessage, t } from "@/i18n";
import { FolderOpen, WarningCircle } from "@/components/primitives/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resourceMemory } from "@/lib/resourcePresentation";
import type { EngineInfo, ResourceMetrics } from "@/types";
import { SettingsSection } from "../SettingsSection";
import { formatSettingsBytes as formatBytes, settingsDefinitionClass as definitionClass, settingsNoteClass as noteClass } from "../settingsPresentation";

export function EngineSettings({ engines, loading, error, allReady, busy, metrics, version, onRefresh, onLocateEngine, onOpenEngine, onLocateDirectory }: {
  engines: EngineInfo[]; loading: boolean; error: string | null; allReady: boolean; busy: boolean;
  metrics: ResourceMetrics | null; version: string | null;
  onRefresh: () => void; onLocateEngine: (name: string) => void; onOpenEngine: (name: string) => void; onLocateDirectory: () => void;
}) {
  const memory = resourceMemory(metrics);
  return <div className="space-y-3">
    <SettingsSection title={t("重建引擎")} description={t("查看组件状态，启动任务前会再次检查运行环境。")}>
      <div className="mb-4"><Badge variant={allReady ? "success" : "warning"}>{allReady ? t("已就绪") : t("待检查")}</Badge></div>
      {loading && <p role="status" className={noteClass}>{t("正在检测引擎…")}</p>}
      {error && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert"><WarningCircle size={16} /><span className="min-w-0 flex-1">{t("引擎检测失败：")}{localizeMessage(error)}</span><Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>{t("重试检测")}</Button></div>}
      {!loading && !error && engines.length === 0 && <p className="mb-4 text-sm text-muted-foreground">{t("尚未检测")}</p>}
      <div className="divide-y divide-border/40">
        {engines.map((engine) => <article key={engine.name} className="space-y-3 py-4 first:pt-0">
          <div className="flex items-center justify-between gap-3"><strong className="text-sm font-medium">{engine.name}</strong><Badge variant={engine.available ? "success" : "destructive"}>{engine.available ? t("已验证") : t("不可用")}</Badge></div>
          <p className="text-sm">{t("版本：")}{engine.actual_version ?? engine.version ?? t("尚未检测")}</p>
          <p className="break-all text-xs text-muted-foreground" title={engine.path ?? undefined}>{engine.path ?? localizeMessage(engine.diagnostic) ?? t("尚未定位")}</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => onLocateEngine(engine.name)}>{t("单独定位")}</Button><Button variant="ghost" size="sm" disabled={!engine.path || busy} onClick={() => onOpenEngine(engine.name)}>{t("打开位置")}</Button></div>
        </article>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={onRefresh}>{t("重新检测")}</Button><Button variant="outline" disabled={busy} onClick={onLocateDirectory}><FolderOpen size={16} />{t("定位引擎与缓存目录")}</Button></div>
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
