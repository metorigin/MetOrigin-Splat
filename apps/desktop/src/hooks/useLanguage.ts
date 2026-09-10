import { useLayoutEffect, useSyncExternalStore } from "react";
import { getLanguagePreference, getLocale, setLanguagePreference, subscribeLanguage, syncDocumentLanguage } from "../i18n";

function snapshot() { return `${getLanguagePreference()}:${getLocale()}`; }

export function useLanguage() {
  const value = useSyncExternalStore(subscribeLanguage, snapshot);
  useLayoutEffect(syncDocumentLanguage, [value]);
  return { language: getLanguagePreference(), locale: getLocale(), setLanguage: setLanguagePreference };
}
