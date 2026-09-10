import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";
import { getLocale, LANGUAGE_STORAGE_KEY, localizeMessage, resolveLocale, setLanguagePreference, t } from ".";
import { useLanguage } from "../hooks/useLanguage";
import { formatDate, getStageLabel, PROJECT_STATUS_LABELS } from "../localization";

afterEach(() => vi.restoreAllMocks());

describe("language selection", () => {
  it("detects Chinese and uses English for unsupported primary languages", () => {
    expect(resolveLocale("system", ["zh-CN", "en"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-TW"])).toBe("zh-CN");
    expect(resolveLocale("system", ["fr-FR", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
  });

  it("persists a selection and updates mounted consumers and the document", () => {
    const first = renderHook(useLanguage);
    const second = renderHook(useLanguage);
    act(() => first.result.current.setLanguage("en"));
    expect(second.result.current.locale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    first.unmount();
    expect(renderHook(useLanguage).result.current.language).toBe("en");
    expect(PROJECT_STATUS_LABELS.running).toBe("Running");
    expect(getStageLabel("BrushTraining")).toBe("Brush training");
    expect(formatDate("2026-09-10T00:00:00")).toBe(new Intl.DateTimeFormat("en", {year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date("2026-09-10T00:00:00")));
    act(() => second.result.current.setLanguage("zh-CN"));
    expect(PROJECT_STATUS_LABELS.running).toBe("运行中");
    expect(getStageLabel("Brush Training")).toBe("Brush 训练");
  });

  it("follows system and cross-window changes without overriding an explicit choice", () => {
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    setLanguagePreference("system");
    const hook = renderHook(useLanguage);
    expect(hook.result.current.locale).toBe("en");
    act(() => { languages.mockReturnValue(["zh-CN"]); window.dispatchEvent(new Event("languagechange")); });
    expect(hook.result.current.locale).toBe("zh-CN");
    act(() => hook.result.current.setLanguage("en"));
    act(() => window.dispatchEvent(new Event("languagechange")));
    expect(hook.result.current.locale).toBe("en");
    act(() => { localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN"); window.dispatchEvent(new StorageEvent("storage", {key: LANGUAGE_STORAGE_KEY})); });
    expect(hook.result.current.locale).toBe("zh-CN");
  });

  it("keeps switching usable with blocked storage and ignores invalid persisted values", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "invalid");
    expect(renderHook(useLanguage).result.current.language).toBe("system");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const hook = renderHook(useLanguage);
    act(() => hook.result.current.setLanguage("en"));
    expect(getLocale()).toBe("en");
    act(() => hook.result.current.setLanguage("zh-CN"));
    expect(getLocale()).toBe("zh-CN");
  });

  it("honors a session choice when storage is readable but writes fail", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("read-only"); });
    const hook = renderHook(useLanguage);
    act(() => hook.result.current.setLanguage("en"));
    expect(hook.result.current.locale).toBe("en");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  });
});

describe("message catalogs", () => {
  it("has complete English translations with identical interpolation slots", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toMatch(/[\u3400-\u9fff]/u);
      expect([...value.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(), key).toEqual([...key.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort());
    }
  });

  it("translates legacy backend diagnostics while preserving user names and paths", () => {
    setLanguagePreference("en");
    expect(localizeMessage("项目磁盘空间不足，还需要约 3.5 GiB。")).toBe("Insufficient disk space. Approximately 3.5 GiB more is required.");
    expect(localizeMessage("永久删除项目“新建项目”")).toBe("Permanently delete project “新建项目”");
    expect(localizeMessage("未找到文件或目录：D:\\素材\\新建项目")).toBe("File or folder not found: D:\\素材\\新建项目");
    expect(localizeMessage("开始Brush 训练。")).toBe("Starting Brush training.");
    expect(localizeMessage("创建前检查未通过：项目目录不存在。")).toBe("Pre-creation checks failed: The project folder does not exist.");
    expect(localizeMessage("Error: 预览文件已更新，请重新读取。")).toBe("Error: The preview file was updated. Read it again.");
    expect(localizeMessage(null)).toBeNull();
    expect(localizeMessage(undefined)).toBeUndefined();
    expect(localizeMessage("D:\\素材\\新建项目")).toBe("D:\\素材\\新建项目");
  });

  it("updates messages already held in state without guessing arbitrary English text", () => {
    setLanguagePreference("en");
    const pendingMessage = t("项目“{0}”已开始重建。", "训练项目");
    setLanguagePreference("zh-CN");
    expect(localizeMessage(pendingMessage)).toBe("项目“训练项目”已开始重建。");
    expect(localizeMessage("The confirmed action completed.")).toBe("The confirmed action completed.");
    expect(t("项目“{0}”已开始重建。", "<script>$&{1}</script>")).toBe("项目“<script>$&{1}</script>”已开始重建。");
  });
});
