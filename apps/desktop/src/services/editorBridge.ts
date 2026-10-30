import { t } from "../i18n";
export const EDITOR_CHANNEL = "metorigin-supersplat-v1";
export const EDITOR_THEME_VERSION = "jan-v1";
export type EditorTheme = "light" | "dark";
export const MAX_EDITOR_IMAGE_BYTES = 256 * 1024 * 1024;
export type EditorImageFormat = "png" | "jpeg" | "webp";

export interface EditorBridgeOptions {
  imageExport?: {
    begin: (format: EditorImageFormat) => void;
    save: (format: EditorImageFormat, bytes: ArrayBuffer) => Promise<string | null>;
    end: () => void;
  };
  imageExportTimeoutMs?: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const isFormat = (value: unknown): value is EditorImageFormat => value === "png" || value === "jpeg" || value === "webp";

/** Only accept messages from the local editor frame, never other windows. */
export function createEditorBridge(target: Window, origin: string, options: EditorBridgeOptions = {}) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }>();
  const seenMessages = new Set<string>();
  const seenExports = new Set<string>();
  const finishedExports = new Map<string, EditorImageFormat>();
  type ImageExport = { id: string; format: EditorImageFormat; state: "begun" | "saving" | "saved"; timer?: number; endRequest?: string };
  let active: ImageExport | undefined;
  let disposed = false;

  const reply = (id: string, result?: unknown, error?: string) => {
    if (disposed) return;
    try { target.postMessage({ channel: EDITOR_CHANNEL, kind: "image-export-reply", id, ...(error === undefined ? { result } : { error }) }, origin); }
    catch { /* A detached frame cannot receive replies; lifecycle cleanup must still run. */ }
  };
  const finish = (operation: ImageExport) => {
    if (active !== operation) return;
    window.clearTimeout(operation.timer);
    active = undefined;
    finishedExports.set(operation.id, operation.format);
    options.imageExport?.end();
  };
  const armWatchdog = (operation: ImageExport) => {
    window.clearTimeout(operation.timer);
    operation.timer = window.setTimeout(() => {
      // A native dialog/write has no timeout: it must settle before we unlock.
      if (active === operation && operation.state !== "saving") finish(operation);
    }, options.imageExportTimeoutMs ?? 180_000);
  };
  const receiveImageExport = (message: { id?: unknown; command?: unknown; data?: unknown }) => {
    if (!isUuid(message.id)) return;
    const id = message.id;
    const reject = (error: string) => reply(id, undefined, error);
    if (seenMessages.has(id.toLowerCase())) { reject(t("图像导出请求重复。")); return; }
    seenMessages.add(id.toLowerCase());
    const data = message.data as { exportId?: unknown; format?: unknown; bytes?: unknown } | null;
    if (!data || !isUuid(data.exportId) || !isFormat(data.format)) { reject(t("图像导出请求无效。")); return; }
    const exportId = data.exportId.toLowerCase();
    const { format } = data;
    const handler = options.imageExport;
    if (!handler) { reject(t("当前编辑器不支持原生图像保存。")); return; }

    if (message.command === "begin") {
      if (active) { reject(t("已有图像导出正在进行。")); return; }
      if (seenExports.has(exportId)) { reject(t("图像导出会话已结束，请重新导出。")); return; }
      seenExports.add(exportId);
      try {
        handler.begin(format);
        active = { id: exportId, format, state: "begun" };
        armWatchdog(active);
        reply(id, true);
      } catch (cause) {
        finishedExports.set(exportId, format);
        reject(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }

    // The child always ends in finally, including after a failed native save.
    // Acknowledge its cleanup without masking the original save error.
    if (message.command === "end" && finishedExports.get(exportId) === format) { reply(id, true); return; }
    const operation = active;
    if (!operation || operation.id !== exportId) { reject(t("图像导出会话已结束，请重新导出。")); return; }
    if (operation.format !== format) { reject(t("图像导出请求无效。")); return; }
    if (message.command === "end") {
      if (operation.endRequest) { reject(t("图像导出请求重复。")); return; }
      if (operation.state === "saving") operation.endRequest = id;
      else { finish(operation); reply(id, true); }
      return;
    }
    if (message.command !== "save") { reject(t("图像导出请求无效。")); return; }
    if (operation.state !== "begun") { reject(t("图像导出请求重复。")); return; }
    if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength === 0 || data.bytes.byteLength > MAX_EDITOR_IMAGE_BYTES) {
      finish(operation);
      reject(t("图像数据无效或超过 256 MiB 限制。"));
      return;
    }
    window.clearTimeout(operation.timer);
    operation.state = "saving";
    // Start synchronously, but normalize sync throws and promise rejection alike.
    let saved: Promise<string | null>;
    try { saved = handler.save(format, data.bytes); }
    catch (cause) { saved = Promise.reject(cause); }
    void Promise.resolve(saved).then((path) => {
      operation.state = "saved";
      reply(id, path);
      if (disposed || operation.endRequest) {
        finish(operation);
        if (operation.endRequest) reply(operation.endRequest, true);
      } else armWatchdog(operation);
    }, (cause: unknown) => {
      operation.state = "saved";
      finish(operation);
      reject(cause instanceof Error ? cause.message : String(cause));
      if (operation.endRequest) reply(operation.endRequest, true);
    });
  };

  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== target || event.origin !== origin || event.data?.channel !== EDITOR_CHANNEL) return;
    if (event.data.kind === "image-export") { receiveImageExport(event.data); return; }
    // Legacy command replies have no kind. An image message must not settle one.
    if (event.data.kind !== undefined) return;
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
        if (disposed) { reject(new Error(t("编辑窗口已关闭。"))); return; }
        if (command === "theme") {
          const theme = data as { theme?: unknown; version?: unknown } | null;
          if (!theme || (theme.theme !== "light" && theme.theme !== "dark") || theme.version !== EDITOR_THEME_VERSION) {
            reject(new Error("Unsupported editor theme or theme version.")); return;
          }
        }
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(t("编辑器响应超时，请检查模型大小或重新打开编辑器。")));
        }, timeout);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        try { target.postMessage({ channel: EDITOR_CHANNEL, id, command, data }, origin, transfer); }
        catch (cause) { pending.delete(id); window.clearTimeout(timer); reject(cause); }
      });
      return { id, result };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("message", receive);
      if (active) {
        window.clearTimeout(active.timer);
        if (active.state !== "saving") finish(active);
      }
      for (const request of pending.values()) {
        window.clearTimeout(request.timer);
        request.reject(new Error(t("编辑窗口已关闭。")));
      }
      pending.clear();
    },
  };
}

export type EditorBridge = ReturnType<typeof createEditorBridge>;
