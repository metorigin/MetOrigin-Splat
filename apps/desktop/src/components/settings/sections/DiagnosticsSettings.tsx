import { t } from "@/i18n";
import { CheckCircle, DownloadSimple, WarningCircle } from "@/components/primitives/icons";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "../SettingsSection";

export function DiagnosticsSettings({ allReady, canExport, busy, onExport }: { allReady: boolean; canExport: boolean; busy: boolean; onExport: () => void }) {
  return <SettingsSection title={t("诊断")}>
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">{allReady ? <CheckCircle size={18} className="text-success" /> : <WarningCircle size={18} className="text-warning" />}<span>{allReady ? t("引擎诊断通过") : t("部分引擎需要处理")}</span></div>
      <Button disabled={!canExport || busy} onClick={onExport}><DownloadSimple size={16} />{t("导出脱敏诊断包")}</Button>
      {!canExport && <p className="text-xs leading-relaxed text-muted-foreground">{t("打开项目后可导出项目状态、日志尾部、引擎和硬件摘要。")}</p>}
    </div>
  </SettingsSection>;
}
