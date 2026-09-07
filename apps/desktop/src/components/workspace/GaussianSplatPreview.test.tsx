import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerspectiveCamera } from "three";
import { GaussianSplatPreview } from "./GaussianSplatPreview";
import type { GaussianPreviewSource, LivePreviewStatus } from "../../types";

const harness = vi.hoisted(() => ({
  get: vi.fn(), read: vi.fn(), poll: vi.fn(), camera: vi.fn(),
  meshes: [] as { bytes: ArrayBuffer; dispose: ReturnType<typeof vi.fn> }[],
  cameras: [] as PerspectiveCamera[],
  rendererDispose: vi.fn(),
}));

vi.mock("../../services/desktop", () => ({ desktopApi: {
  getGaussianPreview: harness.get, readGaussianPly: harness.read, pollLivePreview: harness.poll,
  getGaussianCamera: harness.camera,
} }));

vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual,
    PerspectiveCamera: class extends actual.PerspectiveCamera {
      constructor(...args: ConstructorParameters<typeof actual.PerspectiveCamera>) { super(...args); harness.cameras.push(this); }
    },
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setPixelRatio() {} setClearColor() {} setSize() {} setAnimationLoop() {} render() {}
      dispose = harness.rendererDispose;
    },
  };
});

vi.mock("@sparkjsdev/spark", async () => {
  const THREE = await import("three");
  return {
    SparkRenderer: class extends THREE.Object3D { dispose() {} },
    SplatMesh: class extends THREE.Object3D {
      numSplats = 4;
      initialized = Promise.resolve(this);
      dispose = vi.fn();
      constructor(options: { fileBytes: ArrayBuffer }) { super(); harness.meshes.push({ bytes: options.fileBytes, dispose: this.dispose }); }
      forEachSplat() {}
      getBoundingBox() { return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)); }
    },
  };
});

const first: GaussianPreviewSource = { relative_path: "training/live-preview/session/frame-1.ply", revision: "a", vertex_count: 4, size_bytes: 1024, iteration: 5 };
const second: GaussianPreviewSource = { ...first, relative_path: "training/live-preview/session/frame-2.ply", revision: "b", iteration: 10 };
const status = (frame: GaussianPreviewSource = first, revision = 1): LivePreviewStatus => ({ session_id: "session", available: true, running: true, revision, frame });
const props = { projectId: "project", projectPath: "D:/project", relativePath: null, running: true, live: true };

beforeEach(() => {
  vi.clearAllMocks();
  harness.meshes.length = 0; harness.cameras.length = 0;
  harness.get.mockResolvedValue(first);
  harness.camera.mockResolvedValue(null);
  harness.read.mockResolvedValue(new ArrayBuffer(1024));
  harness.poll.mockResolvedValue(status());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("Gaussian preview model lifecycle", () => {
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
    expect(harness.rendererDispose).toHaveBeenCalledOnce();
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
