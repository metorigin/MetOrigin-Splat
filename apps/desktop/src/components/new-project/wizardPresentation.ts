import { getLocale, t } from "@/i18n";

export type DirectoryCheckState = {
  status: "idle" | "checking" | "success" | "error";
  message?: string;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return t("尚未测量");
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return t("尚未测量");
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes > 0
    ? t("{0} 分 {1} 秒", minutes, remainder.toFixed(1))
    : t("{0} 秒", remainder.toFixed(1));
}

export function presetLabel(id: string): string {
  return { fast: t("快速"), balanced: t("均衡"), quality: t("高质量") }[id] ?? id;
}

export function presetDescription(id: string, fallback: string): string {
  return {
    fast: t("使用较低分辨率和较少训练次数，快速验证素材能否完成重建。"),
    balanced: t("兼顾重建质量与处理时间，适合大多数场景。"),
    quality: t("使用更高分辨率和更多训练次数，保留更多细节，需要更多显存与磁盘空间。"),
  }[id] ?? fallback;
}

export function macExecutionSummary(warning: string): string | null {
  const parameters = warning.match(/^本次 Mac 执行参数：(\d+) 步，SH(\d+)，训练长边 (\d+) px，/);
  if (!parameters) return null;
  return t("本次 Mac：{0} 步 · SH{1} · {2}px", Number(parameters[1]).toLocaleString(getLocale()), parameters[2], parameters[3]);
}
