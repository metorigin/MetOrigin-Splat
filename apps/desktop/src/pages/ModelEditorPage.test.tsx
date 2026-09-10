import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { setLanguagePreference } from "../i18n";
import ModelEditorPage from "./ModelEditorPage";
import type { EditorSession } from "../types";

const bridge = vi.hoisted(() => ({ request: vi.fn(), dispose: vi.fn() }));
const readPly = vi.hoisted(() => vi.fn());
vi.mock("../services/editorBridge", () => ({ createEditorBridge: () => bridge }));
vi.mock("../services/desktop", () => ({ desktopApi: { readGaussianPly: readPly } }));

const session: EditorSession = { session_id: "editor", project_id: "p", project_path: "D:/场景", project_name: "中文项目", source: {relative_path:"output/scene.ply", revision:"r1", size_bytes:100, vertex_count:1, iteration:null} };
beforeEach(() => {
  vi.clearAllMocks();
  bridge.request.mockImplementation(() => ({id:"request",result:Promise.resolve(true)}));
  readPly.mockResolvedValue(new ArrayBuffer(100));
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
