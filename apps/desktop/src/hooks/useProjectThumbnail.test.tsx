import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FramePreviewItem, ProjectInfo, RecentProjectAvailability } from "../types";
import { useProjectThumbnail } from "./useProjectThumbnail";

const api = vi.hoisted(() => ({
  getProjectThumbnail: vi.fn(),
  isDesktopRuntime: vi.fn(() => true),
  isUiPreviewMode: vi.fn(() => false),
}));
vi.mock("../services/desktop", () => ({
  desktopApi: api, isDesktopRuntime: api.isDesktopRuntime, isUiPreviewMode: api.isUiPreviewMode,
}));

let run = 0;
let observers: TestObserver[] = [];
class TestObserver {
  target: Element | null = null;
  constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.target = null; }
  emit(visible: boolean) {
    if (this.target) this.callback([{ target: this.target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function project(index: number): ProjectInfo {
  return { id: `thumbnail-${run}-${index}`, name: `场景 ${index}`, path: `/captures/run-${run}/${index}`,
    status: "completed", updated_at: "2026-10-29T10:00:00Z" };
}
function image(name = "first"): FramePreviewItem {
  return { relative_path: `${name}.jpg`, data_url: `data:image/jpeg;base64,${btoa(name)}`, width: 360, height: 240 };
}
function health(item: ProjectInfo, status: RecentProjectAvailability["status"], generation = 1): RecentProjectAvailability {
  return { checkedPath: item.path, status, generation, checkedAt: null, reasonCode: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Probe({ item, availability, name = "probe" }: {
  item: ProjectInfo; availability?: RecentProjectAvailability; name?: string;
}) {
  const { containerRef, data, status } = useProjectThumbnail(item, availability);
  return <span ref={containerRef} data-testid={name} data-status={status} data-source={data?.data_url ?? ""} />;
}
function enterAll(visible = true) { act(() => observers.forEach((observer) => observer.emit(visible))); }

describe("useProjectThumbnail", () => {
  beforeEach(() => {
    run += 1;
    observers = [];
    vi.clearAllMocks();
    api.isDesktopRuntime.mockReturnValue(true);
    api.isUiPreviewMode.mockReturnValue(false);
    api.getProjectThumbnail.mockResolvedValue(image());
    vi.stubGlobal("IntersectionObserver", TestObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads only near the viewport and performs no reads outside desktop or preview mode", async () => {
    const item = project(0);
    const view = render(<Probe item={item} />);
    expect(api.getProjectThumbnail).not.toHaveBeenCalled();
    enterAll(false);
    expect(api.getProjectThumbnail).not.toHaveBeenCalled();
    enterAll();
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledWith(item.path, item.id);
    view.unmount();

    api.isDesktopRuntime.mockReturnValue(false);
    render(<Probe item={project(1)} />);
    enterAll();
    expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "unavailable");
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(1);
  });

  it("supports preview mode and the no-IntersectionObserver fallback", async () => {
    api.isDesktopRuntime.mockReturnValue(false);
    api.isUiPreviewMode.mockReturnValue(true);
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe item={project(0)} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(1);
  });

  it("limits shared decoding to two concurrent requests and de-duplicates the same identity", async () => {
    const items = Array.from({ length: 5 }, (_, index) => project(index));
    const reads = items.map(() => deferred<FramePreviewItem | null>());
    let active = 0;
    let peak = 0;
    api.getProjectThumbnail.mockImplementation((path: string) => {
      const index = items.findIndex((item) => item.path === path);
      active += 1; peak = Math.max(peak, active);
      return reads[index].promise.finally(() => { active -= 1; });
    });
    render(<>{items.map((item, index) => <Probe key={item.id} item={item} name={`probe-${index}`} />)}<Probe item={items[0]} name="duplicate" /></>);
    enterAll();
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2));
    expect(peak).toBe(2);
    await act(async () => { reads[0].resolve(image("zero")); });
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("duplicate")).toHaveAttribute("data-source", image("zero").data_url);
    await act(async () => { reads.slice(1).forEach((read, index) => read.resolve(image(String(index)))); });
    await waitFor(() => expect(screen.getByTestId("probe-4")).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it("discards queued work when its last card leaves and never reads those projects", async () => {
    const reads = [deferred<FramePreviewItem | null>(), deferred<FramePreviewItem | null>()];
    api.getProjectThumbnail.mockReturnValueOnce(reads[0].promise).mockReturnValueOnce(reads[1].promise);
    const items = Array.from({ length: 4 }, (_, index) => project(index));
    const view = render(<>{items.map((item) => <Probe key={item.id} item={item} name={item.id} />)}</>);
    enterAll();
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2));
    view.rerender(<>{items.slice(0, 2).map((item) => <Probe key={item.id} item={item} name={item.id} />)}</>);
    await act(async () => { reads.forEach((read) => read.resolve(image())); });
    await waitFor(() => expect(screen.getByTestId(items[1].id)).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2);
  });

  it("never renders a late response after relinking or updating the same project", async () => {
    const item = project(0);
    const next = { ...item, path: `${item.path}-relocated`, updated_at: "2026-10-29T11:00:00Z" };
    const oldRead = deferred<FramePreviewItem | null>();
    const newRead = deferred<FramePreviewItem | null>();
    api.getProjectThumbnail.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const view = render(<Probe item={item} />);
    enterAll();
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(1));
    view.rerender(<Probe item={next} />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", "");
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2));
    await act(async () => { newRead.resolve(image("new")); });
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", image("new").data_url);
    await act(async () => { oldRead.resolve(image("old")); });
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", image("new").data_url);
    expect(api.getProjectThumbnail.mock.calls[1]).toEqual([next.path, next.id]);
  });

  it.each(["missing", "unreadable"] as const)("hides cached photos for %s paths and refreshes after repair", async (status) => {
    const item = project(0);
    const view = render(<Probe item={item} />);
    enterAll();
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "ready"));
    view.rerender(<Probe item={item} availability={health(item, status)} />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", "");
    expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "unavailable");
    const repair = deferred<FramePreviewItem | null>();
    api.getProjectThumbnail.mockReturnValueOnce(repair.promise);
    view.rerender(<Probe item={item} availability={health(item, "available", 2)} />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", "");
    await waitFor(() => expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2));
    await act(async () => { repair.resolve(image("repaired")); });
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", image("repaired").data_url);
    view.rerender(<Probe item={item} availability={health(item, "available", 3)} />);
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2);
  });

  it("ignores availability for an old path and distinguishes no photo from transient failure", async () => {
    const item = project(0);
    api.getProjectThumbnail.mockResolvedValueOnce(null);
    const view = render(<Probe item={item} availability={{ ...health(item, "missing"), checkedPath: "/old-path" }} />);
    enterAll();
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "unavailable"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(1);
    const next = project(1);
    api.getProjectThumbnail.mockRejectedValueOnce(new Error("temporary read error"));
    view.rerender(<Probe item={next} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "error"));
    api.getProjectThumbnail.mockResolvedValueOnce(image("retry"));
    view.rerender(<Probe item={next} availability={health(next, "available", 2)} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "ready"));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-source", image("retry").data_url);
  });

  it("refreshes an empty thumbnail after pipeline publication even when updated_at is unchanged", async () => {
    const item = { ...project(0), status: "ready" as const, stage_label: "FrameExtraction" };
    api.getProjectThumbnail.mockResolvedValueOnce(null);
    const view = render(<Probe item={item} availability={health(item, "available")} />);
    enterAll();
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "unavailable"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(1);

    const training = { ...item, status: "running" as const, stage_label: "BrushTraining" };
    api.getProjectThumbnail.mockResolvedValueOnce(image("published-frame"));
    view.rerender(<Probe item={training} availability={health(training, "available", 2)} />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-source", image("published-frame").data_url));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2);
    view.rerender(<Probe item={training} availability={health(training, "available", 3)} />);
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(2);
  });

  it("keeps only forty-eight terminal results in the shared LRU", async () => {
    const items = Array.from({ length: 49 }, (_, index) => project(index));
    const view = render(<>{items.map((item) => <Probe key={item.id} item={item} name={item.id} />)}</>);
    enterAll();
    await waitFor(() => expect(screen.getByTestId(items[48].id)).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(49);
    view.unmount();
    render(<Probe item={items[0]} />);
    enterAll();
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveAttribute("data-status", "ready"));
    expect(api.getProjectThumbnail).toHaveBeenCalledTimes(50);
  });
});
