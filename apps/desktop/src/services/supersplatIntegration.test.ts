import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import bridgeSource from "../../../../integrations/supersplat/metorigin-bridge.ts?raw";
import { EDITOR_CHANNEL } from "./editorBridge";
import { createEditorLanguageOwner } from "../../../../integrations/supersplat/ui-theme/runtime";

// Execute the real integration bridge without a WebGL renderer or upstream build.
const themeSource = await import("../../../../integrations/supersplat/ui-theme/runtime.ts?raw");
const compiledTheme = ts.transpileModule(themeSource.default, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const compiledBridge = ts.transpileModule(bridgeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;

function importedModel(flipXY = true, translation = [0, 0, 0]) {
  const sign = flipXY ? -1 : 1;
  // Affine matrix fixture: translation must not affect transformVector.
  const matrix = [sign, 0, 0, 0, 0, sign, 0, 0, 0, 0, 1, 0, ...translation, 1];
  return { entity: { getWorldTransform: () => ({ transformVector: (input: { x: number; y: number; z: number }, output: typeof input) => {
    const { x, y, z } = input;
    output.x = matrix[0] * x + matrix[4] * y + matrix[8] * z;
    output.y = matrix[1] * x + matrix[5] * y + matrix[9] * z;
    output.z = matrix[2] * x + matrix[6] * y + matrix[10] * z;
    return output;
  } }) } };
}

function createIntegration(importModel: () => Promise<unknown> = async () => [importedModel()], empty = false) {
  const state = { dirty: false };
  const trace: string[] = [];
  const replies: { id: string; result?: unknown; error?: string }[] = [];
  const parent = { postMessage: vi.fn((reply) => { replies.push(reply); trace.push(`reply:${reply.id}`); }) };
  let listener: (event: unknown) => Promise<void>;
  const events = {
    functions: new Map<string, (...args: unknown[]) => unknown>([["render.image", vi.fn()]]),
    invoke: vi.fn((name: string, callback?: () => Promise<void>) => {
      switch (name) {
        case "import": trace.push("import"); return importModel();
        case "scene.empty": return empty;
        case "scene.dirty": return state.dirty;
        case "scene.splats": return [{}];
        case "queue": return callback!();
        default: throw new Error(`Unexpected event: ${name}`);
      }
    }),
    fire: vi.fn((name: string) => {
      trace.push(name);
      if (name === "doc.saved") state.dirty = false;
    }),
  };
  class MemoryFileSystem { results = new Map<string, Uint8Array>(); }
  const writeSplatFile = vi.fn(async (...args: unknown[]) => {
    (args[5] as MemoryFileSystem).results.set("scene.ply", new Uint8Array([1, 2, 3]));
  });
  const scene = { camera: {
    focus: vi.fn(() => { trace.push("camera.focus"); }),
    setAzimElev: vi.fn(() => { trace.push("camera.setAzimElev"); }),
  } };
  const bridgeExports: { registerMetOriginBridge?: (value: typeof events, scene: unknown) => void } = {};
  const themeExports = {};
  new Function("exports", "document", "getComputedStyle", "window", "Event", compiledTheme)(themeExports, document, getComputedStyle, window, Event);
  const languageSetter = vi.fn(async (_locale: string | null) => undefined);
  const localization = { setLanguage: languageSetter };
  const scope = {
    exports: bridgeExports,
    require: (name: string) => {
      if (name === "@playcanvas/splat-transform") return { MemoryFileSystem };
      if (name === "playcanvas") return { Vec3: class { constructor(public x: number, public y: number, public z: number) {} } };
      if (name === "./splat-serialize") return { writeSplatFile };
      if (name === "./ui/metorigin-theme") return themeExports;
      if (name === "./ui/localization") return { i18n: localization };
      throw new Error(`Unexpected module: ${name}`);
    },
    ArrayBuffer,
    File,
    window: {
      parent,
      location: { origin: "https://editor.test" },
      addEventListener: (_name: string, callback: typeof listener) => { listener = callback; },
    },
  };
  new Function(...Object.keys(scope), compiledBridge)(...Object.values(scope));
  bridgeExports.registerMetOriginBridge!(events, scene);
  const request = async (id: string, command: string, data?: unknown, envelope: { source?: unknown; origin?: string; channel?: string } = {}) => {
    await listener({ source: parent, origin: "https://editor.test", ...envelope, data: { channel: envelope.channel ?? EDITOR_CHANNEL, id, command, data } });
    return replies.find((reply) => reply.id === id)!;
  };
  return { events, state, trace, replies, request, writeSplatFile, languageSetter, localization,
    focus: scene.camera.focus, setAzimElev: scene.camera.setAzimElev };
}

describe("SuperSplat initial model framing", () => {
  it("retains standalone language choices and automatic reset", async () => {
    const setLanguage = vi.fn(async (_locale: string | null) => undefined);
    const standalone = createEditorLanguageOwner(setLanguage, false);
    await standalone.fromEditor("fr");
    await standalone.fromEditor(null);
    expect(setLanguage.mock.calls).toEqual([["fr"], [null]]);
  });
  it("keeps embedded preference/reset calls from overriding the host language without changing scene or dirty state", async () => {
    const bridge = createIntegration();
    bridge.state.dirty = true;
    expect((await bridge.request(crypto.randomUUID(), "language", { locale: "en-US" })).result).toBe(true);
    expect(bridge.languageSetter).toHaveBeenCalledTimes(1);
    expect(bridge.languageSetter).toHaveBeenCalledWith("en");
    expect(document.documentElement.lang).toBe("en");
    await bridge.localization.setLanguage(null); // Actual upstream Preferences Reset call.
    await bridge.localization.setLanguage("fr"); // Old independent Preferences selector.
    expect(bridge.languageSetter).toHaveBeenCalledTimes(1);
    for (const locale of [null, "fr", "system", "en-US<script>", "https://remote.example"]) {
      expect((await bridge.request(crypto.randomUUID(), "language", { locale })).error).toContain("Unsupported");
    }
    expect((await bridge.request(crypto.randomUUID(), "language", { locale: "zh-CN" })).result).toBe(true);
    expect(bridge.languageSetter).toHaveBeenLastCalledWith("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(bridge.state.dirty).toBe(true);
    expect(bridge.events.invoke).not.toHaveBeenCalled();
    expect(bridge.events.fire).not.toHaveBeenCalled();
  });
  it("synchronizes only validated UI themes, preserving dirty, camera, scene and save state", async () => {
    const bridge = createIntegration();
    bridge.state.dirty = true;
    document.documentElement.removeAttribute("data-theme");
    const repaint = vi.fn();
    window.addEventListener("metorigin-ui-theme", repaint);
    const id = crypto.randomUUID();
    expect((await bridge.request(id, "theme", { theme: "dark", version: "jan-v1" })).result).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(repaint).toHaveBeenCalledTimes(1);
    expect((await bridge.request(crypto.randomUUID(), "theme", { theme: "dark", version: "jan-v1" })).result).toBe(true);
    expect(repaint).toHaveBeenCalledTimes(1);
    await bridge.request(id, "theme", { theme: "light", version: "jan-v1" });
    expect(bridge.replies.at(-1)?.error).toContain("Duplicate");
    for (const data of [null, { theme: "system", version: "jan-v1" }, { theme: "light", version: "future" }, { theme: "body{}", version: "jan-v1" }]) {
      expect((await bridge.request(crypto.randomUUID(), "theme", data)).error).toContain("Unsupported");
      expect(document.documentElement.dataset.theme).toBe("dark");
    }
    expect((await bridge.request("invalid-id", "theme", { theme: "light", version: "jan-v1" })).error).toContain("Invalid");
    expect(bridge.state.dirty).toBe(true);
    expect(bridge.events.invoke).not.toHaveBeenCalled();
    expect(bridge.events.fire).not.toHaveBeenCalled();
    expect(bridge.focus).not.toHaveBeenCalled();
    window.removeEventListener("metorigin-ui-theme", repaint);
  });

  it("ignores theme messages from another frame, origin or channel", async () => {
    const bridge = createIntegration();
    for (const envelope of [{ source: {} }, { origin: "https://remote.example" }, { channel: "other" }]) {
      await bridge.request(crypto.randomUUID(), "theme", { theme: "light", version: "jan-v1" }, envelope);
    }
    expect(bridge.replies).toEqual([]);
  });
  it.each([false, true])("uses the actual import transform for the initial direction, excluding translation (PLY flip: %s)", async (flipXY) => {
    const bridge = createIntegration(async () => [importedModel(flipXY, [1000, -2000, 3000])]);
    await bridge.request("load", "load", { bytes: new ArrayBuffer(1), camera: { forward: [1, 0, 0], position: [-999, 888, 777], up: [0, 0, -1], fov_y_degrees: 13 } });
    expect(bridge.trace).toEqual(["import", "camera.focus", "camera.setAzimElev", "doc.saved", "reply:load"]);
    const [azim, elev, damping] = bridge.setAzimElev.mock.calls[0] as unknown as number[];
    expect(azim).toBeCloseTo(flipXY ? 90 : -90);
    expect(elev).toBeCloseTo(0);
    expect(damping).toBe(0);
    expect(bridge.focus).toHaveBeenCalledWith();
  });

  it.each([null, {}, { forward: [0, 0, 0] }, { forward: [NaN, 0, 1] }, { forward: [Infinity, 0, 1] }, { forward: [0, 1] }])("keeps the normal focus when optional camera metadata is invalid: %j", async (camera) => {
    const bridge = createIntegration();
    expect((await bridge.request("load", "load", { bytes: new ArrayBuffer(1), camera })).result).toBe(true);
    expect(bridge.focus).toHaveBeenCalledOnce();
    expect(bridge.setAzimElev).not.toHaveBeenCalled();
  });

  it.each([0, 2])("does not choose an arbitrary model transform when import returns %s models", async (count) => {
    const bridge = createIntegration(async () => Array.from({ length: count }, () => importedModel()));
    expect((await bridge.request("load", "load", { bytes: new ArrayBuffer(1), camera: { forward: [1, 0, 0] } })).result).toBe(true);
    expect(bridge.focus).toHaveBeenCalledOnce();
    expect(bridge.setAzimElev).not.toHaveBeenCalled();
  });

  it.each([{ source: {} }, { origin: "https://untrusted.example" }, { channel: "other-channel" }])("ignores untrusted load messages without importing or moving the camera: %j", async (envelope) => {
    const bridge = createIntegration();
    await bridge.request("load", "load", { bytes: new ArrayBuffer(1), camera: { forward: [1, 0, 0] } }, envelope);
    expect(bridge.trace).toEqual([]);
    expect(bridge.replies).toEqual([]);
    expect(bridge.events.invoke).not.toHaveBeenCalled();
  });

  it("waits for import before framing, marking saved, and acknowledging load", async () => {
    let finishImport!: () => void;
    const imported = new Promise<void>((resolve) => { finishImport = resolve; });
    const bridge = createIntegration(() => imported);
    const loading = bridge.request("load", "load", { bytes: new ArrayBuffer(1) });
    expect(bridge.trace).toEqual(["import"]);
    expect(bridge.replies).toEqual([]);
    expect((await bridge.request("during-import", "dirty")).result).toBe(true);
    finishImport();
    expect((await loading).result).toBe(true);
    expect(bridge.trace).toEqual(["import", "reply:during-import", "camera.focus", "doc.saved", "reply:load"]);
    expect((await bridge.request("after-import", "dirty")).result).toBe(false);
  });

  it.each(["empty", "failed"])("does not frame or mark saved after an %s import", async (outcome) => {
    const bridge = createIntegration(async () => {
      if (outcome === "failed") throw new Error("Import failed");
    }, outcome === "empty");
    const reply = await bridge.request("load", "load", { bytes: new ArrayBuffer(1) });
    expect(reply.error).toContain(outcome === "empty" ? "未找到可编辑的高斯" : "Import failed");
    expect(reply.result).toBeUndefined();
    expect(bridge.events.fire).not.toHaveBeenCalled();
    expect(bridge.focus).not.toHaveBeenCalled();
    expect((await bridge.request("after-failure", "dirty")).result).toBe(false);
  });

  it("preserves dirty and export/save acknowledgements without framing again", async () => {
    const bridge = createIntegration();
    await bridge.request("load", "load", { bytes: new ArrayBuffer(1), camera: { forward: [1, 0, 0] } });
    bridge.state.dirty = true;
    expect((await bridge.request("edited", "dirty")).result).toBe(true);
    const exported = await bridge.request("export-1", "export");
    expect(new Uint8Array(exported.result as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(bridge.state.dirty).toBe(true);
    expect((await bridge.request("blocked-export", "export")).error).toContain("编辑器正在处理");
    expect((await bridge.request("failed-save", "save-failed", { saveId: "export-1" })).result).toBe(true);
    expect((await bridge.request("after-failed-save", "dirty")).result).toBe(true);
    await bridge.request("export-2", "export");
    expect((await bridge.request("saved", "saved", { saveId: "export-2" })).result).toBe(true);
    expect((await bridge.request("after-saved", "dirty")).result).toBe(false);
    expect(bridge.writeSplatFile).toHaveBeenCalledTimes(2);
    expect(bridge.writeSplatFile).toHaveBeenLastCalledWith([{}], {}, "ply", "scene.ply", {}, expect.anything());
    expect(bridge.events.fire.mock.calls).toEqual([["doc.saved"], ["doc.saved"]]);
    expect(bridge.focus.mock.calls).toEqual([[]]);
    expect(bridge.setAzimElev).toHaveBeenCalledOnce();
  });
});
