import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GaussianPreviewSource, PreviewResourcePolicy } from "../../types";
import { GaussianSplatPreview } from "./GaussianSplatPreview";

// Keep the component, React DOM, Three scene/camera and OrbitControls real. Only
// GPU work and desktop IPC are replaced: jsdom cannot create a WebGL context.
const harness = vi.hoisted(() => ({
  get: vi.fn(), read: vi.fn(), camera: vi.fn(), policy: vi.fn(), poll: vi.fn(),
  meshes: [] as { dispose: ReturnType<typeof vi.fn> }[],
}));

vi.mock("../../services/desktop", () => ({ desktopApi: {
  getGaussianPreview: harness.get, readGaussianPly: harness.read,
  getGaussianCamera: harness.camera, getPreviewResourcePolicy: harness.policy,
  pollLivePreview: harness.poll,
} }));

vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement("canvas");
    setPixelRatio() {} setClearColor() {} setSize() {} setAnimationLoop() {}
    render() {} dispose() {}
  } };
});

vi.mock("@sparkjsdev/spark", async () => {
  const THREE = await import("three");
  return {
    SparkRenderer: class extends THREE.Object3D { dispose() {} },
    SplatMesh: class extends THREE.Object3D {
      numSplats = 4;
      initialized = Promise.resolve(this);
      dispose = vi.fn();
      constructor() { super(); harness.meshes.push(this); }
      forEachSplat() {}
      getBoundingBox() {
        return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
      }
    },
  };
});

type ControlInternals = OrbitControls & {
  _interceptControlDown: (event: KeyboardEvent) => void;
  _interceptControlUp: (event: KeyboardEvent) => void;
};
type ObservedControl = {
  control: ControlInternals;
  down: MockInstance<(event: KeyboardEvent) => void>;
  up: MockInstance<(event: KeyboardEvent) => void>;
  disposed: boolean;
  connectedRoot: Node;
  rootAtDispose?: Node;
  connectedAtDispose?: boolean;
};
type RootListener = {
  target: EventTarget;
  type: string;
  callback: EventListenerOrEventListenerObject;
  capture: boolean;
  owner: ObservedControl;
};

const controls: ObservedControl[] = [];
const listeners: RootListener[] = [];
const originalAdd = EventTarget.prototype.addEventListener;
const originalRemove = EventTarget.prototype.removeEventListener;
const originalConnect = OrbitControls.prototype.connect;
const originalDispose = OrbitControls.prototype.dispose;
const source: GaussianPreviewSource = {
  relative_path: "output/scene.ply", revision: "saved", vertex_count: 4,
  size_bytes: 64, iteration: null,
};
const props = {
  projectId: "orbit-lifecycle", projectPath: "/fixture/orbit-lifecycle",
  relativePath: source.relative_path, live: false, running: false,
};
const policy = (action: PreviewResourcePolicy["action"]): PreviewResourcePolicy => ({
  action, reason: action === "release" ? "critical_memory_pressure" : null,
  memory_pressure: action === "release" ? "critical" : "normal",
  poll_interval_ms: 500, max_snapshot_bytes: action === "release" ? 0 : 1024 ** 3,
});
const capture = (options?: boolean | EventListenerOptions) =>
  typeof options === "boolean" ? options : Boolean(options?.capture);

beforeEach(() => {
  vi.clearAllMocks();
  controls.length = 0;
  listeners.length = 0;
  harness.meshes.length = 0;
  harness.get.mockResolvedValue(source);
  harness.read.mockResolvedValue(new ArrayBuffer(64));
  harness.camera.mockResolvedValue(null);
  harness.policy.mockResolvedValue(policy("allow"));
  harness.poll.mockResolvedValue({});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

  // All spies call through. Observe the exact callbacks registered by the real
  // controls, including their registration target and capture flag.
  vi.spyOn(OrbitControls.prototype, "connect").mockImplementation(function (this: OrbitControls, element) {
    const control = this as ControlInternals;
    const observed: ObservedControl = {
      control,
      down: vi.spyOn(control, "_interceptControlDown"),
      up: vi.spyOn(control, "_interceptControlUp"),
      disposed: false,
      connectedRoot: element.getRootNode(),
    };
    controls.push(observed);
    originalConnect.call(this, element);
  });
  vi.spyOn(OrbitControls.prototype, "dispose").mockImplementation(function (this: OrbitControls) {
    const observed = controls.find((entry) => entry.control === this);
    if (observed) {
      observed.disposed = true;
      observed.rootAtDispose = this.domElement?.getRootNode();
      observed.connectedAtDispose = this.domElement?.isConnected;
    }
    originalDispose.call(this);
  });
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    const owner = controls.find((entry) => entry.control._interceptControlDown === callback
      || entry.control._interceptControlUp === callback);
    if (owner && callback && !listeners.some((entry) => entry.target === this
      && entry.type === type && entry.callback === callback && entry.capture === capture(options))) {
      listeners.push({ target: this, type, callback, capture: capture(options), owner });
    }
    originalAdd.call(this, type, callback, options);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    const index = listeners.findIndex((entry) => entry.target === this
      && entry.type === type && entry.callback === callback && entry.capture === capture(options));
    if (index !== -1) listeners.splice(index, 1);
    originalRemove.call(this, type, callback, options);
  });
});

afterEach(() => {
  cleanup();
  // A failing upstream version must not contaminate the next test. Remove only
  // listeners observed in this test, after all production assertions have run.
  for (const entry of listeners) {
    originalRemove.call(entry.target, entry.type, entry.callback, entry.capture);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectDisposedControlsInert() {
  const disposed = controls.filter((entry) => entry.disposed);
  const retainedBeforeProbe = listeners.filter((entry) => entry.owner.disposed);
  for (const entry of disposed) { entry.down.mockClear(); entry.up.mockClear(); }
  fireEvent.keyDown(document, { key: "Control", code: "ControlLeft" });
  fireEvent.keyUp(document, { key: "Control", code: "ControlLeft" });
  expect({
    retainedDocumentKeydown: retainedBeforeProbe.filter((entry) => entry.target === document && entry.type === "keydown").length,
    retainedDocumentKeyup: retainedBeforeProbe.filter((entry) => entry.target === document && entry.type === "keyup").length,
    retainedOtherRootListeners: retainedBeforeProbe.filter((entry) => entry.target !== document).length,
    disposedKeydownCalls: disposed.reduce((sum, entry) => sum + entry.down.mock.calls.length, 0),
    disposedKeyupCalls: disposed.reduce((sum, entry) => sum + entry.up.mock.calls.length, 0),
  }).toEqual({
    retainedDocumentKeydown: 0, retainedDocumentKeyup: 0,
    retainedOtherRootListeners: 0, disposedKeydownCalls: 0, disposedKeyupCalls: 0,
  });
}

describe("Gaussian preview with real OrbitControls and React DOM teardown", () => {
  it.each([
    { strict: false, held: false },
    { strict: true, held: false },
    { strict: true, held: true },
  ])("removes document listeners after unmount (StrictMode=$strict, Control held=$held)", async ({ strict, held }) => {
    const preview = <GaussianSplatPreview {...props} />;
    const view = render(strict ? <StrictMode>{preview}</StrictMode> : preview);
    await screen.findByText("4 高斯");
    const active = controls.filter((entry) => !entry.disposed);
    expect(active).toHaveLength(1);
    expect(controls.length).toBeGreaterThanOrEqual(strict ? 3 : 2);
    expect(controls.every((entry) => entry.connectedRoot === document)).toBe(true);
    expect(listeners.filter((entry) => entry.type === "keydown")).toHaveLength(1);
    if (held) fireEvent.keyDown(document, { key: "Control", code: "ControlLeft" });

    view.unmount();

    // This is the real React passive-effect ordering that caused the leak:
    // the canvas had a Document root at connect, but is detached at dispose.
    expect(active[0].disposed).toBe(true);
    expect(active[0].connectedAtDispose).toBe(false);
    expect(active[0].rootAtDispose).not.toBe(document);
    expect(view.container.querySelector("canvas")).toBeNull();
    expectDisposedControlsInert();
    expect(listeners).toHaveLength(0);
  });

  it("cleans held-Control listeners when pressure recovery replaces controls, then after StrictMode reentry", async () => {
    let action: PreviewResourcePolicy["action"] = "allow";
    harness.policy.mockImplementation(async () => policy(action));
    const view = render(<StrictMode><GaussianSplatPreview {...props} /></StrictMode>);
    await screen.findByText("4 高斯");
    const beforeRelease = controls.find((entry) => !entry.disposed)!;
    const allocatedControls = controls.length;
    fireEvent.keyDown(document, { key: "Control", code: "ControlLeft" });
    expect(listeners.some((entry) => entry.owner === beforeRelease && entry.type === "keyup")).toBe(true);

    action = "release";
    await screen.findByText("内存不足 · 预览已释放", {}, { timeout: 2500 });
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    // Pressure releases the mesh, while this component deliberately retains its
    // renderer/controls. Recovery calls fit(), replacing the controls instance.
    expect(controls).toHaveLength(allocatedControls);
    expect(beforeRelease.disposed).toBe(false);
    action = "allow";
    await screen.findByText("4 高斯", {}, { timeout: 2500 });
    expect(harness.meshes).toHaveLength(2);
    expect(beforeRelease.disposed).toBe(true);
    expect(beforeRelease.connectedAtDispose).toBe(true);
    expectDisposedControlsInert();

    view.unmount();
    expectDisposedControlsInert();
    expect(listeners).toHaveLength(0);

    const reentered = render(<StrictMode><GaussianSplatPreview {...props} /></StrictMode>);
    await screen.findByText("4 高斯");
    expect(controls.filter((entry) => !entry.disposed)).toHaveLength(1);
    expectDisposedControlsInert();
    reentered.unmount();
    expectDisposedControlsInert();
    expect(listeners).toHaveLength(0);
  });
});
