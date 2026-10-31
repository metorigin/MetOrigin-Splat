import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Object3D, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { GaussianSplatPreview } from "./GaussianSplatPreview";
import type { GaussianCamera, GaussianPreviewSource, LivePreviewStatus } from "../../types";

const harness = vi.hoisted(() => ({
  get: vi.fn(), read: vi.fn(), poll: vi.fn(), camera: vi.fn(), policy: vi.fn(),
  meshInitialization: null as Promise<unknown> | null,
  meshSplatCount: 4,
  centers: [] as number[][],
  meshes: [] as { bytes: ArrayBuffer; dispose: ReturnType<typeof vi.fn>; object: Object3D }[],
  cameras: [] as PerspectiveCamera[],
  rendererCreate: vi.fn(),
  rendererDispose: vi.fn(),
  sparkDispose: vi.fn(),
  rendererConstructorError: null as Error | null,
  sparkConstructorError: null as Error | null,
}));

vi.mock("../../services/desktop", () => ({ desktopApi: {
  getGaussianPreview: harness.get, readGaussianPly: harness.read, pollLivePreview: harness.poll,
  getGaussianCamera: harness.camera, getPreviewResourcePolicy: harness.policy,
} }));

vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual,
    PerspectiveCamera: class extends actual.PerspectiveCamera {
      constructor(...args: ConstructorParameters<typeof actual.PerspectiveCamera>) { super(...args); harness.cameras.push(this); }
    },
    WebGLRenderer: class {
      constructor() { harness.rendererCreate(); if (harness.rendererConstructorError) throw harness.rendererConstructorError; }
      domElement = document.createElement("canvas");
      setPixelRatio() {} setClearColor() {} setSize() {} setAnimationLoop() {} render() {}
      dispose = harness.rendererDispose;
    },
  };
});

vi.mock("@sparkjsdev/spark", async () => {
  const THREE = await import("three");
  return {
    SparkRenderer: class extends THREE.Object3D {
      constructor() { super(); if (harness.sparkConstructorError) throw harness.sparkConstructorError; }
      dispose = harness.sparkDispose;
    },
    SplatMesh: class extends THREE.Object3D {
      numSplats = harness.meshSplatCount;
      initialized = harness.meshInitialization ?? Promise.resolve(this);
      dispose = vi.fn();
      constructor(options: { fileBytes: ArrayBuffer }) { super(); harness.meshes.push({ bytes: options.fileBytes, dispose: this.dispose, object: this }); }
      forEachSplat(callback: (index: number, center: Vector3, scales: Vector3, rotation: Quaternion, opacity: number) => void) {
        harness.centers.forEach((center, index) => callback(index, new THREE.Vector3(...center), new THREE.Vector3(1, 1, 1), new THREE.Quaternion(), 1));
      }
      getBoundingBox() { return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)); }
    },
  };
});

const first: GaussianPreviewSource = { relative_path: "training/live-preview/session/frame-1.ply", revision: "a", vertex_count: 4, size_bytes: 1024, iteration: 5 };
const second: GaussianPreviewSource = { ...first, relative_path: "training/live-preview/session/frame-2.ply", revision: "b", iteration: 10 };
const status = (frame: GaussianPreviewSource = first, revision = 1): LivePreviewStatus => ({ session_id: "session", available: true, running: true, revision, frame });
const props = { projectId: "project", projectPath: "D:/project", relativePath: null, running: true, live: true };
const capture: GaussianCamera = { position: [0, 0, 5], forward: [0, 0, -1], up: [0, -1, 0], fov_y_degrees: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  harness.meshes.length = 0; harness.cameras.length = 0; harness.meshInitialization = null; harness.meshSplatCount = 4;
  harness.rendererConstructorError = null; harness.sparkConstructorError = null;
  harness.centers = [];
  harness.policy.mockResolvedValue({ action:"allow",reason:null,memory_pressure:null,poll_interval_ms:500,max_snapshot_bytes:1024**3 });
  harness.get.mockResolvedValue(first);
  harness.camera.mockResolvedValue(null);
  harness.read.mockResolvedValue(new ArrayBuffer(1024));
  harness.poll.mockResolvedValue(status());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("Gaussian preview model lifecycle", () => {
  it("keeps a toolbar-free workspace preview navigable and reports resource pressure", async () => {
    harness.get.mockResolvedValue({ ...first, relative_path: "output/scene.ply" });
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" showToolbar={false} />);
    await waitFor(() => expect(harness.meshes).toHaveLength(1));
    expect(view.container.querySelector(".preview-toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "重置高斯视角" })).not.toBeInTheDocument();
    const canvas = screen.getByRole("application");
    expect(canvas.querySelector("canvas")).not.toBeNull();
    const camera = harness.cameras[0];
    camera.position.set(8, 9, 10);
    fireEvent.keyDown(canvas, { key: "r" });
    expect(camera.position.toArray()).not.toEqual([8, 9, 10]);

    harness.policy.mockResolvedValue({ action: "release", reason: "critical_memory_pressure", memory_pressure: "critical", poll_interval_ms: 500, max_snapshot_bytes: 0 });
    const notice = await screen.findByText("内存不足 · 预览已释放", {}, { timeout: 2000 });
    expect(notice.closest('[role="status"]')).toHaveClass("gaussian-preview-notice");
    expect(notice.closest('[role="status"]')).toHaveAttribute("data-feedback-variant", "warning");
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(harness.poll).not.toHaveBeenCalled();
    view.unmount();
  });

  it("releases an allocated renderer when Spark initialization fails", async () => {
    harness.sparkConstructorError = new Error("Spark initialization failed");
    const view = render(<GaussianSplatPreview {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Spark initialization failed");
    expect(harness.rendererDispose).toHaveBeenCalledOnce();
    expect(harness.sparkDispose).not.toHaveBeenCalled();
    expect(harness.read).not.toHaveBeenCalled();
    expect(view.container.querySelector("canvas")).toBeNull();
    view.unmount();
    expect(harness.rendererDispose).toHaveBeenCalledOnce();
  });

  it("reports WebGL construction failure without trying to release a missing renderer", async () => {
    harness.rendererConstructorError = new Error("WebGL unavailable");
    const view = render(<GaussianSplatPreview {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("WebGL unavailable");
    expect(harness.rendererDispose).not.toHaveBeenCalled();
    expect(harness.read).not.toHaveBeenCalled();
    view.unmount();
  });

  it("fits current bounds from the capture direction for an out-of-view saved model on every fresh mount", async () => {
    const THREE = await import("three");
    harness.centers = Array.from({ length: 30 }, (_, i) => [i % 3 - 1, 20 + Math.floor(i / 3) % 3, Math.floor(i / 9) - 1]);
    harness.camera.mockResolvedValue(capture);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
      await screen.findByText("4 高斯");
      const camera = harness.cameras[harness.cameras.length - 1];
      expect(camera.position.y).toBeGreaterThan(20);
      expect(camera.fov).toBe(52);
      expect(camera.up.toArray()).toEqual(capture.up);
      camera.getWorldDirection(new THREE.Vector3()).toArray().forEach((value, index) => expect(value).toBeCloseTo(capture.forward[index]));
      view.unmount();
    }
  });

  it("preserves navigation on replacement and restores capture direction with default FOV when reset falls back to bounds", async () => {
    const original = Array.from({ length: 30 }, (_, i) => [i % 3 - 1, Math.floor(i / 3) % 3 - 1, Math.floor(i / 9) - 1]);
    harness.centers = original;
    harness.camera.mockResolvedValue(capture);
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("4 高斯");
    const camera = harness.cameras[0];
    camera.position.toArray().forEach((value, index) => expect(value).toBeCloseTo([0, 0, 5][index]));
    expect(camera.fov).toBe(20);
    expect(camera.up.toArray()).toEqual([0, -1, 0]);
    camera.position.set(8, 9, 10);
    harness.centers = original.map(([x, y, z]) => [x, y + 20, z]);
    harness.get.mockResolvedValue({ ...first, revision: "saved" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(harness.meshes).toHaveLength(2));
    expect(camera.position.toArray()).toEqual([8, 9, 10]);
    fireEvent.click(screen.getByRole("button", { name: "重置高斯视角" }));
    expect(camera.fov).toBe(52);
    expect(camera.up.toArray()).toEqual(capture.up);
    const THREE = await import("three");
    const bounds = new THREE.Box3().setFromPoints(harness.centers.map((point) => new THREE.Vector3(...point)));
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    expect(camera.position.distanceTo(center)).toBeCloseTo(radius / Math.sin(THREE.MathUtils.degToRad(26)) * 1.1);
    camera.getWorldDirection(new THREE.Vector3()).toArray().forEach((value, index) => expect(value).toBeCloseTo(capture.forward[index]));
    view.unmount();
  });

  it("keeps the explicit overview on its existing direction and up axis", async () => {
    const THREE = await import("three");
    harness.centers = Array.from({ length: 30 }, (_, i) => [i % 3 - 1, 20 + Math.floor(i / 3) % 3, Math.floor(i / 9) - 1]);
    harness.camera.mockResolvedValue(capture);
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("4 高斯");
    const camera = harness.cameras[0];
    fireEvent.click(screen.getByRole("button", { name: "查看模型整体" }));
    const expected = new THREE.Vector3(-1.2, -0.6, -1.8).normalize().toArray();
    camera.getWorldDirection(new THREE.Vector3()).toArray().forEach((value, index) => expect(value).toBeCloseTo(expected[index]));
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(camera.fov).toBe(52);
    view.unmount();
  });

  it.each<[string, GaussianCamera | null]>([
    ["missing capture", null],
    ["zero forward", { ...capture, forward: [0, 0, 0] }],
    ["zero up", { ...capture, up: [0, 0, 0] }],
    ["parallel axes", { ...capture, up: [0, 0, 1] }],
    ["nonfinite position", { ...capture, position: [NaN, 0, 5] }],
    ["nonfinite direction", { ...capture, forward: [Infinity, 0, -1] }],
    ["invalid field of view", { ...capture, fov_y_degrees: 180 }],
  ])("uses a finite default view for %s", async (_name, pose) => {
    const THREE = await import("three");
    harness.camera.mockResolvedValue(pose);
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("4 高斯");
    const camera = harness.cameras[0];
    const expected = new THREE.Vector3(-1.2, -0.6, -1.8).normalize().toArray();
    expect([...camera.position.toArray(), ...camera.quaternion.toArray(), ...camera.projectionMatrix.elements].every(Number.isFinite)).toBe(true);
    camera.getWorldDirection(new THREE.Vector3()).toArray().forEach((value, index) => expect(value).toBeCloseTo(expected[index]));
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(camera.fov).toBe(52);
    view.unmount();
  });

  it("passes complete binary data to the renderer and disposes it on unmount", async () => {
    const data = new ArrayBuffer(1024);
    new DataView(data).setFloat32(512, 0.72, true);
    harness.read.mockResolvedValue(data);
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("4 高斯");
    expect(harness.meshes[0].bytes).toBe(data);
    expect(harness.poll).not.toHaveBeenCalled();
    view.unmount();
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(harness.sparkDispose).toHaveBeenCalledOnce();
    expect(harness.rendererDispose).toHaveBeenCalledOnce();
    expect(harness.meshes[0].dispose.mock.invocationCallOrder[0]).toBeLessThan(harness.sparkDispose.mock.invocationCallOrder[0]);
    expect(harness.sparkDispose.mock.invocationCallOrder[0]).toBeLessThan(harness.rendererDispose.mock.invocationCallOrder[0]);
  });

  it("acknowledges decoded frames, swaps models without resetting the camera, and pauses only preview requests", async () => {
    harness.poll.mockResolvedValueOnce(status()).mockResolvedValue(status(second, 2));
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    const camera = harness.cameras[0];
    camera.position.set(8, 9, 10);
    await screen.findByText("10 step");
    expect(camera.position.toArray()).toEqual([8, 9, 10]);
    expect(harness.poll).toHaveBeenCalledWith("project", "D:/project", "live", 1, "session");
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(harness.rendererDispose).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("训练预览刷新"), { target: { value: "off" } });
    await screen.findByText("预览已暂停 · 训练继续");
    expect(screen.getByText("10 step")).toBeInTheDocument();
    expect(harness.poll.mock.calls.some((call) => call[2] === "off")).toBe(true);
    view.unmount();
  });

  it("keeps the installed live frame when an acknowledged revision has no new frame", async () => {
    harness.poll.mockResolvedValueOnce(status()).mockResolvedValue({ ...status(), frame: null });
    const view = render(<GaussianSplatPreview {...props} relativePath="training/checkpoints/checkpoint_100.ply" />);
    await screen.findByText("5 step");
    await waitFor(() => expect(harness.poll.mock.calls.filter((call) => call[2] === "live").length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    expect(harness.get).not.toHaveBeenCalled();
    expect(harness.read).toHaveBeenCalledOnce();
    expect(harness.meshes).toHaveLength(1);
    expect(harness.meshes[0].dispose).not.toHaveBeenCalled();
    expect(screen.getByText("5 step")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps the live session, acknowledged revision and canvas when checkpoint paths change during a pending poll", async () => {
    let finishPoll!: (value: LivePreviewStatus) => void;
    harness.poll.mockImplementation(async (_projectId, _projectPath, mode, revision) => {
      if (mode === "off") return { ...status(), frame: null };
      if (revision === 0) return status();
      if (revision === 1) return new Promise<LivePreviewStatus>((resolve) => { finishPoll = resolve; });
      return { ...status(second, 2), frame: null };
    });
    const view = render(<GaussianSplatPreview {...props} relativePath="checkpoints/500.ply" />);
    await screen.findByText("5 step");
    const canvas = view.container.querySelector("canvas");
    const camera = harness.cameras[0];
    camera.position.set(8, 9, 10);
    const installed = harness.meshes[0];
    const scene = installed.object.parent;
    await waitFor(() => expect(finishPoll).toBeTypeOf("function"));

    view.rerender(<GaussianSplatPreview {...props} relativePath="checkpoints/1000.ply" />);
    view.rerender(<GaussianSplatPreview {...props} relativePath="checkpoints/1500.ply" />);
    expect(harness.poll.mock.calls.some((call) => call[2] === "off")).toBe(false);
    expect(harness.poll.mock.calls.filter((call) => call[2] === "live")).toHaveLength(2);
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(harness.rendererCreate).toHaveBeenCalledOnce();
    expect(harness.read).toHaveBeenCalledOnce();
    expect(harness.get).not.toHaveBeenCalled();
    expect(installed.object.parent).toBe(scene);
    expect(installed.dispose).not.toHaveBeenCalled();

    await act(async () => finishPoll(status(second, 2)));
    await screen.findByText("10 step");
    await waitFor(() => expect(harness.poll).toHaveBeenCalledWith("project", "D:/project", "live", 2, "session"));
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(harness.rendererCreate).toHaveBeenCalledOnce();
    expect(camera.position.toArray()).toEqual([8, 9, 10]);
    expect(installed.dispose).toHaveBeenCalledOnce();
    expect(harness.meshes[1].object.parent).toBe(scene);
    expect(harness.rendererDispose).not.toHaveBeenCalled();
    expect(harness.poll.mock.calls.some((call) => call[2] === "off")).toBe(false);
    view.unmount();
    expect(harness.poll).toHaveBeenLastCalledWith("project", "D:/project", "off", 2, "session");
  });

  it("loads an explicitly selected static checkpoint after its path changes without replacing the canvas", async () => {
    const firstPath = "checkpoints/500.ply", secondPath = "checkpoints/1000.ply";
    harness.get.mockResolvedValueOnce({ ...first, relative_path: firstPath })
      .mockResolvedValue({ ...second, relative_path: secondPath });
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath={firstPath} />);
    await screen.findByText("5 step");
    const canvas = view.container.querySelector("canvas");
    view.rerender(<GaussianSplatPreview {...props} live={false} running={false} relativePath={secondPath} />);
    await screen.findByText("10 step");
    expect(harness.get).toHaveBeenCalledWith("project", "D:/project", firstPath);
    expect(harness.get).toHaveBeenCalledWith("project", "D:/project", secondPath);
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(harness.rendererCreate).toHaveBeenCalledOnce();
    expect(harness.poll).not.toHaveBeenCalled();
    view.unmount();
  });

  it("pauses new frames under pressure, releases at critical pressure, and reloads after recovery", async () => {
    const policy = (action: "allow" | "pause" | "release") => ({ action, reason: null, memory_pressure: null, poll_interval_ms: 500, max_snapshot_bytes: 1024 ** 3 });
    let action: "allow" | "pause" | "release" = "allow";
    harness.policy.mockImplementation(async () => policy(action));
    harness.poll.mockImplementation(async () => ({ ...status(), frame: action === "allow" ? first : null, resource_policy: policy(action) }));
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    action = "pause";
    await screen.findByText("内存压力升高 · 预览暂停 · 训练继续");
    expect(harness.meshes[0].dispose).not.toHaveBeenCalled();
    expect(harness.read).toHaveBeenCalledOnce();
    action = "release";
    await screen.findByText("内存不足 · 已释放预览 · 训练继续");
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(screen.queryByText("5 step")).not.toBeInTheDocument();
    action = "allow";
    await screen.findByText("5 step", {}, { timeout: 3000 });
    expect(harness.meshes).toHaveLength(2);
    expect(harness.poll.mock.calls.some((call) => call[3] === 0 && call[4] === "session")).toBe(true);
    view.unmount();
  });

  it.each(["read", "initialize"])("rejects an in-flight %s after critical pressure and never acknowledges it", async (phase) => {
    let finish!: () => void;
    if (phase === "read") harness.read.mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { finish = () => resolve(new ArrayBuffer(1024)); }));
    else harness.meshInitialization = new Promise((resolve) => { finish = () => resolve(undefined); });
    const view = render(<GaussianSplatPreview {...props} />);
    await waitFor(() => expect(harness.read).toHaveBeenCalledOnce());
    if (phase === "initialize") await waitFor(() => expect(harness.meshes).toHaveLength(1));
    harness.policy.mockResolvedValue({ action:"release",reason:"critical_memory_pressure",memory_pressure:"critical",poll_interval_ms:500,max_snapshot_bytes:0 });
    await screen.findByText("内存不足 · 已释放预览 · 训练继续", {}, { timeout:2000 });
    await act(async () => finish());
    await waitFor(() => expect(harness.poll.mock.calls.some((call) => call[2] === "off")).toBe(true));
    expect(screen.queryByText("5 step")).not.toBeInTheDocument();
    expect(harness.poll.mock.calls.every((call) => call[3] !== 1)).toBe(true);
    if (phase === "initialize") expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    else expect(harness.meshes).toHaveLength(0);
    view.unmount();
  });

  it("reloads a static model after pressure recovers without altering training", async () => {
    const view = render(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("5 step");
    harness.policy.mockResolvedValue({ action:"release",reason:"critical_memory_pressure",memory_pressure:"critical",poll_interval_ms:500,max_snapshot_bytes:0 });
    await screen.findByText("内存不足 · 预览已释放", {}, { timeout:2000 });
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    harness.policy.mockResolvedValue({ action:"allow",reason:null,memory_pressure:"normal",poll_interval_ms:500,max_snapshot_bytes:1024**3 });
    await screen.findByText("5 step", {}, { timeout:2000 });
    expect(harness.meshes).toHaveLength(2);
    expect(harness.poll).not.toHaveBeenCalled();
    view.unmount();
  });

  it("waits for consecutive healthy Windows observations before resuming preview", async () => {
    let action: "allow" | "pause" | "release" = "release";
    let healthySamples = 0;
    harness.policy.mockImplementation(async () => {
      if (action === "allow") healthySamples += 1;
      return { action, reason: null, memory_pressure: null, poll_interval_ms: 500,
        max_snapshot_bytes: 1024 ** 3, recovery_samples: 3 };
    });
    harness.poll.mockImplementation(async () => ({ ...status(), resource_policy: {
      action, reason: null, memory_pressure: null, poll_interval_ms: 500,
      max_snapshot_bytes: 1024 ** 3, recovery_samples: 3,
    } }));
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("内存不足 · 已释放预览 · 训练继续");
    action = "allow";
    await waitFor(() => expect(healthySamples).toBeGreaterThanOrEqual(1), { timeout: 1500 });
    expect(harness.read).not.toHaveBeenCalled();
    action = "pause";
    await screen.findByText("内存压力升高 · 预览暂停 · 训练继续", {}, { timeout: 1500 });
    healthySamples = 0;
    action = "allow";
    await screen.findByText("5 step", {}, { timeout: 4500 });
    expect(healthySamples).toBeGreaterThanOrEqual(3);
    expect(harness.read).toHaveBeenCalledOnce();
    view.unmount();
  }, 8000);

  it("loads the completed checkpoint instead of retaining an older acknowledged live frame", async () => {
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    harness.get.mockResolvedValue({ ...second,relative_path:"output/scene.ply",revision:"final",iteration:300 });
    view.rerender(<GaussianSplatPreview {...props} running={false} relativePath="output/scene.ply" />);
    await screen.findByText("300 step");
    expect(harness.get).toHaveBeenCalledWith("project","D:/project","output/scene.ply");
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it.each(["metadata", "read", "initialize"])("labels the retained live frame while the final model waits for %s", async (phase) => {
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    const camera = harness.cameras[0];
    camera.position.set(8, 9, 10);
    const final = { ...second, relative_path: "output/scene.ply", revision: "final", iteration: null, vertex_count: 7 };
    let finish!: () => void;
    harness.get.mockResolvedValue(final);
    harness.meshSplatCount = 7;
    if (phase === "metadata") harness.get.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(final); }));
    else if (phase === "read") harness.read.mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { finish = () => resolve(new ArrayBuffer(1024)); }));
    else harness.meshInitialization = new Promise((resolve) => { finish = () => resolve(undefined); });

    view.rerender(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.getByText("正在加载所选模型 · 暂时显示上一帧")).toBeInTheDocument();
    expect(screen.queryByText("高斯渲染")).not.toBeInTheDocument();
    expect(screen.getByText("5 step")).toBeInTheDocument();
    expect(screen.getByText("4 高斯")).toBeInTheDocument();
    expect(harness.meshes[0].dispose).not.toHaveBeenCalled();

    await act(async () => finish());
    await screen.findByText("7 高斯");
    expect(screen.getByText("高斯渲染")).toBeInTheDocument();
    expect(screen.queryByText("5 step")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("训练预览刷新")).not.toBeInTheDocument();
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    expect(camera.position.toArray()).toEqual([8, 9, 10]);
    expect(harness.rendererDispose).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not label the retained live frame as the selected model after a failed final load", async () => {
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    harness.get.mockRejectedValue(new Error("final unavailable"));
    view.rerender(<GaussianSplatPreview {...props} live={false} running={false} relativePath="output/scene.ply" />);
    await screen.findByText(/final unavailable.*已保留上一帧/);
    expect(screen.getByText("所选模型尚未显示 · 保留上一帧")).toBeInTheDocument();
    expect(screen.queryByText("高斯渲染")).not.toBeInTheDocument();
    expect(screen.getByText("5 step")).toBeInTheDocument();
    expect(harness.meshes[0].dispose).not.toHaveBeenCalled();

    harness.get.mockResolvedValue({ ...second, relative_path: "output/scene.ply", revision: "final", iteration: null });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("高斯渲染");
    expect(screen.queryByText("5 step")).not.toBeInTheDocument();
    expect(harness.meshes[0].dispose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps the previous frame on a failed update and does not acknowledge the failed frame", async () => {
    harness.poll.mockResolvedValueOnce(status()).mockResolvedValue(status(second, 2));
    harness.read.mockResolvedValueOnce(new ArrayBuffer(1024)).mockRejectedValue(new Error("snapshot unavailable"));
    const view = render(<GaussianSplatPreview {...props} />);
    await screen.findByText("5 step");
    await screen.findByText(/snapshot unavailable.*已保留上一帧/);
    expect(harness.meshes[0].dispose).not.toHaveBeenCalled();
    await waitFor(() => expect(harness.poll.mock.calls.filter((call) => call[2] === "live").length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    expect(harness.poll.mock.calls.filter((call) => call[2] === "live").every((call) => call[3] !== 2)).toBe(true);
    view.unmount();
  });

  it("drops an in-flight model when the preview is closed", async () => {
    let finish!: (value: ArrayBuffer) => void;
    harness.read.mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    const view = render(<GaussianSplatPreview {...props} />);
    await waitFor(() => expect(harness.read).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => { finish(new ArrayBuffer(1024)); });
    expect(harness.meshes).toHaveLength(0);
    expect(harness.rendererDispose).toHaveBeenCalledOnce();
  });
});
