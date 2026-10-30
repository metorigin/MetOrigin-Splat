import { t } from "@/i18n";
import type { Theme } from "@/hooks/useTheme";
import { NativeSelect } from "@/components/ui/native-select";
import { LanguageSelector } from "../LanguageSelector";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

export function AppearanceSettings({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return <SettingsSection title={t("外观")} description={t("选择工作区主题，或跟随系统外观。")}>
    <LanguageSelector />
    <SettingsRow label={t("界面主题")} htmlFor="theme-preference">
      <NativeSelect id="theme-preference" value={theme} onChange={(event) => onTheme(event.target.value as Theme)}><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option><option value="system">{t("跟随系统")}</option></NativeSelect>
    </SettingsRow>
  </SettingsSection>;
}
