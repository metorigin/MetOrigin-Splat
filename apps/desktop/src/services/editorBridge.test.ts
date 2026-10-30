import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorBridge, EDITOR_CHANNEL } from "./editorBridge";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("editor communication", () => {
  it("validates theme payloads before posting and rejects expired/disposed theme requests", async () => {
    vi.useFakeTimers();
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    const target = iframe.contentWindow!;
    const post = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
    const bridge = createEditorBridge(target, window.location.origin);
    for (const data of [null, {}, { theme: "system", version: "jan-v1" }, { theme: "dark", version: "future" }, { css: "body{}" }]) {
      await expect(bridge.request("theme", data).result).rejects.toThrow("Unsupported editor theme");
    }
    expect(post).not.toHaveBeenCalled();
    const request = bridge.request("theme", { theme: "dark", version: "jan-v1" }, [], 100);
    expect(post.mock.calls[0][0]).toMatchObject({ command: "theme", data: { theme: "dark", version: "jan-v1" } });
    const expired = expect(request.result).rejects.toThrow("响应超时");
    await vi.advanceTimersByTimeAsync(100); await expired;
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: window.location.origin,
      data: { channel: EDITOR_CHANNEL, id: request.id, result: true } }));
    const pending = bridge.request("theme", { theme: "light", version: "jan-v1" });
    const disposed = expect(pending.result).rejects.toThrow("已关闭");
    bridge.dispose(); await disposed;
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function imageBridge(timeout = 100) {
  const iframe = document.createElement("iframe"); document.body.append(iframe);
  const target = iframe.contentWindow!;
  const post = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
  const handlers = { begin: vi.fn(), save: vi.fn().mockResolvedValue("/tmp/image.webp"), end: vi.fn() };
  const bridge = createEditorBridge(target, window.location.origin, { imageExport: handlers, imageExportTimeoutMs: timeout });
  const exportId = crypto.randomUUID();
  const send = (command: string, data: Record<string, unknown> = {}, id: string = crypto.randomUUID(), envelope: Record<string, unknown> = {}) => {
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: window.location.origin, data: {
      channel: EDITOR_CHANNEL, kind: "image-export", id, command, data: { exportId, format: "webp", ...data }, ...envelope,
    } }));
    return id;
  };
  const reply = (id: string) => {
    const messages = post.mock.calls.map(([message]) => message).filter((message) => message.id === id);
    return messages[messages.length - 1];
  };
  return { bridge, handlers, send, reply, post, target, exportId };
}

async function settle() { await Promise.resolve(); await Promise.resolve(); }

describe("native image export communication", () => {
  it("admits synchronously, transfers the image to the save callback, and unlocks only at end", async () => {
    const { bridge, handlers, send, reply } = imageBridge();
    const begin = send("begin");
    expect(handlers.begin).toHaveBeenCalledWith("webp");
    expect(reply(begin)).toMatchObject({ kind: "image-export-reply", result: true });
    const bytes = new ArrayBuffer(4);
    const save = send("save", { bytes });
    expect(handlers.save).toHaveBeenCalledWith("webp", bytes);
    await settle();
    expect(reply(save)).toMatchObject({ result: "/tmp/image.webp" });
    expect(handlers.end).not.toHaveBeenCalled();
    const end = send("end");
    expect(handlers.end).toHaveBeenCalledTimes(1);
    expect(reply(end)).toMatchObject({ result: true });
    bridge.dispose();
    expect(handlers.end).toHaveBeenCalledTimes(1);
  });

  it("ignores untrusted source, origin, channel, kind and malformed message UUIDs", () => {
    const { bridge, handlers, target, send, post, exportId } = imageBridge();
    const data = { channel: EDITOR_CHANNEL, kind: "image-export", id: crypto.randomUUID(), command: "begin", data: { exportId, format: "png" } };
    window.dispatchEvent(new MessageEvent("message", { source: window, origin: window.location.origin, data }));
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: "https://other.example", data }));
    send("begin", {}, crypto.randomUUID(), { channel: "other" });
    send("begin", {}, crypto.randomUUID(), { kind: "other" });
    send("begin", {}, "not-a-uuid");
    expect(handlers.begin).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does not allow an image message to resolve an ordinary editor command", async () => {
    const { bridge, send, target } = imageBridge();
    const request = bridge.request("dirty");
    const resolved = vi.fn(); void request.result.then(resolved);
    send("begin", {}, request.id);
    await settle();
    expect(resolved).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: target, origin: window.location.origin, data: { channel: EDITOR_CHANNEL, id: request.id, result: true } }));
    await expect(request.result).resolves.toBe(true);
    bridge.dispose();
  });

  it("rejects invalid export IDs, formats, unknown commands and saves without begin", () => {
    const { bridge, handlers, send, reply } = imageBridge();
    for (const [command, data] of [
      ["begin", { exportId: "invalid" }], ["begin", { format: "gif" }],
      ["save", { bytes: new ArrayBuffer(4) }], ["end", {}], ["unknown", {}],
    ] as const) {
      expect(reply(send(command, data))).toHaveProperty("error");
    }
    expect(handlers.begin).not.toHaveBeenCalled();
    expect(handlers.save).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("rejects duplicate messages, concurrent exports, repeated saves and reused export IDs", async () => {
    const { bridge, handlers, send, reply } = imageBridge();
    const begin = send("begin");
    expect(reply(send("begin", {}, begin))).toHaveProperty("error");
    expect(reply(send("begin", { exportId: crypto.randomUUID() }))).toHaveProperty("error");
    const native = deferred<string | null>(); handlers.save.mockReturnValue(native.promise);
    const bytes = new ArrayBuffer(4);
    const save = send("save", { bytes });
    expect(reply(send("save", { bytes }, save))).toHaveProperty("error");
    expect(reply(send("save", { bytes }))).toHaveProperty("error");
    expect(handlers.save).toHaveBeenCalledTimes(1);
    native.resolve("/tmp/image.webp"); await settle(); send("end");
    expect(reply(send("begin"))).toHaveProperty("error");
    expect(reply(send("save", { bytes }))).toHaveProperty("error");
    expect(handlers.begin).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it.each([new Uint8Array(4), new ArrayBuffer(0), new ArrayBuffer(256 * 1024 * 1024 + 1)])("rejects invalid or oversized bytes and releases the export", (bytes) => {
    const { bridge, handlers, send, reply } = imageBridge();
    send("begin");
    expect(reply(send("save", { bytes }))).toHaveProperty("error");
    expect(handlers.save).not.toHaveBeenCalled();
    expect(handlers.end).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("rejects a format change without permitting a save", () => {
    const { bridge, handlers, send, reply } = imageBridge();
    send("begin");
    expect(reply(send("save", { format: "png", bytes: new ArrayBuffer(4) }))).toHaveProperty("error");
    expect(handlers.save).not.toHaveBeenCalled();
    send("end");
    bridge.dispose();
  });

  it("cleans up begin-without-save and invalidates its late save", async () => {
    vi.useFakeTimers();
    const { bridge, handlers, send, reply } = imageBridge();
    send("begin");
    await vi.advanceTimersByTimeAsync(100);
    expect(handlers.end).toHaveBeenCalledTimes(1);
    expect(reply(send("save", { bytes: new ArrayBuffer(4) }))).toHaveProperty("error");
    expect(handlers.save).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("keeps a pending native dialog locked through watchdog time and early end until it settles", async () => {
    vi.useFakeTimers();
    const { bridge, handlers, send, reply } = imageBridge();
    const native = deferred<string | null>(); handlers.save.mockReturnValue(native.promise);
    send("begin");
    const save = send("save", { bytes: new ArrayBuffer(4) });
    const end = send("end");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(handlers.end).not.toHaveBeenCalled();
    expect(reply(save)).toBeUndefined(); expect(reply(end)).toBeUndefined();
    expect(reply(send("begin", { exportId: crypto.randomUUID() }))).toHaveProperty("error");
    expect(reply(send("end"))).toHaveProperty("error");
    native.resolve("/tmp/image.webp"); await settle();
    expect(reply(save)).toMatchObject({ result: "/tmp/image.webp" });
    expect(reply(end)).toMatchObject({ result: true });
    expect(handlers.end).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("returns cancellation as null and errors to the child, cleaning up rejected saves", async () => {
    const { bridge, handlers, send, reply } = imageBridge();
    handlers.save.mockResolvedValueOnce(null);
    send("begin");
    const cancelled = send("save", { bytes: new ArrayBuffer(4) }); await settle();
    expect(reply(cancelled)).toMatchObject({ result: null });
    expect(reply(cancelled)).not.toHaveProperty("error");
    send("end");
    const next = { exportId: crypto.randomUUID() };
    handlers.save.mockRejectedValueOnce(new Error("Disk full"));
    send("begin", next);
    const failed = send("save", { ...next, bytes: new ArrayBuffer(4) }); await settle();
    expect(reply(failed)).toMatchObject({ error: "Disk full" });
    expect(handlers.end).toHaveBeenCalledTimes(2);
    expect(reply(send("end", next))).toMatchObject({ result: true });
    expect(reply(send("end", next))).toMatchObject({ result: true });
    expect(reply(send("save", { ...next, bytes: new ArrayBuffer(4) }))).toHaveProperty("error");
    expect(reply(failed)).toMatchObject({ error: "Disk full" });
    expect(handlers.end).toHaveBeenCalledTimes(2);
    expect(handlers.save).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });

  it("returns synchronous admission and save failures without leaving a busy export", async () => {
    const { bridge, handlers, send, reply } = imageBridge();
    handlers.begin.mockImplementationOnce(() => { throw new Error("Editor busy"); });
    expect(reply(send("begin"))).toMatchObject({ error: "Editor busy" });
    expect(reply(send("end"))).toMatchObject({ result: true });
    expect(handlers.end).not.toHaveBeenCalled();
    const next = { exportId: crypto.randomUUID() };
    send("begin", next);
    handlers.save.mockImplementationOnce(() => { throw new Error("Native unavailable"); });
    const failed = send("save", { ...next, bytes: new ArrayBuffer(4) }); await settle();
    expect(reply(failed)).toMatchObject({ error: "Native unavailable" });
    expect(handlers.end).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("disposes without unlocking an outstanding native save or accepting new requests", async () => {
    const { bridge, handlers, send, post } = imageBridge();
    const native = deferred<string | null>(); handlers.save.mockReturnValue(native.promise);
    send("begin"); send("save", { bytes: new ArrayBuffer(4) });
    bridge.dispose(); bridge.dispose();
    expect(handlers.end).not.toHaveBeenCalled();
    const messages = post.mock.calls.length;
    send("begin", { exportId: crypto.randomUUID() });
    await expect(bridge.request("dirty").result).rejects.toThrow("已关闭");
    expect(handlers.begin).toHaveBeenCalledTimes(1);
    native.resolve(null); await settle();
    expect(handlers.end).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(messages);
  });
});
