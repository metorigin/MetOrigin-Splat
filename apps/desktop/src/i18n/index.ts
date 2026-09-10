import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type Locale = "zh-CN" | "en";
export type LanguagePreference = "system" | Locale;
export type MessageKey = keyof typeof zhCN;
export const LANGUAGE_STORAGE_KEY = "metorigin.ui.language";
const CHANGE_EVENT = "metorigin-language-change";
let memoryPreference: LanguagePreference = "system";
let sessionPreference: LanguagePreference | null = null;

export function getLanguagePreference(): LanguagePreference {
  if (sessionPreference !== null) return sessionPreference;
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return saved === "en" || saved === "zh-CN" ? saved : "system";
  } catch { return memoryPreference; }
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  // Use the user's primary language. Unsupported languages fall back to English.
  return /^zh(?:-|$)/i.test(languages[0] ?? "") ? "zh-CN" : "en";
}

export function getLocale(): Locale {
  return resolveLocale(getLanguagePreference(), navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function syncDocumentLanguage(): void {
  document.documentElement.lang = getLocale();
}

export function setLanguagePreference(preference: LanguagePreference): void {
  memoryPreference = preference;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
    sessionPreference = null;
  } catch { sessionPreference = preference; }
  syncDocumentLanguage();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeLanguage(callback: () => void): () => void {
  const update = () => { syncDocumentLanguage(); callback(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) update();
  };
  window.addEventListener(CHANGE_EVENT, update);
  window.addEventListener("languagechange", update);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, update);
    window.removeEventListener("languagechange", update);
    window.removeEventListener("storage", onStorage);
  };
}

function interpolate(template: string, values: readonly unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? "") : placeholder);
}

const renderedMessages = new Map<string, { source: string; values: readonly unknown[] }>();
function remember(text: string, source: string, values: readonly unknown[]): string {
  if (values.length) {
    if (renderedMessages.size >= 2000) renderedMessages.delete(renderedMessages.keys().next().value!);
    renderedMessages.set(text, { source, values });
  }
  return text;
}

/** Source-language keys make translation edits easy to review alongside the UI. */
export function t(key: MessageKey, ...values: unknown[]): string {
  const template = getLocale() === "en" ? (en as Record<string, string>)[key] ?? key : zhCN[key];
  return remember(interpolate(template, values), key, values);
}

const entries = Object.entries(en);
const reverse = new Map(entries.map(([source, translated]) => [translated, source]));
function pattern(template: string): { regex: RegExp; slots: number[] } {
  const slots: number[] = [];
  const escaped = template.split(/(\{\d+\})/g).map((part) => {
    const slot = /^\{(\d+)\}$/.exec(part);
    if (slot) { slots.push(Number(slot[1])); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return { regex: new RegExp(`^${escaped}$`, "u"), slots };
}
// Legacy Rust IPC and saved activity records contain rendered messages. Match
// whole templates only; never substitute substrings in project names or paths.
const patterns = entries.filter(([source]) => /\{\d+\}/.test(source))
  .sort(([a], [b]) => b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length)
  .map(([source, translated]) => ({ source, translated, ...pattern(source) }));

/** Translate presentation text only. Keep IDs, paths, names and raw logs intact. */
export function localizeMessage(value: string): string;
export function localizeMessage(value: string | null): string | null;
export function localizeMessage(value: string | undefined): string | undefined;
export function localizeMessage(value: string | null | undefined): string | null | undefined;
export function localizeMessage(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  return translateMessage(value, 0);
}

function translateMessage(value: string | null | undefined, depth: number): string {
  if (!value) return value ?? "";
  if (depth > 5) return value;
  const locale = getLocale();
  if (locale === "en" && Object.prototype.hasOwnProperty.call(en, value)) return (en as Record<string, string>)[value];
  if (locale === "zh-CN" && reverse.has(value)) return reverse.get(value)!;
  const remembered = renderedMessages.get(value);
  if (remembered) {
    const values = [...remembered.values];
    for (const slot of messageSlots(remembered.source, values.length)) values[slot] = translateMessage(String(values[slot]), depth + 1);
    return interpolate(locale === "en" ? (en as Record<string, string>)[remembered.source] ?? remembered.source : remembered.source, values);
  }
  // Do not guess the meaning of arbitrary English text using a generic pattern.
  // Only messages previously rendered by this catalog can be reversed safely.
  if (locale === "zh-CN") return value;
  // Most diagnostics are already English. Avoid scanning them on every render.
  if (locale === "en" && !/[\u3400-\u9fff]/u.test(value)) return value;
  const errorPrefix = /^(?:Error|TypeError|RangeError|DesktopCommandError):\s*/.exec(value);
  if (errorPrefix) return errorPrefix[0] + translateMessage(value.slice(errorPrefix[0].length), depth + 1);
  for (const entry of patterns) {
    const { regex, slots } = entry;
    const match = regex.exec(value);
    if (!match) continue;
    const values: string[] = [];
    slots.forEach((slot, index) => { values[slot] = match[index + 1]; });
    // These slots contain messages or stage labels. Other slots (notably names
    // and filesystem paths) are always copied verbatim, even if they are Chinese.
    const nestedSlots = messageSlots(entry.source, values.length);
    for (const slot of nestedSlots) values[slot] = translateMessage(values[slot], depth + 1);
    return remember(interpolate(entry.translated, values), entry.source, values);
  }
  if (value.includes("\n")) return value.split("\n").map((line) => translateMessage(line, depth + 1)).join("\n");
  if (locale === "en" && value.includes("；")) return value.split("；").map((line) => translateMessage(line, depth + 1)).join("; ");
  return value;
}

function messageSlots(source: string, count: number): number[] {
  if (source === "{0}：{1}") return [0, 1];
  if (source === "{0}（错误代码：{1}）") return [0];
  if (source === "发现 {0} 张有效图片，{1}预设将均匀选取其中 {2} 张（包含首尾）。") return [1];
  if (source === "{0} 当前仅使用明确配置的外部引擎。") return [0];
  if (/^(?:开始\{0\}|\{0\}(?:已完成|失败|命中)|阶段“\{0\}”|从 \{0\} 阶段)/.test(source)) return [0];
  if (/(?:失败|异常结束|检查未通过|不可用|无法[^：]+)：\{\d+\}/.test(source)) return [count - 1];
  return [];
}
