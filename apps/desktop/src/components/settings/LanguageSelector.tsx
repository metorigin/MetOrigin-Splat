import { useLanguage } from "../../hooks/useLanguage";
import { t, type LanguagePreference } from "../../i18n";
import { SettingsRow } from "./SettingsRow";
import { NativeSelect } from "@/components/ui/native-select";

export function LanguageSelector() {
  const { language, setLanguage } = useLanguage();
  return (
    <SettingsRow label={`${t("界面语言")} / Language`} htmlFor="language-preference">
      <NativeSelect id="language-preference" value={language} onChange={(event) => setLanguage(event.target.value as LanguagePreference)}>
        <option value="system">{t("跟随系统")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </NativeSelect>
    </SettingsRow>
  );
}
