import { t } from "@/i18n";
import type { AppSettings } from "@/types";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

export function GeneralSettings({ settings, busy, onSave }: { settings: AppSettings; busy: boolean; onSave: (settings: AppSettings) => void }) {
  return <SettingsSection title={t("常规")} description={t("配置新项目的默认创建方式。")}>
    <SettingsRow label={t("默认质量预设")} htmlFor="default-preset">
      <NativeSelect id="default-preset" disabled={busy} value={settings.default_preset} onChange={(event) => onSave({ ...settings, default_preset: event.target.value })}><option value="fast">{t("快速")}</option><option value="balanced">{t("均衡")}</option><option value="quality">{t("高质量")}</option></NativeSelect>
    </SettingsRow>
    <SettingsRow label={t("项目创建后自动开始重建")} description={t("更改会应用到之后创建的项目，不影响当前运行中的任务。")} htmlFor="create-and-start">
      <Switch id="create-and-start" disabled={busy} checked={settings.create_and_start} onCheckedChange={(checked) => onSave({ ...settings, create_and_start: checked })} />
    </SettingsRow>
  </SettingsSection>;
}
