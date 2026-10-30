import { useCallback, useEffect, useState } from "react";
import type { RefCallback } from "react";

import { desktopApi, isDesktopRuntime, isUiPreviewMode } from "../services/desktop";
import type { FramePreviewItem, ProjectInfo, RecentProjectAvailability } from "../types";

type ThumbnailStatus = "idle" | "loading" | "ready" | "unavailable" | "error";
type Thumbnail = FramePreviewItem | null;
interface Resource { key: string; data: Thumbnail; status: ThumbnailStatus }
interface Job {
  key: string;
  projectPath: string;
  projectId: string;
  consumers: number;
  started: boolean;
  cacheable: boolean;
  promise: Promise<Thumbnail>;
  resolve: (data: Thumbnail) => void;
  reject: (error: unknown) => void;
}

const cache = new Map<string, Thumbnail>();
const pending = new Map<string, Job>();
const queue: Job[] = [];
const MAX_CONCURRENT = 2;
const MAX_CACHED = 48;
let active = 0;

function cacheResult(key: string, value: Thumbnail) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

function invalidate(key: string) {
  cache.delete(key);
  const job = pending.get(key);
  if (job) {
    job.cacheable = false;
    pending.delete(key);
  }
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    if (job.consumers === 0) continue;
    active += 1;
    job.started = true;
    void Promise.resolve()
      .then(() => desktopApi.getProjectThumbnail(job.projectPath, job.projectId))
      .then((value) => {
        if (value && (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value.data_url)
          || !Number.isFinite(value.width) || value.width <= 0
          || !Number.isFinite(value.height) || value.height <= 0)) {
          throw new Error("Invalid project thumbnail");
        }
        if (job.cacheable) cacheResult(job.key, value);
        job.resolve(value);
      }, job.reject)
      .catch(job.reject)
      .finally(() => {
        active -= 1;
        if (pending.get(job.key) === job) pending.delete(job.key);
        pump();
      });
  }
}

function request(projectId: string, projectPath: string, key: string) {
  let job = pending.get(key);
  if (!job) {
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<Thumbnail>((done, fail) => { resolve = done; reject = fail; });
    job = { key, projectPath, projectId, consumers: 0,
      started: false, cacheable: true, promise, resolve, reject };
    pending.set(key, job);
    queue.push(job);
  }
  job.consumers += 1;
  const acquired = job;
  pump();
  return {
    promise: acquired.promise,
    release: () => {
      acquired.consumers -= 1;
      if (!acquired.started && acquired.consumers === 0) {
        const index = queue.indexOf(acquired);
        if (index !== -1) queue.splice(index, 1);
        if (pending.get(key) === acquired) pending.delete(key);
        acquired.resolve(null);
      }
    },
  };
}

/** Read only representative photos near the viewport; never alter path health. */
export function useProjectThumbnail(project: ProjectInfo, availability?: RecentProjectAvailability): {
  containerRef: RefCallback<HTMLSpanElement>;
  data: Thumbnail;
  status: ThumbnailStatus;
} {
  const [container, setContainer] = useState<HTMLSpanElement | null>(null);
  const containerRef = useCallback((node: HTMLSpanElement | null) => setContainer(node), []);
  const [visible, setVisible] = useState(false);
  const [resource, setResource] = useState<Resource>({ key: "", data: null, status: "idle" });
  // Background pipeline updates may publish frames without changing updated_at.
  const key = JSON.stringify([project.id, project.path, project.updated_at, project.status, project.stage_label ?? null]);
  const enabled = isDesktopRuntime() || isUiPreviewMode();
  const currentHealth = availability?.checkedPath === project.path ? availability : undefined;
  const blocked = currentHealth?.status === "missing" || currentHealth?.status === "unreadable";
  const generation = currentHealth?.generation;

  useEffect(() => {
    if (!enabled || !container) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === container) setVisible(entry.isIntersecting);
    }, { rootMargin: "160px" });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, enabled]);

  useEffect(() => {
    if (blocked) {
      // A repair at the same path must not reuse an image decoded before it failed.
      invalidate(key);
      setResource({ key, data: null, status: "unavailable" });
      return;
    }
    if (!enabled || !visible) return;
    if (cache.has(key)) {
      const value = cache.get(key) ?? null;
      cacheResult(key, value);
      setResource({ key, data: value, status: value ? "ready" : "unavailable" });
      return;
    }
    let disposed = false;
    setResource({ key, data: null, status: "loading" });
    const lease = request(project.id, project.path, key);
    void lease.promise.then((data) => {
      if (!disposed) setResource({ key, data, status: data ? "ready" : "unavailable" });
    }, () => {
      if (!disposed) setResource({ key, data: null, status: "error" });
    });
    return () => { disposed = true; lease.release(); };
    // Generation permits a failed read to retry after an explicit path probe.
    // Cached successes do not perform another decode for a background check.
  }, [blocked, enabled, generation, key, project.id, project.path, visible]);

  if (!enabled || blocked) return { containerRef, data: null, status: "unavailable" };
  if (resource.key !== key) return { containerRef, data: null, status: "idle" };
  return { containerRef, data: resource.data, status: resource.status };
}
