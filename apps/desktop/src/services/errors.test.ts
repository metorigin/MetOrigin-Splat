import { describe, expect, it } from "vitest";

import { formatUiError, normalizeCommandError, redactSensitiveText } from "./errors";

describe("normalizeCommandError", () => {
  it("preserves safe structured fields and accurate retryability", () => {
    const error = normalizeCommandError(
      {
        code: "E-1201",
        category: "filesystem",
        title: "无法保存项目",
        user_message: "项目目录不可写。",
        impact: "当前操作未完成。",
        suggestions: ["检查目录权限"],
        retryable: false,
      },
      "create_project",
    );

    expect(error).toMatchObject({
      code: "E-1201",
      category: "filesystem",
      title: "无法保存项目",
      message: "项目目录不可写。",
      retryable: false,
    });
    expect(error.actions.some((action) => action.kind === "retry")).toBe(false);
  });

  it("accepts a JSON string payload", () => {
    const error = normalizeCommandError(
      JSON.stringify({
        code: "E-TEMP",
        category: "resource",
        title: "资源繁忙",
        user_message: "请稍后重试。",
        impact: "任务尚未开始。",
        suggestions: ["稍后重试"],
        retryable: true,
      }),
      "start_pipeline",
    );

    expect(error.code).toBe("E-TEMP");
    expect(error.actions).toContainEqual(
      expect.objectContaining({ kind: "retry", enabled: true }),
    );
  });

  it("uses a stable command fallback for legacy strings", () => {
    const error = normalizeCommandError("旧版后端错误", "list_recent_projects");

    expect(error.code).toBe("UI-RECENT-PROJECTS-LOAD");
    expect(error.message).toBe("旧版后端错误");
    expect(error.retryable).toBe(true);
  });

  it("redacts credentials and private Windows paths", () => {
    const source =
      "token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE at C:\\Users\\PrivateUser\\Projects\\secret.splat-project";
    const redacted = redactSensitiveText(source);

    expect(redacted).not.toContain("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(redacted).not.toContain("PrivateUser");
    expect(redacted).toContain("[REDACTED]");
  });

  it("falls back safely for unknown non-string errors", () => {
    const error = normalizeCommandError(new Error("boom"), "unknown_command");

    expect(error.code).toBe("UI-UNKNOWN-COMMAND");
    expect(error.retryable).toBe(false);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  it("keeps raw engine output and unrelated logs out of default and copied error details", () => {
    const error = normalizeCommandError(
      {
        code: "E-ENGINE-SAFE",
        category: "engine",
        title: "处理引擎未完成",
        user_message: "处理尚未完成，请检查引擎设置。",
        impact: "项目素材保持不变。",
        suggestions: ["打开设置并重新检查。"],
        retryable: false,
        technical_message:
          "RAW_ENGINE_OUTPUT_CANARY token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\engine.log",
        unrelated_log: "UNRELATED_LOG_CANARY",
      },
      "start_pipeline",
    );
    const defaultAndCopiedText = [
      error.title,
      error.message,
      error.impact,
      ...error.suggestions,
      formatUiError(error),
    ].join(" ");

    expect(defaultAndCopiedText).not.toContain("RAW_ENGINE_OUTPUT_CANARY");
    expect(defaultAndCopiedText).not.toContain("UNRELATED_LOG_CANARY");
    expect(defaultAndCopiedText).not.toContain("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(defaultAndCopiedText).not.toContain("PrivateUser");
    expect(error.technicalDetails).not.toContain("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(error.technicalDetails).not.toContain("PrivateUser");
  });
});
