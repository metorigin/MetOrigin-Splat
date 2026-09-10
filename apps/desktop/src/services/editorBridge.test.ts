import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorBridge, EDITOR_CHANNEL } from "./editorBridge";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("editor communication", () => {
  it("ignores responses from another origin or frame", async () => {
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const target = iframe.contentWindow!;
    const bridge = createEditorBridge(target, window.location.origin);
    const request = bridge.request<boolean>("dirty");
    const resolved = vi.fn(); void request.result.then(resolved);
    const data = { channel: EDITOR_CHANNEL, id: request.id, result: true };
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: "https://untrusted.example", data }));
    window.dispatchEvent(new MessageEvent("message", { source: window, origin: window.location.origin, data }));
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: window.location.origin, data }));
    await expect(request.result).resolves.toBe(true);
    bridge.dispose();
  });

  it("rejects stalled operations and disposed sessions instead of hanging", async () => {
    vi.useFakeTimers();
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const bridge = createEditorBridge(iframe.contentWindow!, window.location.origin);
    const request = bridge.request("load", undefined, [], 100);
    const failure = expect(request.result).rejects.toThrow("响应超时");
    await vi.advanceTimersByTimeAsync(100); await failure;
    const exporting = bridge.request("export");
    const closed = expect(exporting.result).rejects.toThrow("已关闭");
    bridge.dispose(); await closed;
  });
});
