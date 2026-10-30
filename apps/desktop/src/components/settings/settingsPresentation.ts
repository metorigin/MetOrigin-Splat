import { t } from "@/i18n";
export const settingsNoteClass = "text-xs leading-relaxed text-muted-foreground";
export const settingsDefinitionClass = "grid gap-3 text-sm [&>div]:grid [&>div]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] [&>div]:gap-4 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:break-words [&_dd]:text-right [&_dd]:tabular-nums";
export function formatSettingsBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return t("尚未测量");
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
export function validStorageLimit(value: string, max: number) {
  return /^\d+$/.test(value) && Number.isInteger(Number(value)) && Number(value) >= 64 && Number(value) <= max;
}
