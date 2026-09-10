import { useLanguage } from "../../hooks/useLanguage";
import { t, type LanguagePreference } from "../../i18n";

export function LanguageSelector() {
  const { language, setLanguage } = useLanguage();
  return (
    <label className="settings-field settings-language">
      <span>{t("界面语言")} / Language</span>
      <select value={language} onChange={(event) => setLanguage(event.target.value as LanguagePreference)}>
        <option value="system">{t("跟随系统")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
