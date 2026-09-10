import { t } from "../i18n";
export const EDITOR_CHANNEL = "metorigin-supersplat-v1";

/** Only accept replies from the local editor frame, never other windows. */
export function createEditorBridge(target: Window, origin: string) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }>();
  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== origin || event.data?.channel !== EDITOR_CHANNEL) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    window.clearTimeout(request.timer);
    if (typeof event.data.error === "string") request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  };
  window.addEventListener("message", receive);
  return {
    request<T>(command: string, data?: unknown, transfer: Transferable[] = [], timeout = 120_000): { id: string; result: Promise<T> } {
      const id = crypto.randomUUID();
      const result = new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(t("编辑器响应超时，请检查模型大小或重新打开编辑器。")));
        }, timeout);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        target.postMessage({ channel: EDITOR_CHANNEL, id, command, data }, origin, transfer);
      });
      return { id, result };
    },
    dispose() {
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        window.clearTimeout(request.timer);
        request.reject(new Error(t("编辑窗口已关闭。")));
      }
      pending.clear();
    },
  };
}

export type EditorBridge = ReturnType<typeof createEditorBridge>;
