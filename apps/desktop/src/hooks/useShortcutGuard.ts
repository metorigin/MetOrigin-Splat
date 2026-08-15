const EDITABLE_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
]);

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role]",
  );
  if (!editable) return false;
  const tagName = editable.tagName.toLowerCase();
  if (["input", "textarea", "select"].includes(tagName)) return true;
  if (editable.matches("[contenteditable]:not([contenteditable='false'])")) return true;
  return EDITABLE_ROLES.has(editable.getAttribute("role") ?? "");
}

export function hasOpenKeyboardOverlay(): boolean {
  return Boolean(document.querySelector("[data-modal-host], [data-keyboard-overlay='true']"));
}

export function shouldIgnoreShortcut(
  event: KeyboardEvent | ReactKeyboardEvent,
  overlayHandled = false,
): boolean {
  const nativeEvent = "nativeEvent" in event ? event.nativeEvent : event;
  return Boolean(
    event.defaultPrevented ||
      nativeEvent.isComposing ||
      event.keyCode === 229 ||
      isEditableEventTarget(event.target) ||
      overlayHandled ||
      hasOpenKeyboardOverlay(),
  );
}
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
