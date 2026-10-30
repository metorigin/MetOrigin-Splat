import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { setLanguagePreference } from "../i18n";
import { useTheme, type Theme } from "../hooks/useTheme";
import ModelEditorPage, { type ModelEditorHandle } from "./ModelEditorPage";
import type { EditorSession, GaussianCamera } from "../types";
import type { EditorBridgeOptions } from "../services/editorBridge";

const bridge = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn() }));
const readPly = vi.hoisted(() => vi.fn());
const readCamera = vi.hoisted(() => vi.fn());
const createBridge = vi.hoisted(() => vi.fn());
const saveImage = vi.hoisted(() => vi.fn());
const savePly = vi.hoisted(() => vi.fn());
const confirmLeave = vi.hoisted(() => vi.fn());
vi.mock("../services/editorBridge", () => ({ createEditorBridge: createBridge }));
vi.mock("../services/desktop", () => ({ desktopApi: { readGaussianPly: readPly, getGaussianCamera: readCamera, saveEditorImage: saveImage, saveEditedPly: savePly, confirm: confirmLeave } }));

const session: EditorSession = { session_id: "editor", project_id: "p", project_path: "D:/场景", project_name: "中文项目", source: {relative_path:"output/scene.ply", revision:"r1", size_bytes:100, vertex_count:1, iteration:null} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const result = new Promise<T>((done) => { resolve = done; });
  return { result, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("metorigin.ui.theme");
  setLanguagePreference("zh-CN");
  bridge.request.mockImplementation(() => ({id:"request",result:Promise.resolve(true)}));
  createBridge.mockReturnValue(bridge);
  readPly.mockResolvedValue(new ArrayBuffer(100));
  readCamera.mockResolvedValue(null);
  saveImage.mockResolvedValue("/tmp/image.webp");
  savePly.mockResolvedValue({});
  confirmLeave.mockResolvedValue(false);
});

it("changes editor language without reloading the iframe or model, preserving edits", async () => {
  setLanguagePreference("en");
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  const frame = screen.getByTitle("SuperSplat model editor");
  expect(frame).toHaveAttribute("src", "/supersplat/index.html?lng=en");
  fireEvent.load(frame);
  await waitFor(() => expect(screen.getByRole("button", {name:"Save"})).toBeEnabled());
  const loads = bridge.request.mock.calls.filter(([command]) => command === "load").length;
  act(() => setLanguagePreference("zh-CN"));
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("language", {locale:"zh-CN"}));
  expect(screen.getByTitle("SuperSplat 模型编辑器")).toBe(frame);
  expect(frame).toHaveAttribute("src", "/supersplat/index.html?lng=en");
  expect(readPly).toHaveBeenCalledTimes(1);
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toHaveLength(loads);
  expect(bridge.dispose).not.toHaveBeenCalled();
});

it.each<Theme>(["light", "dark", "system"])("keeps the editor dark across host theme changes, starting from %s, without replacing the scene", async (initialTheme) => {
  localStorage.setItem("metorigin.ui.theme", initialTheme);
  function HostThemeControls() {
    const { setTheme } = useTheme();
    return <>{(["light", "dark", "system"] as const).map((theme) => <button key={theme} onClick={() => setTheme(theme)}>宿主{theme}</button>)}</>;
  }
  render(<><HostThemeControls /><ModelEditorPage session={session} onBack={vi.fn()} /></>);
  const frame = screen.getByTitle("SuperSplat 模型编辑器");
  const editor = screen.getByRole("region", { name: "模型编辑工作区" });
  expect(editor).toHaveAttribute("data-theme", "dark");
  expect(editor.style.getPropertyValue("--background")).toBe("#121212");
  expect(editor.style.colorScheme).toBe("dark");
  fireEvent.load(frame);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  expect(bridge.request).toHaveBeenCalledWith("theme", { theme: "dark", version: "jan-v1" }, [], 3000);
  expect(bridge.request.mock.calls.findIndex(([command]) => command === "theme")).toBeLessThan(bridge.request.mock.calls.findIndex(([command]) => command === "load"));
  const count = bridge.request.mock.calls.filter(([command]) => command === "load").length;
  // Paint is established before and after import. Entering ready must not
  // schedule an extra theme request that can race with host interactions.
  expect(bridge.request.mock.calls.filter(([command]) => command === "theme")).toHaveLength(2);
  for (const theme of ["light", "dark", "system"]) {
    fireEvent.click(screen.getByRole("button", { name: `宿主${theme}` }));
    expect(document.documentElement.dataset.theme).toBe(theme === "dark" ? "dark" : "light");
    expect(editor).toHaveAttribute("data-theme", "dark");
  }
  expect(bridge.request.mock.calls.filter(([command]) => command === "theme")).toHaveLength(2);
  expect(bridge.request.mock.calls.filter(([command]) => command === "theme").every(([, payload]) => payload.theme === "dark")).toBe(true);
  expect(screen.getByTitle("SuperSplat 模型编辑器")).toBe(frame);
  expect(readPly).toHaveBeenCalledTimes(1);
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toHaveLength(count);
  expect(bridge.request.mock.calls.some(([command]) => command === "saved")).toBe(false);
  expect(bridge.dispose).not.toHaveBeenCalled();
});

it.each(["ping", "theme", "load"])("conceals the same mounted frame until the delayed %s completes", async (delayedCommand) => {
  localStorage.setItem("metorigin.ui.theme", "light");
  const pending = deferred<boolean>();
  let commandCount = 0;
  bridge.request.mockImplementation((command: string) => ({
    id: "request",
    result: command === delayedCommand && commandCount++ === 0 ? pending.result : Promise.resolve(true),
  }));
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  const frame = screen.getByTitle("SuperSplat 模型编辑器");
  const originalUrl = frame.getAttribute("src");
  expect(frame).not.toBeVisible();
  expect(frame).toHaveAttribute("aria-hidden", "true");
  expect(frame).toBeInTheDocument();
  expect(frame.style.display).not.toBe("none");
  expect(screen.getByText("正在载入")).toBeVisible();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

  fireEvent.load(frame);
  await waitFor(() => expect(bridge.request.mock.calls.some(([command]) => command === delayedCommand)).toBe(true));
  expect(frame).not.toBeVisible();
  expect(screen.getByText("正在载入")).toBeVisible();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  if (delayedCommand !== "load") expect(bridge.request.mock.calls.some(([command]) => command === "load")).toBe(false);

  await act(async () => pending.resolve(true));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  expect(frame).toBeVisible();
  expect(frame).toHaveAttribute("aria-hidden", "false");
  expect(screen.getByTitle("SuperSplat 模型编辑器")).toBe(frame);
  expect(frame).toHaveAttribute("src", originalUrl);
  expect(readPly).toHaveBeenCalledTimes(1);
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toHaveLength(1);
  expect(bridge.dispose).not.toHaveBeenCalled();
});

it("places editor actions in the shared titlebar without replacing the frame when the header placement changes", async () => {
  const target = document.createElement("div"); document.body.append(target);
  const back = vi.fn();
  const view = render(<ModelEditorPage session={session} onBack={back} headerTarget={target} />);
  const frame = screen.getByTitle("SuperSplat 模型编辑器");
  fireEvent.load(frame);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  expect(target.querySelector("button[aria-label='保存']")).toBe(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("region", { name: "模型编辑工作区" }).querySelector("header")).toBeNull();
  view.rerender(<ModelEditorPage session={session} onBack={back} headerTarget={null} />);
  expect(screen.getByTitle("SuperSplat 模型编辑器")).toBe(frame);
  expect(readPly).toHaveBeenCalledTimes(1);
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toHaveLength(1);
  expect(bridge.dispose).not.toHaveBeenCalled();
  target.remove();
});

it.each(["timeout", "invalid acknowledgement"])("conceals an unconfirmed theme after %s and retries without replacing the loaded scene", async (failure) => {
  bridge.request.mockImplementation((command: string) => ({
    id: "request",
    result: command === "theme"
      ? failure === "timeout" ? Promise.reject(new Error("timeout")) : Promise.resolve(false)
      : Promise.resolve(true),
  }));
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  const frame = screen.getByTitle("SuperSplat 模型编辑器");
  fireEvent.load(frame);
  await waitFor(() => expect(bridge.request.mock.calls.filter(([command]) => command === "theme")).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText("正在载入")).not.toBeInTheDocument());
  expect(screen.getByText("编辑器外观未同步，模型修改已保留。")).toBeInTheDocument();
  expect(frame).not.toBeVisible();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  bridge.request.mockImplementation(() => ({ id: "request", result: Promise.resolve(true) }));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByText("编辑器外观未同步，模型修改已保留。")).not.toBeInTheDocument());
  expect(frame).toBeVisible();
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  expect(readPly).toHaveBeenCalledTimes(1);
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toHaveLength(1);
  expect(screen.getByTitle("SuperSplat 模型编辑器")).toBe(frame);
  expect(bridge.dispose).not.toHaveBeenCalled();
});

it("loads optional capture metadata for the exact editor project path while transferring the PLY", async () => {
  const camera: GaussianCamera = { position: [1, 2, 3], forward: [0, 0, -1], up: [0, 1, 0], fov_y_degrees: 52 };
  const bytes = new ArrayBuffer(100);
  readPly.mockResolvedValue(bytes);
  readCamera.mockResolvedValue(camera);
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("load", { bytes, camera }, [bytes], 180_000));
  expect(readPly).toHaveBeenCalledWith(session.project_id, session.project_path, session.source);
  expect(readCamera).toHaveBeenCalledWith(session.project_id, session.project_path);
});

it("still opens a valid model when capture metadata cannot be read", async () => {
  readCamera.mockRejectedValue(new Error("SfM metadata is unavailable"));
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  const [, payload] = bridge.request.mock.calls.find(([command]) => command === "load")!;
  expect(payload.camera).toBeNull();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not deliver a model when the editor closes during metadata lookup", async () => {
  let finishCamera!: (camera: null) => void;
  readCamera.mockReturnValue(new Promise<null>((resolve) => { finishCamera = resolve; }));
  const view = render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(readCamera).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { finishCamera(null); });
  expect(bridge.request.mock.calls.filter(([command]) => command === "load")).toEqual([]);
});

function imageCallbacks() {
  return (createBridge.mock.calls[createBridge.mock.calls.length - 1][2] as EditorBridgeOptions).imageExport!;
}

it("advertises native image saving during the editor handshake", async () => {
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  expect(bridge.request).toHaveBeenCalledWith("ping", { nativeImageSave: true }, [], 1500);
});

it("locks leaving and model saving synchronously until the image export ends without clearing dirty state", async () => {
  const ref = createRef<ModelEditorHandle>();
  const back = vi.fn();
  render(<ModelEditorPage ref={ref} session={session} onBack={back} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  const image = imageCallbacks();
  let allowed!: Promise<boolean>;
  act(() => { image.begin("webp"); allowed = ref.current!.requestLeave(); });
  await expect(allowed).resolves.toBe(false);
  expect(screen.getByText("正在导出图像…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(back).not.toHaveBeenCalled();
  expect(savePly).not.toHaveBeenCalled();
  const bytes = new ArrayBuffer(8);
  await expect(image.save("webp", bytes)).resolves.toBe("/tmp/image.webp");
  expect(saveImage).toHaveBeenCalledWith(session.session_id, "webp", bytes);
  expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
  expect(bridge.request.mock.calls.some(([command]) => command === "saved")).toBe(false);
  act(() => image.end());
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  await act(async () => { expect(await ref.current!.requestLeave()).toBe(false); });
  expect(bridge.request).toHaveBeenCalledWith("dirty", undefined, [], 3000);
  expect(confirmLeave).toHaveBeenCalledTimes(1);
});

it("propagates native cancellation and failure to the child without changing model-save state", async () => {
  render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  const image = imageCallbacks();
  act(() => image.begin("png"));
  saveImage.mockResolvedValueOnce(null);
  await expect(image.save("png", new ArrayBuffer(4))).resolves.toBeNull();
  act(() => image.end());
  act(() => image.begin("jpeg"));
  saveImage.mockRejectedValueOnce(new Error("Disk full"));
  await expect(image.save("jpeg", new ArrayBuffer(4))).rejects.toThrow("Disk full");
  act(() => image.end());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("模型已保存。")).not.toBeInTheDocument();
  expect(bridge.request.mock.calls.some(([command]) => command === "saved" || command === "save-failed")).toBe(false);
  expect(savePly).not.toHaveBeenCalled();
});

it("rejects image export while loading, model saving, or checking whether the editor may close", async () => {
  let finishRead!: (bytes: ArrayBuffer) => void;
  readPly.mockReturnValueOnce(new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
  const ref = createRef<ModelEditorHandle>();
  render(<ModelEditorPage ref={ref} session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  const image = imageCallbacks();
  expect(() => image.begin("webp")).toThrow("编辑器正忙");
  await waitFor(() => expect(readPly).toHaveBeenCalledTimes(1));
  await act(async () => finishRead(new ArrayBuffer(4)));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  let finishExport!: (bytes: ArrayBuffer) => void;
  const modelExport = new Promise<ArrayBuffer>((resolve) => { finishExport = resolve; });
  bridge.request.mockImplementation((command) => ({ id: "request", result: command === "export" ? modelExport : Promise.resolve(true) }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(() => image.begin("webp")).toThrow("编辑器正忙");
  await act(async () => finishExport(new ArrayBuffer(4)));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  let finishDirty!: (dirty: boolean) => void;
  const dirty = new Promise<boolean>((resolve) => { finishDirty = resolve; });
  bridge.request.mockImplementation((command) => ({ id: "request", result: command === "dirty" ? dirty : Promise.resolve(true) }));
  let leaving!: Promise<boolean>;
  act(() => { leaving = ref.current!.requestLeave(); });
  expect(() => image.begin("webp")).toThrow("编辑器正忙");
  await act(async () => { finishDirty(true); await leaving; });
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
});

it("rejects image admission after unmount and tolerates native cleanup after unmount", async () => {
  const view = render(<ModelEditorPage session={session} onBack={vi.fn()} />);
  fireEvent.load(screen.getByTitle("SuperSplat 模型编辑器"));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  const image = imageCallbacks();
  act(() => image.begin("webp"));
  view.unmount();
  expect(bridge.dispose).toHaveBeenCalledTimes(1);
  expect(() => image.begin("webp")).toThrow("编辑器正忙");
  expect(() => image.end()).not.toThrow();
});
