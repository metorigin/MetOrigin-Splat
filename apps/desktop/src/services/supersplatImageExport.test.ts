import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridgeSource from "../../../../integrations/supersplat/metorigin-bridge.ts?raw";
import upstreamPin from "../../../../integrations/supersplat/upstream.json";
import { createEditorBridge, EDITOR_CHANNEL } from "./editorBridge";

const compiled = ts.transpileModule(bridgeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
type Sink = { write: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> };
type Settings = { format: string; width?: number; height?: number; projection?: "standard" | "equirect"; transparentBg?: boolean; showDebug?: boolean };
type Render = (settings: Settings, sink?: Sink) => Promise<boolean>;
type Envelope = { channel: string; kind?: string; id: string; command?: string; result?: unknown; error?: string; data?: { exportId: string; format: string; bytes?: ArrayBuffer } };
type RenderFlags = { lockedRenderMode: boolean; lockedRender: boolean; forceRender: boolean };

function eventHub() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const on = vi.fn((name: string, callback: (...args: unknown[]) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(callback);
    return { off: vi.fn(() => listeners.get(name)!.delete(callback)) };
  });
  const fire = vi.fn((name: string, ...args: unknown[]) => {
    for (const callback of [...listeners.get(name) ?? []]) callback(...args);
  });
  return { on, fire, count: (name: string) => listeners.get(name)?.size ?? 0 };
}

function adapter(render: Render, persist: (data: NonNullable<Envelope["data"]>) => Promise<string | null> = async () => "/chosen/scene.webp", options: {
  scene?: RenderFlags; events?: ReturnType<typeof eventHub>; control?: (command: string) => Promise<unknown>;
} = {}) {
  let receive!: (event: { source: unknown; origin: string; data: Envelope }) => Promise<void>;
  const messages: Envelope[] = [];
  const events = options.events ?? eventHub();
  const scene = options.scene ?? { lockedRenderMode: false, lockedRender: false, forceRender: false };
  const savedEvents = events.fire;
  const functions = new Map<string, Render>([["render.image", render]]);
  const parent = { postMessage: vi.fn((data: Envelope, origin: string, transfer: Transferable[] = []) => {
    expect(origin).toBe("https://editor.test");
    messages.push(data);
    if (data.kind !== "image-export") return;
    if (data.command === "save") expect(transfer).toEqual([data.data!.bytes]);
    else expect(transfer).toEqual([]);
    void Promise.resolve().then(async () => {
      let response: Pick<Envelope, "result" | "error">;
      try { response = { result: data.command === "save" ? await persist(data.data!) : options.control ? await options.control(data.command!) : true }; }
      catch (error) { response = { error: String(error) }; }
      await receive({ source: parent, origin, data: { channel: EDITOR_CHANNEL, kind: "image-export-reply", id: data.id, ...response } });
    });
  }) };
  const exports: { registerMetOriginBridge?: (events: unknown, scene: unknown) => void } = {};
  const scope = {
    exports,
    require: (name: string) => {
      if (name === "@playcanvas/splat-transform") return { MemoryFileSystem: class {} };
      if (name === "playcanvas") return { Vec3: class {} };
      if (name === "./splat-serialize") return {};
      if (name === "./ui/localization") return { i18n: { setLanguage: async () => undefined } };
      if (name === "./ui/metorigin-theme") return { applyEditorTheme: () => true, createEditorLanguageOwner: () => ({ fromHost: async () => undefined, fromEditor: async () => undefined }) };
      throw new Error(name);
    },
    window: {
      parent,
      location: { origin: "https://editor.test" },
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      addEventListener: (_type: string, listener: typeof receive) => { receive = listener; },
    },
    crypto,
    ArrayBuffer,
    Uint8Array,
  };
  new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  exports.registerMetOriginBridge!({ functions, invoke: () => true, fire: savedEvents, on: events.on }, scene);
  const command = async (name: string, payload?: unknown) => {
    const id = crypto.randomUUID();
    await receive({ source: parent, origin: "https://editor.test", data: { channel: EDITOR_CHANNEL, id, command: name, data: payload as Envelope["data"] } });
    return messages.find((message) => message.id === id)!;
  };
  return { render: (format = "webp", sink?: Sink, settings: Partial<Settings> = {}) => functions.get("render.image")!({ ...settings, format }, sink), enable: () => command("ping", { nativeImageSave: true }), command, messages, savedEvents, receive, parent, scene, events };
}

function renderer(bytes: Uint8Array, beforeWrite?: () => void) {
  const restored = vi.fn();
  const failures = vi.fn();
  // Match the pinned renderer's write/close/error/finally lifecycle, including
  // its second close on failure. The adapter must not save partial/empty data.
  const render = vi.fn<Render>(async (_settings, sink) => {
    try {
      beforeWrite?.();
      await sink!.write(bytes);
      await sink!.close();
      return true;
    } catch (error) {
      await sink!.close().catch(() => undefined);
      failures(error);
      return false;
    } finally { restored(); }
  });
  return { render, restored, failures };
}

afterEach(() => vi.useRealTimers());

describe("embedded image renderer native transport", () => {
  it.each(["png", "jpeg", "webp"])("sends only the encoded view for %s and leaves model dirty state alone", async (format) => {
    const source = new Uint8Array([90, 1, 2, 3, 91]);
    const original = renderer(source.subarray(1, 4));
    const save = vi.fn(async () => "/chosen/image");
    const bridge = adapter(original.render, save);
    await bridge.enable();
    expect(await bridge.render(format)).toBe(true);
    expect(bridge.messages.filter((message) => message.kind === "image-export").map((message) => message.command)).toEqual(["begin", "save", "end"]);
    expect(save).toHaveBeenCalledOnce();
    const input = save.mock.calls[0] as unknown as [{ format: string; bytes: ArrayBuffer }];
    expect(input[0].format).toBe(format);
    expect(new Uint8Array(input[0].bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(source).toEqual(new Uint8Array([90, 1, 2, 3, 91]));
    expect(original.restored).toHaveBeenCalledOnce();
    expect(bridge.savedEvents).not.toHaveBeenCalled();
  });

  it("does not replace caller-owned streams or activate before host handshake", async () => {
    const original = vi.fn<Render>(async () => true);
    const bridge = adapter(original);
    expect(await bridge.render()).toBe(true);
    const stream = { write: vi.fn(), close: vi.fn() };
    await bridge.enable();
    expect(await bridge.render("png", stream)).toBe(true);
    expect(original.mock.calls[1][1]).toBe(stream);
    expect(bridge.messages.filter((message) => message.kind === "image-export")).toHaveLength(0);
  });

  it("returns cancellation without an error popup or doc.saved", async () => {
    const original = renderer(new Uint8Array([1]));
    const bridge = adapter(original.render, async () => null);
    await bridge.enable();
    expect(await bridge.render()).toBe(false);
    expect(original.failures).not.toHaveBeenCalled();
    expect(original.restored).toHaveBeenCalledOnce();
    expect(bridge.savedEvents).not.toHaveBeenCalled();
  });

  it("does not open a save for encoder failure and safely handles the renderer's close", async () => {
    const original = renderer(new Uint8Array([1]), () => { throw new Error("encode failed"); });
    const save = vi.fn(async () => "unexpected");
    const bridge = adapter(original.render, save);
    await bridge.enable();
    expect(await bridge.render()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(original.failures).toHaveBeenCalledOnce();
    expect(original.restored).toHaveBeenCalledOnce();
    expect(bridge.messages.filter((message) => message.kind === "image-export").map((message) => message.command)).toEqual(["begin", "end"]);
  });

  it("does not retry a failed native save when upstream closes the stream twice", async () => {
    const original = renderer(new Uint8Array([1]));
    const save = vi.fn(async () => { throw new Error("disk full"); });
    const bridge = adapter(original.render, save);
    await bridge.enable();
    expect(await bridge.render()).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    expect(original.failures).toHaveBeenCalledOnce();
    expect(original.restored).toHaveBeenCalledOnce();
    expect((await bridge.command("dirty")).result).toBe(true);
  });

  it("waits for the native user dialog without freeing the editor or accepting another export", async () => {
    vi.useFakeTimers();
    let finish!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolve) => { finish = resolve; });
    const original = renderer(new Uint8Array([1]));
    const save = vi.fn(() => pending);
    const bridge = adapter(original.render, save);
    await bridge.enable();
    const rendering = bridge.render();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(original.restored).not.toHaveBeenCalled();
    await expect(bridge.render()).rejects.toThrow("正在处理");
    finish(null);
    expect(await rendering).toBe(false);
    expect(original.restored).toHaveBeenCalledOnce();
  });

  it("rejects invalid/empty payloads before native persistence", async () => {
    const original = renderer(new Uint8Array());
    const save = vi.fn(async () => "unexpected");
    const bridge = adapter(original.render, save);
    await bridge.enable();
    expect(await bridge.render()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await expect(bridge.render("svg")).rejects.toThrow("不支持");
  });

  it.each(["encoder", "native-save"])("unblocks the iframe before upstream awaits its %s error popup", async (failure) => {
    let dismiss!: () => void;
    const popup = new Promise<void>((resolve) => { dismiss = resolve; });
    const popupVisible = vi.fn();
    const render: Render = async (_settings, sink) => {
      try {
        if (failure === "encoder") throw new Error("encode failed");
        await sink!.write(new Uint8Array([1]));
        await sink!.close();
        return true;
      } catch {
        await sink!.close().catch(() => undefined);
        popupVisible();
        await popup;
        return false;
      }
    };
    const bridge = adapter(render, async () => { throw new Error("disk full"); });
    await bridge.enable();
    const rendering = bridge.render();
    await vi.waitFor(() => expect(popupVisible).toHaveBeenCalledOnce());
    expect(bridge.messages.filter((message) => message.command === "end")).toHaveLength(1);
    expect(bridge.events.count("update")).toBe(1);
    bridge.scene.lockedRender = false;
    bridge.scene.forceRender = false;
    bridge.events.fire("update");
    expect(bridge.scene.lockedRender).toBe(false);
    dismiss();
    expect(await rendering).toBe(false);
    expect(bridge.messages.filter((message) => message.command === "end")).toHaveLength(1);
    expect(bridge.events.count("update")).toBe(0);
    expect(bridge.scene.lockedRenderMode).toBe(false);
  });

  it("preserves the native error once across the real parent/child protocol and idempotent end", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const child = frame.contentWindow!;
    const origin = window.location.origin;
    let receive!: (event: unknown) => Promise<void>;
    const hostPost = vi.spyOn(window, "postMessage").mockImplementation((data) => {
      window.dispatchEvent(new MessageEvent("message", { source: child, origin, data }));
    });
    const childPost = vi.spyOn(child, "postMessage").mockImplementation((data) => {
      void receive({ source: window, origin, data });
    });
    const end = vi.fn();
    const save = vi.fn(async () => { throw new Error("disk full"); });
    const host = createEditorBridge(child, origin, { imageExport: { begin: vi.fn(), save, end } });
    const errors: string[] = [];
    const original: Render = async (_settings, sink) => {
      try {
        await sink!.write(new Uint8Array([1]));
        await sink!.close();
        return true;
      } catch (error) {
        await sink!.close().catch(() => undefined);
        // The real UI awaits a dismissible popup at this point.
        expect(end).toHaveBeenCalledOnce();
        errors.push(String(error));
        return false;
      }
    };
    const functions = new Map([["render.image", original]]);
    const savedEvents = vi.fn();
    const exports: { registerMetOriginBridge?: (events: unknown, scene: unknown) => void } = {};
    const scope = {
      exports,
      require: (name: string) => name === "./ui/localization" ? { i18n: { setLanguage: async () => undefined } }
        : name === "./ui/metorigin-theme" ? { createEditorLanguageOwner: () => ({ fromEditor: async () => undefined }) } : {},
      window: { parent: window, location: { origin }, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), addEventListener: (_name: string, callback: typeof receive) => { receive = callback; } },
      crypto, ArrayBuffer, Uint8Array,
    };
    try {
      new Function(...Object.keys(scope), compiled)(...Object.values(scope));
      exports.registerMetOriginBridge!({ functions, invoke: () => true, fire: savedEvents, on: eventHub().on }, { lockedRenderMode: false, lockedRender: false, forceRender: false });
      await host.request("ping", { nativeImageSave: true }).result;
      await expect(functions.get("render.image")!({ format: "webp" })).resolves.toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("disk full");
      expect(errors[0]).not.toContain("会话已结束");
      expect(save).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledOnce();
      expect(savedEvents).not.toHaveBeenCalled();
    } finally {
      host.dispose(); hostPost.mockRestore(); childPost.mockRestore(); frame.remove();
    }
  });
});

describe("native image render guard lifecycle", () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])("restores both original flags (%s, %s) and removes only its own listener", async (lockedRenderMode, lockedRender) => {
    const scene = { lockedRenderMode, lockedRender, forceRender: false };
    const events = eventHub();
    const existingUpdate = vi.fn();
    events.on("update", existingUpdate);
    const original: Render = async (_settings, sink) => {
      expect(scene.lockedRenderMode).toBe(true);
      expect(events.count("update")).toBe(2);
      scene.lockedRender = false;
      events.fire("update");
      expect(scene.lockedRender).toBe(false);
      scene.forceRender = true;
      events.fire("update");
      expect(scene.lockedRender).toBe(true);
      await sink!.write(new Uint8Array([1]));
      await sink!.close();
      return true;
    };
    const bridge = adapter(original, undefined, { scene, events });
    await bridge.enable();
    expect(await bridge.render()).toBe(true);
    expect(scene).toMatchObject({ lockedRenderMode, lockedRender });
    expect(events.count("update")).toBe(1);
    const before = existingUpdate.mock.calls.length;
    scene.lockedRender = false;
    scene.forceRender = true;
    events.fire("update");
    expect(scene.lockedRender).toBe(false);
    expect(existingUpdate).toHaveBeenCalledTimes(before + 1);
    expect(bridge.savedEvents.mock.calls.some(([name]) => name === "view.setStochastic" || name === "doc.saved")).toBe(false);
  });

  it.each(["cancel", "encoder", "native", "throw"])("restores render ownership after %s", async (outcome) => {
    const scene = { lockedRenderMode: false, lockedRender: true, forceRender: false };
    const original = outcome === "throw" ? vi.fn<Render>(async () => { throw new Error("renderer failed"); }) : renderer(new Uint8Array([1]), () => {
      if (outcome === "encoder") throw new Error("encoder failed");
    }).render;
    const bridge = adapter(original, async () => {
      if (outcome === "native") throw new Error("disk full");
      return null;
    }, { scene });
    await bridge.enable();
    if (outcome === "throw") await expect(bridge.render()).rejects.toThrow("renderer failed");
    else expect(await bridge.render()).toBe(false);
    expect(scene).toMatchObject({ lockedRenderMode: false, lockedRender: true });
    expect(bridge.events.count("update")).toBe(0);
  });

  it("does not acquire render ownership if begin is rejected and restores it before a failed end", async () => {
    const original = renderer(new Uint8Array([1]));
    let rejectedCommand = "begin";
    const bridge = adapter(original.render, undefined, { control: async (command) => {
      if (command === rejectedCommand) throw new Error(`${command} rejected`);
      return true;
    } });
    await bridge.enable();
    await expect(bridge.render()).rejects.toThrow("begin rejected");
    expect(original.render).not.toHaveBeenCalled();
    expect(bridge.events.on).not.toHaveBeenCalled();
    expect(bridge.scene).toEqual({ lockedRenderMode: false, lockedRender: false, forceRender: false });
    rejectedCommand = "end";
    await expect(bridge.render()).rejects.toThrow("end rejected");
    expect(bridge.events.count("update")).toBe(0);
    expect(bridge.scene.lockedRenderMode).toBe(false);
    expect(bridge.scene.lockedRender).toBe(false);
  });

  it("leaves fallback and caller-owned rendering flags and listeners untouched", async () => {
    const scene = { lockedRenderMode: false, lockedRender: true, forceRender: true };
    const original = vi.fn<Render>(async () => {
      expect(scene).toEqual({ lockedRenderMode: false, lockedRender: true, forceRender: true });
      return true;
    });
    const bridge = adapter(original, undefined, { scene });
    await bridge.render();
    await bridge.enable();
    await bridge.render("png", { write: vi.fn(), close: vi.fn() });
    expect(bridge.events.on).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledTimes(2);
  });
});

// These extra integration cases execute the pinned upstream implementation,
// never a reimplementation of its frame scheduler. Fresh checkouts can run the
// transport/lifecycle cases above before prepare:supersplat creates this cache.
// Resolve at runtime: Vite's static new URL(..., import.meta.url) asset rewrite
// would turn this filesystem fixture into an /@fs browser URL.
const testModuleUrl = import.meta.url;
const upstreamRoot = decodeURIComponent(new URL("../../../../target/supersplat-source/upstream", testModuleUrl).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
const pinnedSources = {
  "scene.ts": "23aa7be6f2832a9ae00f689ce1aa72115ac05f5b4ea36ff31486668218fe54fb",
  "render.ts": "cee4891738a5feee0ce0d82a38ebab0ab97b5cd03f7eef6edb56dfc63e91818f",
};
const hasUpstream = ts.sys.fileExists(`${upstreamRoot}/src/scene.ts`) && ts.sys.fileExists(`${upstreamRoot}/src/render.ts`);

function pinnedSource(name: keyof typeof pinnedSources) {
  expect(ts.sys.readFile(`${upstreamRoot}/.git/HEAD`)?.trim()).toBe(upstreamPin.commit);
  const text = ts.sys.readFile(`${upstreamRoot}/src/${name}`)!;
  // TypeScript's existing Node runtime supplies these filesystem/hash helpers;
  // frontend tests do not require adding Node ambient types to the browser app.
  const hashing = ts.sys as ts.System & { createSHA256Hash?: (text: string) => string };
  expect(hashing.createSHA256Hash).toBeTypeOf("function");
  expect(hashing.createSHA256Hash!(text)).toBe(pinnedSources[name]);
  return text;
}

function upstreamRenderer(encoderFailure = false) {
  const sceneSource = pinnedSource("scene.ts");
  const syntax = ts.createSourceFile("scene.ts", sceneSource, ts.ScriptTarget.ES2021, true);
  const sceneClass = syntax.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "Scene")!;
  const update = sceneClass.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(syntax) === "onUpdate")!;
  const updateCode = ts.transpileModule(`function ${update.getText(syntax).replace(/^private\s+/, "")}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const onUpdate = new Function("ElementTypeList", "ElementType", `${updateCode}; return onUpdate;`)([], { camera: "camera" }) as (this: object, delta: number) => void;
  const events = eventHub();
  const functions = new Map<string, unknown>();
  const popup = vi.fn(async (..._args: unknown[]) => undefined);
  const invoke = vi.fn((name: string, ...args: unknown[]) => {
    if (name === "view.stochastic") return "enabled";
    if (name === "view.perfOverlay") return false;
    if (name === "bgClr") return {};
    if (name === "showPopup") return popup(...args);
    const fn = functions.get(name) as ((...args: unknown[]) => unknown) | undefined;
    return fn?.(...args);
  });
  const state = { reset: () => undefined, compare: () => ({ added: [], removed: [], moved: ["camera"], changed: [] }) };
  const scene = {
    events: { ...events, invoke }, lockedRenderMode: false, lockedRender: false,
    forceRender: false, forceInteracting: false, movingRender: false,
    frameTimings: { gpuSupported: true }, sceneState: [state, state],
    app: { frame: 0, renderNextFrame: false, graphicsDevice: { gpuProfiler: { enabled: true } } },
    forEachElement: () => undefined,
    graphicsDevice: { maxTextureSize: 4096 },
    getElementsByType: () => [],
    camera: {
      startOffscreenMode: vi.fn(), endOffscreenMode: vi.fn(), renderOverlays: true,
      clearPass: { setClearColor: vi.fn() }, mainTarget: {},
      workTarget: { colorBuffer: { read: vi.fn(async () => undefined) } },
      fov: 70, ortho: true, position: {}, azim: 0,
      mainCamera: { getRotation: () => ({}) }, setPoseOverride: vi.fn(),
    },
    gizmoLayer: { enabled: true }, centersLayer: { enabled: true },
    bound: { halfExtents: { length: () => 1 }, center: {} },
    dataProcessor: { copyRt: vi.fn() },
  };
  const frames: { sorted: boolean; scheduled: boolean; locked: boolean; profiled: boolean }[] = [];
  const tick = () => {
    scene.app.renderNextFrame = false;
    onUpdate.call(scene, 1 / 60);
    scene.app.frame++;
    const result = { sorted: !scene.movingRender, scheduled: scene.app.renderNextFrame, locked: scene.lockedRenderMode, profiled: scene.app.graphicsDevice.gpuProfiler.enabled };
    return result;
  };
  const on = events.on.getMockImplementation()!;
  events.on.mockImplementation((name, callback) => {
    const handle = on(name, callback);
    if (name === "postrender") queueMicrotask(() => {
      frames.push(tick());
      // Deliver the GPU boundary even on an invalid schedule so a regression
      // fails the explicit scheduled assertion rather than hanging the test.
      events.fire("postrender");
    });
    return handle;
  });
  const encode = vi.fn(async () => {
    if (encoderFailure) throw new Error("encode failed");
    return new Uint8Array([1, 2, 3]);
  });
  class Vector { copy() { return this; } sub2() { return this; } length() { return 1; } }
  class Rotation { copy() { return this; } setFromEulerAngles() { return this; } mul2() { return this; } }
  class Equirect {
    static faceRotations = Array.from({ length: 6 }, () => ({}));
    static faceFov = 90;
    faceTargets = Array.from({ length: 6 }, () => ({}));
    project() { /* GPU boundary */ }
    read() { return Promise.resolve(); }
    destroy() { /* GPU boundary */ }
  }
  const exports: { registerRenderEvents?: (scene: unknown, events: unknown) => void } = {};
  const scope = {
    exports,
    require: (name: string) => {
      if (name === "playcanvas") return { Color: class {}, Vec3: Vector, Quat: Rotation };
      if (name === "./element") return { ElementType: { splat: "splat" } };
      if (name === "./png-writer") return { encodePng: encode };
      if (name === "./equirect-renderer") return { EquirectRenderer: Equirect };
      if (name === "@playcanvas/splat-transform") return { WebPCodec: { create: async () => ({ encodeLosslessRGBA: () => {
        if (encoderFailure) throw new Error("encode failed");
        return new Uint8Array([1, 2, 3]);
      } }) } };
      if (name === "./ui/localization") return { i18n: { t: (key: string) => key } };
      return {};
    },
    Uint8Array, Uint8ClampedArray,
    ImageData: class {},
    OffscreenCanvas: class {
      getContext() { return { putImageData() { /* canvas boundary */ } }; }
      async convertToBlob() { return { arrayBuffer: async () => (await encode()).buffer }; }
    },
  };
  const renderCode = ts.transpileModule(pinnedSource("render.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function(...Object.keys(scope), renderCode)(...Object.values(scope));
  exports.registerRenderEvents!(scene, { ...events, invoke, function: (name: string, fn: unknown) => functions.set(name, fn) });
  return { scene, events, invoke, popup, frames, tick, render: functions.get("render.image") as Render };
}

describe.skipIf(!hasUpstream)("pinned upstream image renderer and Scene.onUpdate (requires prepared cache)", () => {
  it.each(["png", "jpeg", "webp"])("captures a sorted %s frame and restores stochastic viewport scheduling", async (format) => {
    const real = upstreamRenderer();
    real.scene.forceRender = true;
    expect(real.tick()).toMatchObject({ sorted: false, scheduled: true, locked: false });
    const bridge = adapter(real.render, undefined, { scene: real.scene, events: real.events });
    await bridge.enable();
    expect(await bridge.render(format, undefined, { width: 2, height: 2, projection: "standard" })).toBe(true);
    expect(real.frames).toEqual([{ sorted: true, scheduled: true, locked: true, profiled: false }]);
    expect(real.events.count("update")).toBe(0);
    expect(real.events.count("postrender")).toBe(0);
    expect(real.scene.forceRender).toBe(true);
    expect(real.tick()).toMatchObject({ sorted: false, scheduled: true, locked: false });
    expect(real.invoke.mock.calls.some(([name]) => name === "view.setStochastic")).toBe(false);
    expect(real.popup).not.toHaveBeenCalled();
  });

  it("schedules all six real equirect faces, then permits a subsequent standard export", async () => {
    const real = upstreamRenderer();
    const bridge = adapter(real.render, undefined, { scene: real.scene, events: real.events });
    await bridge.enable();
    expect(await bridge.render("webp", undefined, { width: 4, height: 2, projection: "equirect" })).toBe(true);
    expect(real.frames).toHaveLength(6);
    expect(real.frames.every((frame) => frame.sorted && frame.scheduled && frame.locked && !frame.profiled)).toBe(true);
    expect(real.scene.camera.setPoseOverride).toHaveBeenCalledTimes(7);
    expect(real.scene.camera.setPoseOverride).toHaveBeenLastCalledWith(null);
    expect(real.scene.camera.fov).toBe(70);
    expect(real.scene.camera.ortho).toBe(true);
    expect(real.events.count("update")).toBe(0);
    expect(await bridge.render("png", undefined, { width: 2, height: 2 })).toBe(true);
    expect(real.frames).toHaveLength(7);
    expect(real.frames[6]).toMatchObject({ sorted: true, scheduled: true });
    expect(real.events.count("update")).toBe(0);
  });

  it.each(["cancel", "encoder", "native"])("restores the real renderer and scheduler after %s", async (outcome) => {
    const real = upstreamRenderer(outcome === "encoder");
    const bridge = adapter(real.render, async () => {
      if (outcome === "native") throw new Error("disk full");
      return null;
    }, { scene: real.scene, events: real.events });
    await bridge.enable();
    expect(await bridge.render("webp", undefined, { width: 2, height: 2 })).toBe(false);
    expect(real.frames).toEqual([{ sorted: true, scheduled: true, locked: true, profiled: false }]);
    expect(real.scene.camera.endOffscreenMode).toHaveBeenCalledOnce();
    expect(real.scene).toMatchObject({ lockedRenderMode: false, lockedRender: false, forceRender: true });
    expect(real.events.count("update")).toBe(0);
    expect(real.popup).toHaveBeenCalledTimes(outcome === "cancel" ? 0 : 1);
    expect(real.tick()).toMatchObject({ sorted: false, scheduled: true });
  });
});
