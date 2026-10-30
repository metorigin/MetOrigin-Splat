/** WKWebView reports MacIntel on both Intel and Apple Silicon Macs. */
export function isMacPlatform(platform = navigator.platform): boolean {
  return /^Mac/i.test(platform);
}

export function primaryModifierLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform = navigator.platform,
): boolean {
  if (event.altKey || event.shiftKey) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
