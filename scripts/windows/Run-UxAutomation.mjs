import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const artifactRoot = join(repositoryRoot, ".test-results", "ux-automation");
const previewPort = 4173;
const appUrl = `http://127.0.0.1:${previewPort}`;
// An explicit override enables an isolated Chromium run on other hosts;
// Windows continues to discover Microsoft Edge by default.
const browserCandidates = process.env.METORIGIN_UX_BROWSER_EXECUTABLE ? [process.env.METORIGIN_UX_BROWSER_EXECUTABLE] : [
  process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : null,
  process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : null,
].filter(Boolean);

class AutomationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "AutomationError";
    this.details = details;
  }
}

class CdpClient {
  constructor(browserProcess) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.sessionId = null;
    this.input = browserProcess.stdio[3];
    this.output = browserProcess.stdio[4];
    this.buffer = "";
    this.receivedMessageCount = 0;
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk) => {
      this.buffer += chunk;
      let boundary = this.buffer.indexOf("\0");
      while (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        if (raw) this.handleMessage(raw);
        boundary = this.buffer.indexOf("\0");
      }
    });
    this.output.on("error", (error) => this.rejectAll(new AutomationError(`CDP output pipe failed: ${error.message}`)));
    this.input.on("error", (error) => this.rejectAll(new AutomationError(`CDP input pipe failed: ${error.message}`)));
    browserProcess.on("exit", (code) => this.rejectAll(new AutomationError(`Browser CDP process exited: code=${code ?? "unknown"}`)));
    browserProcess.on("error", (error) => this.rejectAll(new AutomationError(`Browser failed to start: ${error.message}`)));
  }

  handleMessage(raw) {
    let message;
    try {
      this.receivedMessageCount += 1;
      if (this.receivedMessageCount === 1) process.stdout.write("[RUN] first CDP pipe message received\n");
      message = JSON.parse(raw);
    } catch (error) {
      this.rejectAll(new AutomationError(`CDP response parse failed: ${String(error?.message ?? error)}`));
      return;
    }
      if (message.id) {
        const resolver = this.pending.get(message.id);
        if (!resolver) return;
        this.pending.delete(message.id);
        if (message.error) resolver.reject(new AutomationError(message.error.message, message.error));
        else resolver.resolve(message.result ?? {});
        return;
      }
      const callbacks = this.listeners.get(message.method) ?? [];
      for (const callback of callbacks) callback(message.params ?? {});
  }

  rejectAll(failure) {
    for (const resolver of this.pending.values()) resolver.reject(failure);
    this.pending.clear();
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) ?? [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  send(method, params = {}, browserCommand = false) {
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new AutomationError(`CDP command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolvePromise(value); },
        reject: (error) => { clearTimeout(timeout); rejectPromise(error); },
      });
    });
    const message = { id, method, params };
    if (this.sessionId && !browserCommand) message.sessionId = this.sessionId;
    this.input.write(`${JSON.stringify(message)}\0`);
    return promise;
  }

  close() {
    this.input.end();
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForHttp(url, timeoutMs = 20_000, assertServerRunning = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    assertServerRunning();
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new AutomationError(`服务未在 ${timeoutMs}ms 内就绪。`, lastError?.message);
}

async function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AutomationError("未找到浏览器。Windows 默认使用 Microsoft Edge；其他主机可设置 METORIGIN_UX_BROWSER_EXECUTABLE 指向 Chromium 浏览器可执行文件。");
}

function mockTauriBootstrap() {
  // Existing acceptance scenarios use Chinese labels regardless of the CI host locale.
  localStorage.setItem("metorigin.ui.language", "zh-CN");
  const now = () => new Date().toISOString();
  const projectA = {
    id: "e2e-project-a",
    name: "自动化项目 A",
    path: "C:\\E2E\\ProjectA",
    status: "running",
    updated_at: "2026-08-14T08:00:00Z",
    stage_label: "BrushTraining",
  };
  const projectB = {
    id: "e2e-project-b",
    name: "自动化项目 B",
    path: "C:\\E2E\\ProjectB",
    status: "ready",
    updated_at: "2026-08-14T07:00:00Z",
  };
  const missingProject = {
    id: "e2e-project-missing",
    name: "失效项目 Café 🧪",
    path: "C:\\E2E\\missing\\Café 🧪.splat-project",
    status: "running",
    updated_at: "2026-08-13T07:00:00Z",
  };
  const stageIds = ["MediaValidation", "FrameExtraction", "ImagePreprocessing", "ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation", "TrainingPreparation", "BrushTraining", "ModelValidation", "PreviewGeneration", "Export"];
  const makeSnapshot = (project, stage, status = project.status, sequence = 1, progress = 0.42) => ({
    project_id: project.id,
    project_path: project.path,
    status,
    state: {
      stages: Object.fromEntries(stageIds.map((stageId, index) => {
        const currentIndex = stageIds.indexOf(stage);
        const completed = status === "completed" || (currentIndex >= 0 && index < currentIndex);
        return [stageId, {
          stage_id: stageId,
          status: completed ? "completed" : stageId === stage ? status : "pending",
          progress: completed ? 1 : stageId === stage ? progress : 0,
          started_at: completed || stageId === stage ? now() : null,
          ended_at: completed ? now() : null,
          retry_count: 0,
          error: null,
          log_path: null,
        }];
      })),
      current_stage: stage,
      overall_progress: progress,
    },
    sequence,
    accepted_at: now(),
    started_at: "2026-08-14T08:00:01Z",
    control_intent: "none",
  });
  const state = {
    projects: [projectA, projectB, missingProject],
    activeSnapshot: makeSnapshot(projectA, "BrushTraining", "running", 12, 0.42),
    snapshots: {
      [projectA.id]: makeSnapshot(projectA, "BrushTraining", "running", 12, 0.42),
      [projectB.id]: makeSnapshot(projectB, null, "ready", 0, 0),
    },
    eventListeners: new Map(),
    callbacks: new Map(),
    callbackSequence: 1,
    previewSequence: 1,
    previewRequests: new Map(),
    removedProjectRecords: [],
    commandCalls: [],
    events: Array.from({ length: 1000 }, (_, index) => ({
      event_id: `e2e-event-${index}`,
      project_id: projectA.id,
      sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 7, 14, 8, 0, index % 60)).toISOString(),
      kind: index % 7 === 0 ? "stage_progress" : "log",
      severity: index % 23 === 0 ? "warning" : "info",
      phase_id: "training",
      stage_id: index % 2 === 0 ? "BrushTraining" : "ModelValidation",
      user_message: `SyntheticTarget-${String(index).padStart(4, "0")} 合成活动记录`,
      technical_message: null,
      metrics: { percent: index % 100 },
      source_log: null,
    })),
  };
  const artifact = (relativePath, validated = false) => ({
    relative_path: relativePath,
    exists: validated,
    validated,
    size_bytes: validated ? 128 : 0,
    updated_at: validated ? now() : null,
    error: null,
  });
  const projectPayload = (project) => ({
    schema_version: 1,
    id: project.id,
    name: project.name,
    created_at: "2026-08-14T07:00:00Z",
    updated_at: project.updated_at,
    source: null,
    settings: {
      preset: "balanced",
      max_frames: 300,
      max_long_edge: 1920,
      colmap_max_long_edge: 1920,
      frame_fps: null,
      iterations: null,
      sh_degree: null,
      checkpoint_interval: null,
    },
    status: project.status,
    current_stage: project.stage_label ?? null,
    pipeline_state: state.snapshots[project.id].state,
  });
  const emit = (eventName, payload) => {
    const listeners = state.eventListeners.get(eventName) ?? new Map();
    for (const callbackId of listeners.values()) {
      const callback = state.callbacks.get(callbackId);
      callback?.({ event: eventName, id: 0, payload });
    }
  };
  const handleCommand = async (command, args = {}) => {
    state.commandCalls.push({ command, at: performance.now() });
    if (["get_project_artifacts", "list_checkpoints"].includes(command) && state.resourceGate) {
      await state.resourceGate.promise;
    }
    switch (command) {
      case "app_version": return "0.1.0-e2e";
      case "check_engines": return [];
      case "list_recent_projects":
      case "list_recent_project_index": return state.projects;
      case "check_recent_project_availability": {
        const project = state.projects.find((item) => item.id === args.projectId);
        return {
          project_id: args.projectId,
          checked_path: args.projectPath,
          availability: args.projectId === missingProject.id ? "missing" : "available",
          checked_at: now(),
          reason_code: null,
          refreshed_project: args.projectId === missingProject.id ? null : project ?? null,
        };
      }
      case "get_app_settings": return state.savedSettings ?? {
        engine_directory: "C:\\E2E\\engines",
        engine_executables: {},
        default_project_root: "C:\\E2E",
        default_preset: "balanced",
        create_and_start: true,
        prevent_idle_sleep: false,
        log_retention_mb: 512,
        thumbnail_cache_mb: 1024,
      };
      case "save_app_settings": {
        state.savedSettings = { ...args.settings };
        return state.savedSettings;
      }
      case "get_project_thumbnail": return null;
      case "get_resource_metrics": return null;
      case "get_active_pipeline_summary": return state.activeSnapshot;
      case "get_pipeline_state": {
        const project = state.projects.find((item) => item.path === args.projectPath);
        return project ? state.snapshots[project.id] : state.activeSnapshot;
      }
      case "open_project": {
        const project = state.projects.find((item) => item.path === args.path) ?? projectA;
        return projectPayload(project);
      }
      case "get_project_artifacts": return {
        frames_manifest: artifact("frames/manifest.json", true),
        colmap_result: artifact("colmap/sparse/0", true),
        latest_checkpoint: state.latestCheckpoint ?? null,
        scene_ply: artifact("output/scene.ply", false),
        output_manifest: artifact("output/manifest.json", false),
        registered_images: 80,
        total_images: 100,
        sparse_points: state.sparsePoints ?? 12345,
        mean_reprojection_error: 0.51,
        colmap_validation: null,
        colmap_attempts: [],
        splat_count: null,
      };
      case "list_checkpoints": return state.checkpoints ?? [];
      case "get_frame_preview": return { items: [], total_frames: 100 };
      case "get_sparse_preview_pack": return {
        model_path: "colmap/sparse/0",
        registered_images: 80,
        total_images: 100,
        point_count: 0,
        mean_reprojection_error: 0.51,
        points: [],
        cameras: [],
      };
      case "inspect_ply": return {
        relative_path: args.relativePath ?? "output/scene.ply",
        format: "binary_little_endian",
        vertex_count: 0,
        size_bytes: 0,
        gaussian_compatible: false,
        points: [],
      };
      case "get_pipeline_events": {
        const search = String(args.search ?? "").trim().toLowerCase();
        const severity = args.severity ?? null;
        const stageId = args.stageId ?? null;
        const items = state.events.filter((event) =>
          (!search || event.user_message.toLowerCase().includes(search))
          && (!severity || event.severity === severity)
          && (!stageId || event.stage_id === stageId));
        return { items, next_cursor: null, total: items.length };
      }
      case "preview_workspace_action": {
        const token = `e2e-preview-${state.previewSequence++}`;
        state.previewRequests.set(token, args.request);
        if (args.request.action === "delete_project" && args.request.projectId === missingProject.id) {
          return {
            action: "delete_project",
            targetLabel: `移除项目“${missingProject.name}”的记录`,
            allowed: true,
            blockedReason: null,
            irreversible: false,
            preserved: ["项目目录及其中的残留文件（如有）", "应用设置与其他项目"],
            invalidated: ["当前项目在项目中心的记录"],
            regenerated: [],
            warnings: ["项目目录已丢失，本次只移除项目记录，不会删除任何磁盘文件。"],
            sizeBytes: null,
            previewToken: token,
            createdAt: now(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        }
        return {
          action: args.request.action,
          targetLabel: args.request.action === "pause" ? "暂停当前重建" : "当前重建",
          allowed: true,
          blockedReason: null,
          irreversible: false,
          preserved: ["已验证产物", "当前 Checkpoint"],
          invalidated: [],
          regenerated: [],
          warnings: ["这是合成验收数据，不会执行真实写入。"],
          sizeBytes: null,
          previewToken: token,
          createdAt: now(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
      case "execute_workspace_action": {
        const request = state.previewRequests.get(args.previewToken);
        if (request?.action === "delete_project" && request.projectId === missingProject.id) {
          state.projects = state.projects.filter(project => project.id !== missingProject.id);
          state.removedProjectRecords.push(missingProject.id);
          return {
            kind: "completed",
            receipt: {
              id: "e2e-record-removal-receipt",
              action: "delete_project",
              status: "success",
              title: "项目记录已移除",
              message: "仅移除了项目中心的记录，没有删除任何磁盘文件。",
              completedAt: now(),
              affectedResources: ["recent_projects"],
              dismissible: true,
            },
          };
        }
        return {
        kind: "completed",
        receipt: {
          id: "e2e-receipt",
          action: request?.action ?? "pause",
          status: "success",
          title: "合成操作已完成",
          message: "没有修改真实数据。",
          completedAt: now(),
          affectedResources: [],
          dismissible: true,
        },
        };
      }
      case "open_project_location": return {
        opened: !state.locationError,
        missing: Boolean(state.locationError),
        target_type: args.request?.targetType ?? "project_root",
        message: state.locationError ?? null,
      };
      default: return null;
    }
  };
  const transformCallback = (callback, once = false) => {
    const id = state.callbackSequence++;
    state.callbacks.set(id, (...args) => {
      callback(...args);
      if (once) state.callbacks.delete(id);
    });
    return id;
  };
  const unregisterCallback = (id) => state.callbacks.delete(id);
  const invoke = async (command, args = {}) => {
    if (command === "plugin:event|listen") {
      const eventName = args.event;
      const listeners = state.eventListeners.get(eventName) ?? new Map();
      const listenerId = state.callbackSequence++;
      listeners.set(listenerId, args.handler);
      state.eventListeners.set(eventName, listeners);
      return listenerId;
    }
    if (command === "plugin:event|unlisten") {
      const listeners = state.eventListeners.get(args.event);
      listeners?.delete(args.eventId);
      return null;
    }
    if (command === "plugin:event|emit") {
      emit(args.event, args.payload);
      return null;
    }
    return handleCommand(command, args);
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke,
      transformCallback,
      unregisterCallback,
      convertFileSrc: (path) => path,
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    },
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unregisterCallback };
  window.__E2E__ = {
    state,
    deferWorkspaceResources() {
      let release;
      const promise = new Promise(resolvePromise => { release = resolvePromise; });
      state.resourceGate = { promise, release };
    },
    releaseWorkspaceResources() {
      const gate = state.resourceGate;
      state.resourceGate = null;
      gate?.release();
    },
    setStage(stageId, status = "running") {
      const nextSequence = state.activeSnapshot.sequence + 1;
      const progress = status === "completed" ? 1 : stageId === "ModelValidation" ? 0.82 : 0.52;
      const snapshot = makeSnapshot(projectA, stageId, status, nextSequence, progress);
      state.activeSnapshot = snapshot;
      state.snapshots[projectA.id] = snapshot;
      projectA.stage_label = stageId;
      projectA.status = status;
      emit("pipeline://event", {
        project_id: projectA.id,
        sequence: nextSequence,
        timestamp: now(),
        event: status === "completed" ? { kind: "pipeline_completed" } : { kind: "stage_started", stage_id: stageId },
      });
    },
    emit,
  };
}

function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

async function run() {
  await mkdir(artifactRoot, { recursive: true });
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runner: `${process.env.METORIGIN_UX_BROWSER_EXECUTABLE ? "Explicit Chromium browser" : "Microsoft Edge"} headless + Chrome DevTools Protocol`,
    fixture_policy: "synthetic-only; no real project, media, credential, or user path is collected",
    checks: [],
    timings: {},
    screenshots: [],
    browser_exceptions: [],
    limitations: [
      "This is browser-level frontend automation, not a native Tauri/WebView2 end-to-end run.",
      "Viewport and device scale emulation cannot replace Windows 100%/125%/150% visual inspection.",
      "Human usability sessions and independent reviewer sign-off remain manual acceptance items.",
    ],
  };
  let previewProcess = null;
  let edgeProcess = null;
  let edgeProfilePath = null;
  let cdp = null;
  const check = (name, passed, detail) => {
    report.checks.push({ name, status: passed ? "PASS" : "FAIL", detail });
    process.stdout.write(`[${passed ? "PASS" : "FAIL"}] ${name}\n`);
    if (!passed) throw new AutomationError(`${name}: ${detail}`);
  };
  const progress = (message) => process.stdout.write(`[RUN] ${message}\n`);
  const evaluate = async (expression) => {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new AutomationError(response.exceptionDetails.text ?? "页面脚本执行失败。", response.exceptionDetails);
    }
    return response.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 10_000, message = "页面条件等待超时。") => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // A condition may end in a DOM node; serialize only its truth value.
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(25);
    }
    throw new AutomationError(message, expression);
  };
  const clickButton = async (label, exact = true) => {
    const serialized = JSON.stringify(label);
    const clicked = await evaluate(`(() => {
      const label = ${serialized};
      const candidates = [...document.querySelectorAll('button')].filter((button) => {
        const visible = button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden';
        const name = (button.getAttribute('aria-label') || button.textContent || '').trim();
        return visible && !button.disabled && (${exact ? "name === label" : "name.includes(label)"});
      });
      if (!candidates.length) return false;
      candidates[0].click();
      return true;
    })()`);
    if (!clicked) throw new AutomationError(`找不到可点击按钮：${label}`);
  };
  const capture = async (name) => {
    const response = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = join(artifactRoot, `${name}.png`);
    await writeFile(path, Buffer.from(response.data, "base64"));
    report.screenshots.push(relative(repositoryRoot, path).replaceAll("\\", "/"));
  };
  const setViewport = async (width, height, deviceScaleFactor = 1) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await evaluate("window.dispatchEvent(new Event('resize')); true");
    await sleep(100);
  };
  const dispatchKey = async (key, modifiers = 0) => {
    const keyCode = { Tab: 9, Enter: 13, ArrowDown: 40, ArrowRight: 39, Escape: 27, Home: 36, End: 35 }[key] ?? 0;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };

  try {
    progress("locating browser and building frontend");
    const edgeExecutable = await findExecutable(browserCandidates);
    const build = spawnSync(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm", process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.CMD build"] : ["build"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    check("production-build", build.status === 0, build.status === 0 ? "Vite production build completed." : `Vite production build failed: ${String(build.error?.message ?? build.stderr ?? "").slice(-1000)}`);

    progress("starting preview server and isolated browser CDP session");
    const viteEntry = join(repositoryRoot, "apps", "desktop", "node_modules", "vite", "bin", "vite.js");
    let previewOutput = "";
    let previewFailure = null;
    previewProcess = spawn(process.execPath, [
      viteEntry,
      "preview",
      "--host", "127.0.0.1",
      "--port", String(previewPort),
      "--strictPort",
    ], { cwd: join(repositoryRoot, "apps", "desktop"), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const collectPreviewOutput = (chunk) => { previewOutput = `${previewOutput}${chunk}`.slice(-2000); };
    previewProcess.stdout.on("data", collectPreviewOutput);
    previewProcess.stderr.on("data", collectPreviewOutput);
    previewProcess.on("error", (error) => { previewFailure = error.message; });
    previewProcess.unref();
    await waitForHttp(appUrl, 20_000, () => {
      if (previewFailure || previewProcess.exitCode !== null) {
        throw new AutomationError(`Preview server failed to start: ${previewFailure || previewOutput.trim() || `exit=${previewProcess.exitCode}`}`);
      }
    });

    edgeProfilePath = await mkdtemp(join(artifactRoot, "edge-profile-"));
    edgeProcess = spawn(edgeExecutable, [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${edgeProfilePath}`,
      // The runner opens only the localhost production build with synthetic fixtures.
      // This flag is required by restricted Windows CI/sandbox accounts and never affects the packaged app.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-breakpad",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
    cdp = new CdpClient(edgeProcess);
    report.browser = await cdp.send("Browser.getVersion", {}, true);
    progress(`browser version: ${JSON.stringify(report.browser)}`);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" }, true);
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true }, true);
    cdp.setSessionId(attached.sessionId);
    cdp.on("Runtime.exceptionThrown", (params) => {
      const description = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "Unknown browser exception";
      report.browser_exceptions.push(String(description).slice(0, 500));
    });
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Accessibility.enable"),
    ]);
    await setViewport(1440, 1024, 1);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${mockTauriBootstrap.toString()})()` });
    await cdp.send("Page.navigate", { url: appUrl });
    await waitFor("document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0", 15_000, "应用未完成渲染。");
    await waitFor("[...document.querySelectorAll('h1,h2')].some((node) => node.textContent?.trim() === '项目中心')", 10_000, "项目中心标题未出现。");

    progress("validating page contexts and active-project conflict");
    const homeHasRunControls = await evaluate("Boolean(document.querySelector('[role=progressbar]'))");
    check("home-context-isolation", !homeHasRunControls, "Home renders its own context without project progress controls.");
    await capture("home-1440x1024-100pct");

    progress("validating language selection in the production build");
    await clickButton("设置与引擎");
    await waitFor("[...document.querySelectorAll('#settings-drawer [role=tab]')].some(tab => tab.textContent.trim() === '外观')");
    await clickButton("外观");
    await waitFor("Boolean(document.querySelector('#settings-drawer #language-preference'))");
    const selectLanguage = async (locale) => {
      await evaluate(`(() => {
        const select = document.querySelector('#settings-drawer #language-preference');
        select.value = ${JSON.stringify(locale)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`document.documentElement.lang === ${JSON.stringify(locale)}`);
    };
    await selectLanguage("en");
    check("english-language-selection", await evaluate(`
      localStorage.getItem('metorigin.ui.language') === 'en'
      && Boolean(document.querySelector('button[aria-label="Close settings"]'))
      && [...document.querySelectorAll('h1,h2')].some(node => node.textContent.trim() === 'Project Hub')
      && document.body.textContent.includes('自动化项目 A')
    `), "English selection updates the open settings and workspace while preserving user project names.");
    await capture("settings-english-1440x1024");
    await selectLanguage("zh-CN");
    check("chinese-language-selection", await evaluate(`
      localStorage.getItem('metorigin.ui.language') === 'zh-CN'
      && Boolean(document.querySelector('button[aria-label="关闭设置"]'))
      && [...document.querySelectorAll('h1,h2')].some(node => node.textContent.trim() === '项目中心')
    `), "Chinese selection restores localized settings and workspace without closing the drawer.");

    progress("validating settings switch alignment in both themes");
    report.settings_switch_geometry = [];
    const checkSwitchAlignment = async (selector, theme) => {
      for (const checked of [false, true]) {
        await evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          if ((control.getAttribute('aria-checked') === 'true') !== ${checked}) control.click();
        })()`);
        await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked') === '${checked}' && !document.querySelector(${JSON.stringify(selector)})?.disabled`);
        await evaluate(`Promise.all(document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`);
        const geometry = await evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          const thumb = control.querySelector('[data-slot="switch-thumb"]');
          const trackRect = control.getBoundingClientRect(), thumbRect = thumb.getBoundingClientRect();
          const style = getComputedStyle(control);
          const inset = ${checked} ? trackRect.right - thumbRect.right : thumbRect.left - trackRect.left;
          const expectedInset = ${checked}
            ? parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight)
            : parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
          return { inset, expectedInset, top: thumbRect.top - trackRect.top, bottom: trackRect.bottom - thumbRect.bottom,
            thumbWidth: thumbRect.width, thumbHeight: thumbRect.height, trackWidth: trackRect.width, trackHeight: trackRect.height };
        })()`);
        report.settings_switch_geometry.push({ selector, theme, checked, ...geometry });
        check(`settings-switch-${selector.slice(1)}-${theme}-${checked ? 'on' : 'off'}`,
          Math.abs(geometry.inset - geometry.expectedInset) <= 0.35
          && Math.abs(geometry.top - geometry.bottom) <= 0.35
          && Math.abs(geometry.thumbWidth - geometry.thumbHeight) <= 0.35
          && geometry.top >= 0.5 && geometry.bottom >= 0.5,
          "The circular thumb stays centered vertically and reaches equal inset edges in each state.");
      }
    };
    for (const theme of ["light", "dark"]) {
      await evaluate(`localStorage.setItem('metorigin.ui.theme', '${theme}'); window.dispatchEvent(new Event('metorigin-theme-change')); true`);
      await waitFor(`document.documentElement.dataset.theme === '${theme}'`);
      await clickButton("常规");
      await checkSwitchAlignment("#create-and-start", theme);
      await capture(`settings-general-switch-${theme}`);
      await clickButton("性能与存储");
      if (await evaluate("Boolean(document.querySelector('#idle-sleep'))")) {
        await checkSwitchAlignment("#idle-sleep", theme);
        await capture(`settings-idle-sleep-switch-${theme}`);
      }
    }
    await evaluate("localStorage.setItem('metorigin.ui.theme', 'light'); window.dispatchEvent(new Event('metorigin-theme-change')); true");
    await waitFor("document.documentElement.dataset.theme === 'light'");
    await clickButton("关闭设置");

    await clickButton("自动化项目 B");
    await waitFor("[...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === '自动化项目 B')", 10_000, "未进入项目 B。");
    await waitFor("Boolean(document.querySelector('button[aria-label=\"开始重建\"][aria-disabled=\"true\"][aria-describedby]'))", 10_000, "项目 B 未阻止与活动项目冲突的启动操作。");
    const conflictState = await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="开始重建"]');
      return button ? { focusable: !button.disabled, ariaDisabled: button.getAttribute('aria-disabled'), described: Boolean(document.getElementById(button.getAttribute('aria-describedby'))?.textContent?.trim()) } : null;
    })()`);
    check("active-project-conflict", conflictState?.focusable && conflictState.ariaDisabled === "true" && conflictState.described,
      "Project B remains navigable while its start action is focusable, described, and blocked by active project A.");
    await evaluate(`(() => {
      const button = document.querySelector('button[aria-label="开始重建"][aria-disabled="true"]');
      button.focus();
      button.click();
    })()`);
    await waitFor("[...document.querySelectorAll('[role=alert]')].some(alert => alert.textContent.includes('当前有重建任务尚未结束'))", 2_000, "受阻的启动操作未说明原因。");
    const blockedAttempt = await evaluate(`({
      focusRetained: document.activeElement?.getAttribute('aria-disabled') === 'true',
      started: window.__E2E__.state.commandCalls.some((call) => call.command === 'start_pipeline'),
    })`);
    check("active-project-blocked-attempt", blockedAttempt.focusRetained && !blockedAttempt.started,
      "Attempting the blocked start explains the conflict, retains focus, and never invokes start_pipeline.");
    // The approved sidebar contains only navigation/settings; the full gallery
    // owns project switching rather than duplicating recent projects in the rail.
    await clickButton("项目中心");
    await waitFor("Boolean(document.querySelector('button[aria-label=\"自动化项目 A\"]'))");
    await clickButton("自动化项目 A");
    await waitFor("[...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === '自动化项目 A')", 10_000, "未返回活动项目 A。");
    await waitFor("Boolean(document.querySelector('.preview-panel'))", 10_000, "项目工作区未完成加载。");

    await evaluate("document.fonts.ready.then(() => true)");
    const measureWorkspace = () => evaluate(`(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
      };
      return {
        content: rect('main'),
        titlebar: rect('.desktop-app-shell > header'),
        grid: rect('.project-workspace-grid'),
        feedback: rect('.project-resource-feedback'),
        timeline: rect('.timeline-panel'),
        inspector: rect('.inspector-column'),
        preview: rect('.preview-panel'),
        viewport: rect('.scene-viewport-panel'),
        details: rect('.inspector-details-panel'),
        monitor: rect('.workspace-inspector-stack'),
        phases: [...document.querySelectorAll('.pipeline-timeline .phase-summary')].map(node => {
          const value = node.getBoundingClientRect();
          return { top: value.top, height: value.height };
        }),
      };
    })()`);
    let workspaceLayout;
    let workspaceLayoutValid = false;
    const layoutDeadline = Date.now() + 3000;
    do {
      // The loading placeholder and workspace reuse a div. Wait through style,
      // font and ResizeObserver frames before judging the final desktop layout.
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      workspaceLayout = await measureWorkspace();
      workspaceLayoutValid = Boolean(
      workspaceLayout.content
      && workspaceLayout.titlebar
      && workspaceLayout.grid
      && workspaceLayout.feedback
      && workspaceLayout.timeline
      && workspaceLayout.inspector
      && workspaceLayout.preview
      && workspaceLayout.viewport
      && workspaceLayout.details
      && workspaceLayout.monitor
      && workspaceLayout.phases.length === 4
      && workspaceLayout.phases.every(phase => phase.height > 0 && phase.height <= 48 && Math.abs(phase.top - workspaceLayout.phases[0].top) <= 1)
      && Math.abs(workspaceLayout.titlebar.height - 48) <= 1
      && workspaceLayout.titlebar.bottom <= workspaceLayout.grid.top + 1
      && (workspaceLayout.feedback.height === 0 || workspaceLayout.feedback.bottom <= workspaceLayout.timeline.top + 1)
      && workspaceLayout.timeline.height > 0
      && workspaceLayout.timeline.bottom <= workspaceLayout.inspector.top + 1
      && Math.abs(workspaceLayout.viewport.top - workspaceLayout.details.top) <= 1
      && workspaceLayout.viewport.right <= workspaceLayout.details.left + 1
      && workspaceLayout.preview.left >= workspaceLayout.viewport.left - 1
      && workspaceLayout.preview.right <= workspaceLayout.viewport.right + 1
      && workspaceLayout.monitor.top >= workspaceLayout.details.top - 1
      && workspaceLayout.preview.right <= workspaceLayout.monitor.left + 1
      && workspaceLayout.preview.height >= 288
      && workspaceLayout.inspector.bottom <= workspaceLayout.content.bottom + 1
      );
      if (workspaceLayoutValid) break;
      await sleep(50);
    } while (Date.now() < layoutDeadline);
    report.workspace_layout = workspaceLayout;
    if (!workspaceLayoutValid) {
      report.workspace_layout_diagnostics = await evaluate(`(() => {
        const selectors = ['main', '.project-workspace-grid', '.timeline-panel', '.inspector-column', '.scene-viewport-panel', '.inspector-details-panel'];
        const properties = ['display', 'position', 'box-sizing', 'width', 'min-width', 'max-width', 'height', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'align-items', 'align-self', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'overflow', 'font-size'];
        const describe = node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return { tag: node.tagName, className: node.getAttribute('class'), hidden: Boolean(node.hidden), rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }, computed: { display: style.display, flex: style.flex } };
        };
        const nodes = selectors.map(selector => {
          const node = document.querySelector(selector);
          const style = node && getComputedStyle(node);
          return { selector, className: node?.className, inlineStyle: node?.getAttribute('style'), computed: style && Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])) };
        });
        const rules = [];
        const visit = (list, sheet) => {
          for (const rule of list) {
            if (rule.selectorText && ['.project-workspace-grid', '.workspace-loading', '.workspace-empty-state'].some(selector => rule.selectorText.includes(selector))) rules.push({ sheet, selector: rule.selectorText, style: rule.style.cssText });
            if (rule.cssRules) visit(rule.cssRules, sheet);
          }
        };
        const stylesheets = [...document.styleSheets].map(sheet => {
          try { visit(sheet.cssRules, sheet.href); return { href: sheet.href, disabled: sheet.disabled, rules: sheet.cssRules.length }; }
          catch (error) { return { href: sheet.href, error: error.name }; }
        });
        return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, fonts: document.fonts.status, rootSpacing: getComputedStyle(document.documentElement).getPropertyValue('--spacing'), mainChildren: [...(document.querySelector('main')?.children ?? [])].map(describe), workspaceGrids: [...document.querySelectorAll('.project-workspace-grid')].map(describe), nodes, stylesheets, rules };
      })()`);
      progress(`workspace layout diagnostics: ${JSON.stringify(report.workspace_layout_diagnostics)}`);
    }
    check("project-workspace-grid-placement", workspaceLayoutValid,
      workspaceLayoutValid
        ? "A 48px desktop header and four compact phase controls sit above the sibling viewport and inspector within the visible workspace."
        : `Workspace children escaped their intended tracks: ${JSON.stringify(workspaceLayout)}`);
    check("workspace-redundant-content-hidden", await evaluate(`
      !document.querySelector('.preview-panel > .panel-title')
      && !document.querySelector('.workspace-inspector-stack .task-status-card')
      && !document.querySelector('.workspace-background-note p')
      && !document.querySelector('.resource-meter [aria-label="GPU"]')
      && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '查看日志与活动')
    `), "The active workspace uses its phase navigator for progress, omits repeated preview/status copy and unavailable GPU data, and keeps logs accessible.");
    await capture("project-workspace-layout-1440x1024-100pct");
    check("workspace-titlebar-spacing", workspaceLayout.timeline.top - workspaceLayout.titlebar.bottom >= 11.5,
      "The phase navigator has at least 12px of separation from the desktop titlebar.");
    const viewportInspectorGap = workspaceLayout.details.left - workspaceLayout.viewport.right;
    check("workspace-divider-hidden", await evaluate(`
      !document.querySelector('.workspace-resize-handle, .inspector-column [role="separator"], .inspector-column [data-slot="resizable-handle"]')
      && parseFloat(getComputedStyle(document.querySelector('.inspector-details-panel')).borderLeftWidth) === 0
      && parseFloat(getComputedStyle(document.querySelector('.scene-viewport-panel')).borderRightWidth) === 0
    `) && Math.abs(viewportInspectorGap - 12) <= 0.5,
      "The preview and inspector keep a 12px visible gap with no separator, drag handle or separating panel border.");
    const measureInspectorAlignment = () => evaluate(`(() => {
      const rect = node => {
        const value = node.getBoundingClientRect();
        return { top: value.top, left: value.left, right: value.right, width: value.width };
      };
      return { phase: rect(document.querySelector('.timeline-phase:last-child')),
        cards: [...document.querySelectorAll('.workspace-inspector-card')].map(rect),
        preview: rect(document.querySelector('.preview-panel')),
        viewport: { width: innerWidth, height: innerHeight },
        sidebarCollapsed: Boolean(document.querySelector('button[aria-label="展开项目栏"]')) };
    })()`);
    const inspectorMatchesPhase = layout => layout.cards.length >= 2
      && layout.cards.every(card => ['left', 'right', 'width'].every(property => Math.abs(card[property] - layout.phase[property]) <= 0.5))
      && Math.abs(layout.cards[0].top - layout.preview.top) <= 0.5
      && Math.abs(layout.cards[0].left - layout.preview.right - 12) <= 0.5;
    report.inspector_phase_alignment = [];
    for (const [width, collapsed] of [[1440, false], [1920, false], [1920, true], [1440, true], [1280, false]]) {
      await setViewport(width, width === 1920 ? 1080 : 1024);
      const sidebarCollapsed = await evaluate("Boolean(document.querySelector('button[aria-label=\"展开项目栏\"]'))");
      if (sidebarCollapsed !== collapsed) await clickButton(collapsed ? "折叠项目栏" : "展开项目栏");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      const alignment = await measureInspectorAlignment();
      report.inspector_phase_alignment.push(alignment);
      check(`workspace-inspector-phase-${width}-${collapsed ? 'collapsed' : 'expanded'}`, inspectorMatchesPhase(alignment),
        "All right-hand cards share the fourth phase's left edge, right edge and width, stay aligned with the preview top and keep a 12px preview gap.");
      await capture(`project-inspector-phase-${width}-${collapsed ? 'collapsed' : 'expanded'}`);
    }
    const chineseHeader = await evaluate(`(() => {
      const header = document.querySelector('.quality-panel .panel-title');
      const title = header.querySelector('span');
      const button = header.querySelector('button');
      const titleRect = title.getBoundingClientRect(), buttonRect = button.getBoundingClientRect(), headerRect = header.getBoundingClientRect();
      return { centerDelta: Math.abs((titleRect.top + titleRect.bottom - buttonRect.top - buttonRect.bottom) / 2),
        titleHeight: titleRect.height, lineHeight: parseFloat(getComputedStyle(title).lineHeight),
        buttonContained: buttonRect.left >= headerRect.left && buttonRect.right <= headerRect.right };
    })()`);
    report.inspector_chinese_header = chineseHeader;
    check("workspace-inspector-chinese-header-1280", chineseHeader.centerDelta <= 0.5
      && chineseHeader.titleHeight <= chineseHeader.lineHeight + 0.5 && chineseHeader.buttonContained,
      "The Chinese quality heading and details button remain on one row at 1280px with the sidebar expanded.");
    await evaluate("localStorage.setItem('metorigin.ui.language', 'en'); window.dispatchEvent(new Event('metorigin-language-change')); true");
    await waitFor("document.documentElement.lang === 'en'");
    const englishInspector = await evaluate(`(() => {
      const quality = document.querySelector('.quality-panel');
      const cardRect = quality.getBoundingClientRect();
      return { cardWidth: cardRect.width, buttons: [...quality.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { label: (button.getAttribute('aria-label') || button.textContent).trim(),
          left: rect.left, right: rect.right, cardLeft: cardRect.left, cardRight: cardRect.right,
          clientWidth: button.clientWidth, scrollWidth: button.scrollWidth };
      }) };
    })()`);
    report.inspector_english_controls = englishInspector;
    check("workspace-inspector-english-controls-1280", englishInspector.buttons.every(button => button.left >= button.cardLeft - 0.5
      && button.right <= button.cardRight + 0.5 && button.scrollWidth <= button.clientWidth + 1),
      "The narrower fourth-phase-width inspector keeps English action buttons within their card without clipped content at 1280px with the sidebar expanded.");
    await capture("project-inspector-phase-1280-expanded-english");
    await evaluate("localStorage.setItem('metorigin.ui.language', 'zh-CN'); window.dispatchEvent(new Event('metorigin-language-change')); true");
    await waitFor("document.documentElement.lang === 'zh-CN'");
    await setViewport(1440, 1024);
    await waitFor("Boolean(document.querySelector('button[aria-label=\"折叠项目栏\"]'))");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");

    progress("validating silent background resource polling");
    // The workspace shell can settle before the lazy Gaussian module mounts.
    // Take the refresh baseline only after that initial preview mount commits.
    await waitFor("Boolean(document.querySelector('.point-cloud-canvas'))", 10_000, "高斯预览容器未完成首次挂载。");
    const pollBaseline = await measureWorkspace();
    await evaluate(`(() => {
      const state = window.__E2E__.state;
      state.resourceCallStart = state.commandCalls.length;
      state.workspaceNodes = ['.project-workspace-grid', '.timeline-panel', '.preview-panel', '.point-cloud-canvas'].map(selector => document.querySelector(selector));
      window.__E2E__.deferWorkspaceResources();
      return true;
    })()`);
    await waitFor(`(() => {
      const calls = window.__E2E__.state.commandCalls.slice(window.__E2E__.state.resourceCallStart);
      return calls.some(call => call.command === 'get_project_artifacts') && calls.some(call => call.command === 'list_checkpoints');
    })()`, 12_000, "工作区后台轮询未开始。");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    const pendingLayout = await measureWorkspace();
    const backgroundIdentity = () => evaluate(`(() => {
      const selectors = ['.project-workspace-grid', '.timeline-panel', '.preview-panel', '.point-cloud-canvas'];
      return selectors.every((selector, index) => window.__E2E__.state.workspaceNodes[index] === document.querySelector(selector))
        && !document.querySelector('.project-resource-feedback')?.textContent.trim();
    })()`);
    const stablePreviewLayout = layout => ['timeline', 'viewport', 'preview'].every(selector =>
      ['top', 'left', 'width', 'height'].every(property => Math.abs(layout[selector][property] - pollBaseline[selector][property]) <= 0.5));
    const pendingIdentity = await backgroundIdentity();
    report.workspace_background_poll = { baseline: pollBaseline, pending: pendingLayout, pendingIdentity };
    check("workspace-background-poll-pending", pendingIdentity && stablePreviewLayout(pendingLayout),
      "A delayed 10-second artifact/checkpoint poll preserves the workspace, phase navigator and preview nodes and rectangles without inserting a refresh message.");
    await capture("project-background-poll-pending");
    await evaluate(`(() => {
      window.__E2E__.state.sparsePoints = 23456;
      const checkpoint = { iteration: 500, relative_path: 'checkpoints/500.ply', size_bytes: 128, created_at: '2026-10-31T00:00:00Z', vertex_count: 4, brush_version: 'e2e', valid: true, current: false };
      window.__E2E__.state.checkpoints = [checkpoint];
      window.__E2E__.state.latestCheckpoint = checkpoint;
      window.__E2E__.releaseWorkspaceResources();
      return true;
    })()`);
    await waitFor("document.querySelector('.quality-metric-grid')?.textContent.includes('23,456') && [...document.querySelectorAll('button')].some(button => button.textContent.includes('恢复点（1）'))", 3_000, "后台结果未更新质量与恢复点数据。");
    const completedPollLayout = await measureWorkspace();
    check("workspace-background-poll-complete", await backgroundIdentity() && stablePreviewLayout(completedPollLayout),
      "New quality/checkpoint data updates in place while the workspace, phase navigator and preview keep their DOM identities and geometry.");
    report.workspace_background_poll.completed = completedPollLayout;
    check("workspace-latest-checkpoint-card-hidden", await evaluate(`
      Boolean(window.__E2E__.state.latestCheckpoint)
      && !document.querySelector('.recent-checkpoint-card')
      && !document.querySelector('.workspace-inspector-stack')?.textContent.includes('最近恢复点')
      && [...document.querySelectorAll('.workspace-inspector-stack button')].some(button => button.textContent.includes('恢复点（1）'))
    `), "Even with a published latest checkpoint, its redundant card stays hidden and the checkpoint-management button remains available.");

    await evaluate("document.querySelector('#phase-summary-media').click(); true");
    await waitFor("Boolean(document.querySelector('#phase-stage-list-media'))");
    await capture("project-stage-popover-open");
    const outsidePoint = await evaluate(`(() => {
      const rect = document.querySelector('.preview-panel').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...outsidePoint, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...outsidePoint, button: "left", clickCount: 1 });
    await waitFor("!document.querySelector('#phase-stage-list-media')");
    check("stage-popover-outside-click", true, "Clicking the preview closes the expanded stage details.");

    progress("collecting SC-003 action-feedback timing samples");
    await clickButton("暂停");
    await waitFor("Boolean(document.querySelector('[role=alertdialog]'))", 2_000, "暂停影响对话框预热失败。");
    await clickButton("取消");
    await waitFor("!document.querySelector('[role=alertdialog]')", 2_000, "暂停影响对话框预热清理失败。");
    const feedbackSamples = [];
    for (let index = 0; index < 20; index += 1) {
      await evaluate(`(() => {
        const button = document.querySelector('button[aria-label="暂停"]');
        if (!button) return false;
        window.__E2E_TIMING_START__ = performance.now();
        button.click();
        return true;
      })()`);
      await waitFor("Boolean(document.querySelector('[role=alertdialog]'))", 2_000, "暂停影响对话框未及时出现。");
      feedbackSamples.push(await evaluate("performance.now() - window.__E2E_TIMING_START__"));
      await clickButton("取消");
      await waitFor("!document.querySelector('[role=alertdialog]')", 2_000, "影响对话框未关闭。");
    }
    report.timings.SC003 = {
      description: "visible busy/impact feedback after a user-triggered action",
      samples_ms: feedbackSamples.map(rounded),
      p95_ms: rounded(percentile95(feedbackSamples)),
      threshold_ms: 1000,
      status: percentile95(feedbackSamples) <= 1000 ? "PASS" : "FAIL",
    };
    check("SC-003-p95", report.timings.SC003.status === "PASS", `p95=${report.timings.SC003.p95_ms}ms; threshold=1000ms.`);

    progress("validating shared notifications from independent page and app owners");
    await clickButton("恢复点（1）");
    await waitFor("Boolean(document.querySelector('#checkpoint-drawer'))");
    await clickButton("删除");
    await waitFor("Boolean(document.querySelector('#workspace-action-dialog'))");
    await evaluate(`(() => {
      [...document.querySelectorAll('#workspace-action-dialog button')].find(button => button.textContent.trim() === '删除').click();
      return true;
    })()`);
    await waitFor("!document.querySelector('#workspace-action-dialog') && Boolean(document.querySelector('.feedback-notification--success'))");
    await clickButton("关闭 Checkpoint 管理器");
    await waitFor("!document.querySelector('#checkpoint-drawer')");
    await evaluate(`window.__E2E__.state.locationError = '项目已创建；另一个项目仍在运行，因此本项目未启动，也未进入队列。'.repeat(2) + 'LongDiagnosticWithoutSpaces'.repeat(7); true`);
    await clickButton("打开输出目录");
    await waitFor("document.querySelector('.feedback-notification-stack .feedback-notification--error')?.textContent.includes(window.__E2E__.state.locationError)");
    report.notification_geometry = [];
    for (const width of [1440, 320]) {
      await setViewport(width, width === 1440 ? 1024 : 768);
      const geometry = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.feedback-notification-stack .feedback-notification')];
        const rect = node => {
          const value = node.getBoundingClientRect();
          return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
        };
        return {
          width: innerWidth,
          stacks: document.querySelectorAll('.feedback-notification-stack').length,
          cards: cards.map(card => ({ rect: rect(card), dismiss: rect(card.querySelector('.feedback-notification__dismiss')), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth })),
          fullMessage: cards.some(card => card.textContent.includes(window.__E2E__.state.locationError)),
        };
      })()`);
      report.notification_geometry.push(geometry);
      const sorted = geometry.cards.toSorted((left, right) => left.rect.top - right.rect.top);
      check(`shared-notification-layout-${width}`, geometry.stacks === 1 && geometry.cards.length === 2 && geometry.fullMessage
        && sorted[0].rect.bottom + 7.5 <= sorted[1].rect.top
        && geometry.cards.every(card => card.rect.left >= 0 && card.rect.right <= width + 0.5 && card.scrollWidth <= card.clientWidth + 1
          && card.rect.height <= 64
          && card.dismiss.left >= card.rect.left && card.dismiss.right <= card.rect.right && card.dismiss.top >= card.rect.top && card.dismiss.bottom <= card.rect.bottom),
        "Success and error share a compact non-overlapping stack, show at most two lines and keep dismiss controls inside each card.");
      await capture(`shared-notifications-${width}`);
    }
    await clickButton("关闭错误提示");
    await waitFor("!document.querySelector('.feedback-notification-stack .feedback-notification--error')");
    check("shared-notification-independent-dismiss", await evaluate("document.querySelector('.feedback-notification--success')?.textContent.includes('恢复点已删除')"),
      "Dismissing the global error preserves the independently owned page receipt.");
    await evaluate("document.querySelector('.feedback-notification--success .feedback-notification__dismiss').click(); window.__E2E__.state.locationError = null; true");
    await waitFor("!document.querySelector('.feedback-notification-stack .feedback-notification')");
    await setViewport(1440, 1024);

    await evaluate("window.__E2E__.state.locationError = '项目位置不可用'; window.__E2E_TOAST_START__ = performance.now(); true");
    await clickButton("打开输出目录");
    await waitFor("Boolean(document.querySelector('.feedback-notification-stack .feedback-notification--error'))");
    await sleep(4200);
    check("error-notification-visible-before-timeout", await evaluate("Boolean(document.querySelector('.feedback-notification-stack .feedback-notification--error'))"),
      "The error notification remains visible before its five-second timeout.");
    await waitFor("!document.querySelector('.feedback-notification-stack .feedback-notification--error')", 2500);
    const errorToastDuration = await evaluate("performance.now() - window.__E2E_TOAST_START__");
    check("error-notification-five-second-timeout", errorToastDuration >= 4900 && errorToastDuration <= 6500,
      `The app-owned error clears itself after five seconds (${rounded(errorToastDuration)}ms).`);
    await evaluate("window.__E2E__.state.locationError = null; true");

    progress("collecting SC-009 pipeline-update timing samples");
    await evaluate("window.__E2E__.setStage('BrushTraining'); true");
    await evaluate("document.querySelector('#phase-summary-training').click(); true");
    await waitFor("document.querySelector('#stage-button-BrushTraining')?.getAttribute('aria-current') === 'step'", 3_000,
      "Pipeline 状态传播预热失败。");
    const pipelineSamples = [];
    for (let index = 0; index < 20; index += 1) {
      const stage = index % 2 === 0 ? "ModelValidation" : "BrushTraining";
      const label = stage === "ModelValidation" ? "模型校验" : "Brush 训练";
      await evaluate(`window.__E2E_TIMING_START__ = performance.now(); window.__E2E__.setStage(${JSON.stringify(stage)}); true`);
      await waitFor(`(() => {
        const value = document.querySelector('#stage-button-${stage}');
        return value?.getClientRects().length > 0
          && value.getAttribute('aria-current') === 'step'
          && value.textContent.includes(${JSON.stringify(label)})
          && value.querySelector('.stage-list-progress')?.textContent.includes('运行中');
      })()`, 3_000, `阶段 ${label} 未及时显示。`);
      pipelineSamples.push(await evaluate("performance.now() - window.__E2E_TIMING_START__"));
    }
    report.timings.SC009 = {
      description: "pipeline event to visible stage update",
      samples_ms: pipelineSamples.map(rounded),
      p95_ms: rounded(percentile95(pipelineSamples)),
      threshold_ms: 2000,
      status: percentile95(pipelineSamples) <= 2000 ? "PASS" : "FAIL",
    };
    check("SC-009-p95", report.timings.SC009.status === "PASS", `p95=${report.timings.SC009.p95_ms}ms; threshold=2000ms.`);
    await evaluate("document.querySelector('#phase-summary-training').click(); true");

    progress("validating the three inspector card surfaces in both themes");
    await evaluate("window.__E2E__.setStage(null, 'completed'); true");
    await waitFor("document.querySelectorAll('.workspace-inspector-card').length === 3 && document.querySelector('.task-status-card')?.textContent.includes('重建完成')", 3_000, "合成完成状态的三个信息卡未出现。");
    report.inspector_card_surfaces = [];
    for (const theme of ["light", "dark"]) {
      await evaluate(`localStorage.setItem('metorigin.ui.theme', '${theme}'); window.dispatchEvent(new Event('metorigin-theme-change')); true`);
      await waitFor(`document.documentElement.dataset.theme === '${theme}'`);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      const surfaces = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.workspace-inspector-card')];
        const rect = node => {
          const value = node.getBoundingClientRect();
          return { top: value.top, left: value.left, right: value.right, width: value.width };
        };
        const quality = document.querySelector('.quality-panel');
        return { theme: document.documentElement.dataset.theme,
          cards: cards.map(card => ({ background: getComputedStyle(card).backgroundColor, rect: rect(card) })),
          qualityHeaderBackground: getComputedStyle(quality.querySelector('.panel-title')).backgroundColor,
          qualityBackground: getComputedStyle(quality).backgroundColor,
          phase: rect(document.querySelector('.timeline-phase:last-child')),
          preview: rect(document.querySelector('.preview-panel')) };
      })()`);
      report.inspector_card_surfaces.push(surfaces);
      check(`workspace-inspector-card-surfaces-${theme}`, surfaces.cards.length === 3
        && surfaces.cards.every(card => card.background === surfaces.cards[0].background)
        && surfaces.qualityHeaderBackground === 'rgba(0, 0, 0, 0)'
        && Math.abs(surfaces.cards[0].rect.top - surfaces.preview.top) <= 0.5
        && surfaces.cards.every(card => ['left', 'right', 'width'].every(property => Math.abs(card.rect[property] - surfaces.phase[property]) <= 0.5))
        && Math.abs(surfaces.cards[0].rect.left - surfaces.preview.right - 12) <= 0.5,
        "Completion, reconstruction-quality and resource cards use the same surface and fourth-phase width; the transparent quality header preserves that surface, with top alignment and a 12px preview gap.");
      await capture(`project-inspector-cards-${theme}`);
    }
    await evaluate("localStorage.setItem('metorigin.ui.theme', 'light'); window.dispatchEvent(new Event('metorigin-theme-change')); true");
    await waitFor("document.documentElement.dataset.theme === 'light'");
    await setViewport(1920, 1080);
    await clickButton("折叠项目栏");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    const completedAlignment = await measureInspectorAlignment();
    report.inspector_completed_alignment = completedAlignment;
    check("workspace-inspector-phase-1920-collapsed-completed", completedAlignment.cards.length === 3 && inspectorMatchesPhase(completedAlignment),
      "All three completed-project cards align with the fourth phase at 1920px with the sidebar collapsed.");
    await capture("project-inspector-phase-1920-collapsed-completed");
    await clickButton("展开项目栏");
    await setViewport(1440, 1024);
    await evaluate("localStorage.setItem('metorigin.ui.theme', 'light'); window.dispatchEvent(new Event('metorigin-theme-change')); window.__E2E__.setStage('BrushTraining'); true");
    await waitFor("document.documentElement.dataset.theme === 'light' && !document.querySelector('.task-status-card')", 3_000, "无法恢复合成训练状态。");

    progress("collecting SC-010 thousand-event search timing samples");
    check("thousand-event-fixture", await evaluate("window.__E2E__.state.events.length === 1000"),
      "Search operates on a 1000-event synthetic source while retaining the selected-stage filter.");
    await clickButton("查看日志与活动");
    await waitFor("Boolean(document.querySelector('input[aria-label=\"搜索活动记录\"]'))", 10_000, "活动搜索框未出现。");
    const searchGeometry = await evaluate(`(() => {
      const input = document.querySelector('.activity-search input');
      const icon = document.querySelector('.activity-search > svg');
      const textLeft = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft);
      return { textLeft, iconRight: icon.getBoundingClientRect().right, paddingLeft: getComputedStyle(input).paddingLeft };
    })()`);
    report.activity_search_geometry = searchGeometry;
    check("activity-search-icon-spacing", searchGeometry.textLeft - searchGeometry.iconRight >= 8,
      `The search text clears the icon by at least 8px (padding-left: ${searchGeometry.paddingLeft}).`);
    await evaluate("Promise.all(document.querySelector('.workspace-activity-drawer').getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)");
    await capture("project-activity-search-spacing");
    const searchResultReady = (targetText) => `(() => {
      const rows = [...document.querySelectorAll('.activity-event-row')];
      return document.querySelector('.activity-panel')?.getAttribute('aria-busy') === 'false'
        && rows.length === 1 && rows[0].textContent.includes(${JSON.stringify(targetText)});
    })()`;
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="搜索活动记录"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'SyntheticTarget-0840');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(searchResultReady("SyntheticTarget-0840"), 3_000,
      "千条活动记录搜索预热失败。");
    const searchSamples = [];
    for (let index = 0; index < 20; index += 1) {
      // The workspace intentionally retains the selected BrushTraining stage;
      // choose even synthetic rows so this measures search, not an absent cross-stage result.
      const targetText = `SyntheticTarget-${String(index * 42).padStart(4, "0")}`;
      await evaluate(`(() => {
        const input = document.querySelector('input[aria-label="搜索活动记录"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        window.__E2E_TIMING_START__ = performance.now();
        setter.call(input, ${JSON.stringify(targetText)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      // A target can already exist in the previous unfiltered page. Require
      // the settled query-specific result, including the real debounce/load.
      await waitFor(searchResultReady(targetText), 3_000, "千条活动记录搜索未及时仅返回当前目标项。");
      searchSamples.push(await evaluate("performance.now() - window.__E2E_TIMING_START__"));
    }
    report.timings.SC010 = {
      description: "1000-event activity search input to visible filtered result",
      samples_ms: searchSamples.map(rounded),
      p95_ms: rounded(percentile95(searchSamples)),
      threshold_ms: 2000,
      status: percentile95(searchSamples) <= 2000 ? "PASS" : "FAIL",
    };
    check("SC-010-p95", report.timings.SC010.status === "PASS", `p95=${report.timings.SC010.p95_ms}ms; threshold=2000ms.`);

    progress("validating keyboard contracts");
    await clickButton("关闭日志");
    await waitFor("!document.querySelector('.workspace-activity-drawer')", 2_000, "日志抽屉未关闭。");
    await evaluate(`(() => {
      const trigger = document.querySelector('button[aria-label="操作"]');
      trigger.focus();
      return document.activeElement === trigger;
    })()`);
    await dispatchKey("ArrowDown");
    await waitFor("document.activeElement?.getAttribute('role') === 'menuitem'", 2_000, "操作菜单未按方向键打开并聚焦菜单项。");
    await dispatchKey("Escape");
    await waitFor("!document.querySelector('[role=menu]') && document.activeElement?.getAttribute('aria-label') === '操作'", 2_000,
      "Escape 关闭菜单后未恢复触发器焦点。");
    check("keyboard-menu-contract", true, "ArrowDown opens and Escape closes the menu with focus restored.");

    await clickButton("查看日志与活动");
    await waitFor("Boolean(document.querySelector('[role=tab]'))", 2_000, "日志标签页未出现。");
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role=tab]')].find((item) => item.textContent?.trim() === '活动日志');
      tab.focus();
      return true;
    })()`);
    await dispatchKey("ArrowRight");
    await waitFor("[...document.querySelectorAll('[role=tab]')].some((item) => item.textContent?.trim() === '事件' && item.getAttribute('aria-selected') === 'true')", 2_000, "活动标签页方向键切换失败。");
    const tabsKeyboardState = await evaluate(`(() => {
      const list = document.querySelector('[role=tablist][aria-label="Pipeline 活动筛选"]');
      return list?.querySelectorAll('[role=tab][tabindex="0"]').length === 1
        && document.activeElement?.getAttribute('role') === 'tab'
        && document.activeElement?.getAttribute('aria-selected') === 'true';
    })()`);
    check("keyboard-tabs-contract", tabsKeyboardState, "Right Arrow activates the next tab using a single roving tab stop.");

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "forced-colors", value: "active" },
      ],
    });
    const mediaPreferences = await evaluate(`({
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forcedColors: matchMedia('(forced-colors: active)').matches,
    })`);
    check("media-preference-hooks", mediaPreferences.reducedMotion && mediaPreferences.forcedColors,
      "Reduced-motion and forced-colors media queries activate under browser emulation.");
    await capture("project-forced-colors-reduced-motion");
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "forced-colors", value: "none" },
      ],
    });
    await waitFor("!matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches", 2_000,
      "无法恢复常规颜色并保留 reduced-motion 仿真。");
    await clickButton("关闭日志");
    await waitFor("!document.querySelector('.workspace-activity-drawer')", 2_000, "日志抽屉未关闭。");

    progress("capturing conservative 1024x768 scale-emulation screenshots");
    for (const scale of [1, 1.25, 1.5]) {
      const cssWidth = Math.round(1024 / scale);
      const cssHeight = Math.round(768 / scale);
      await setViewport(cssWidth, cssHeight, scale);
      await waitFor("Boolean(document.querySelector('button[aria-label=\"打开项目导航\"]'))", 3_000, "窄窗项目导航入口未出现。");
      const drawerTrigger = await evaluate(`(() => {
        const button = document.querySelector('button[aria-label="打开项目导航"]');
        button.focus();
        button.click();
        return Boolean(button);
      })()`);
      await waitFor("document.querySelector('#project-drawer[role=dialog]')?.textContent.includes('项目导航')", 3_000, "项目导航抽屉未通过一次操作打开。");
      const drawerState = await evaluate(`(() => {
        const dialog = document.querySelector('#project-drawer[role=dialog]');
        const names = dialog ? [...dialog.querySelectorAll('button')].map(button => (button.getAttribute('aria-label') || button.textContent).trim()) : [];
        const rect = dialog?.getBoundingClientRect();
        return {
          navigation: names.includes('项目中心') && names.includes('设置与引擎'),
          duplicatedProjects: names.some(name => name.startsWith('自动化项目 ')),
          focusInside: Boolean(dialog?.contains(document.activeElement)),
          named: Boolean(document.getElementById(dialog?.getAttribute('aria-labelledby'))?.textContent.trim()),
          contained: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        };
      })()`);
      check(`compact-project-drawer-${scale}x`, drawerTrigger && drawerState.navigation && !drawerState.duplicatedProjects && drawerState.focusInside && drawerState.named && drawerState.contained,
        `One action opens the named navigation/settings drawer, without duplicating the project gallery, inside ${cssWidth}x${cssHeight} CSS viewport emulation.`);
      await evaluate("document.querySelector('#project-drawer button[aria-label=\"关闭项目抽屉\"]').focus(); true");
      await dispatchKey("Tab", 8);
      const reverseTabTrapped = await evaluate("document.querySelector('#project-drawer').contains(document.activeElement) && document.activeElement.textContent.trim() === '设置与引擎'");
      await dispatchKey("Tab");
      const forwardTabTrapped = await evaluate("document.activeElement?.getAttribute('aria-label') === '关闭项目抽屉'");
      check(`compact-drawer-tab-trap-${scale}x`, reverseTabTrapped && forwardTabTrapped,
        "Shift+Tab and Tab wrap inside the compact navigation dialog.");
      await capture(`project-drawer-1024x768-${String(scale).replace('.', '_')}x`);
      await dispatchKey("Escape");
      await waitFor("!document.querySelector('#project-drawer') && document.activeElement?.getAttribute('aria-label') === '打开项目导航'", 2_000,
        "Escape 关闭项目抽屉后未恢复入口焦点。");
      check(`compact-drawer-focus-${scale}x`, true, "Escape closes the drawer and restores its trigger focus.");

      // Full project access moves to Home in the approved desktop layout.
      // Keep the old completeness check there instead of demanding removed UI.
      await clickButton("打开项目导航");
      await waitFor("Boolean(document.querySelector('#project-drawer'))");
      await clickButton("项目中心");
      await waitFor("!document.querySelector('#project-drawer') && Boolean(document.querySelector('button[aria-label=\"自动化项目 B\"]'))");
      const libraryState = await evaluate(`(() => {
        const visible = node => {
          if (!node || !node.getClientRects().length) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1;
        };
        const buttons = [...document.querySelectorAll('main button')];
        return {
          projects: buttons.filter(button => ['自动化项目 A', '自动化项目 B'].includes(button.getAttribute('aria-label'))).length,
          search: visible(document.querySelector('#project-center-search')),
          create: visible(buttons.find(button => button.textContent.trim() === '新建项目')),
          open: visible(buttons.find(button => button.textContent.trim() === '打开项目')),
          sidebarHidden: !document.querySelector('.project-sidebar'),
        };
      })()`);
      check(`compact-project-library-${scale}x`, libraryState.projects === 2 && libraryState.search && libraryState.create && libraryState.open && libraryState.sidebarHidden,
        `The full two-project gallery, search, open and create actions remain visible in the compact project hub: ${JSON.stringify(libraryState)}`);
      await clickButton("自动化项目 A");
      await waitFor("document.querySelector('h1[aria-label=\"自动化项目 A\"]') && document.querySelector('.preview-panel')");
    }

    progress("validating deletion of an unavailable project record");
    await setViewport(1440, 1024, 1);
    await clickButton("项目中心");
    await waitFor("Boolean(document.querySelector('button[aria-label=\"失效项目 Café 🧪\"]'))");
    const openMissingDeletion = async () => {
      await evaluate(`document.querySelector('button[aria-label="失效项目 Café 🧪 项目操作"]').focus(); true`);
      await dispatchKey("ArrowDown");
      await waitFor("Boolean(document.querySelector('[role=menu]'))");
      await evaluate(`(() => {
        [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === '永久删除项目').click();
        return true;
      })()`);
      await waitFor("document.querySelector('#workspace-action-dialog')?.textContent.includes('确认删除项目“失效项目 Café 🧪”的记录吗？')");
    };
    const executionsBeforeCancel = await evaluate("window.__E2E__.state.commandCalls.filter(call => call.command === 'execute_workspace_action').length");
    await openMissingDeletion();
    check("missing-project-record-impact", await evaluate(`(() => {
      const dialog = document.querySelector('#workspace-action-dialog');
      return dialog.textContent.includes('确认删除项目“失效项目 Café 🧪”的记录吗？')
        && !dialog.querySelector('.impact-columns')
        && !dialog.querySelector('.impact-preview')
        && [...dialog.querySelectorAll('button')].map(button => button.textContent.trim()).join(',') === '取消,删除'
        && !dialog.textContent.includes('UI-UNKNOWN-COMMAND');
    })()`), "An unavailable project uses a single record-only confirmation question and cancel/delete buttons.");
    await capture("missing-project-record-deletion-impact");
    await sleep(5200);
    check("deletion-confirmation-does-not-expire", await evaluate("Boolean(document.querySelector('#workspace-action-dialog')) && window.__E2E__.state.removedProjectRecords.length === 0"),
      "Deletion confirmation stays open beyond five seconds and never executes automatically.");
    await clickButton("取消");
    await waitFor("!document.querySelector('#workspace-action-dialog')");
    check("missing-project-record-cancel", await evaluate(`Boolean(document.querySelector('button[aria-label="失效项目 Café 🧪"]'))
      && window.__E2E__.state.removedProjectRecords.length === 0
      && window.__E2E__.state.commandCalls.filter(call => call.command === 'execute_workspace_action').length === ${executionsBeforeCancel}`),
      "Cancelling keeps the unavailable project record and sends no execution request.");
    await openMissingDeletion();
    await clickButton("删除");
    await waitFor("!document.querySelector('#workspace-action-dialog') && !document.querySelector('button[aria-label=\"失效项目 Café 🧪\"]')");
    check("missing-project-record-deleted", await evaluate(`
      window.__E2E__.state.removedProjectRecords.join(',') === 'e2e-project-missing'
      && window.__E2E__.state.projects.length === 2
      && Boolean(document.querySelector('button[aria-label="自动化项目 A"]'))
      && Boolean(document.querySelector('button[aria-label="自动化项目 B"]'))
      && [...document.querySelectorAll('.feedback-notification--success')].some(card => card.textContent.trim() === '项目记录已移除')
    `), "Confirming removes only the requested missing record, retains both other projects and reports that disk files were not deleted.");
    await waitFor("!document.querySelector('.feedback-notification--success')", 6500);
    check("success-notification-five-second-timeout", true, "The short project-record success notification disappears automatically.");
    await clickButton("自动化项目 A");
    await waitFor("Boolean(document.querySelector('.preview-panel'))");

    const axTree = await cdp.send("Accessibility.getFullAXTree");
    const unnamedInteractive = (axTree.nodes ?? []).filter((node) =>
      ["button", "textbox", "searchbox", "combobox"].includes(node.role?.value)
      && !String(node.name?.value ?? "").trim());
    check("accessibility-names", unnamedInteractive.length === 0,
      unnamedInteractive.length === 0 ? "No unnamed primary interactive nodes were found in the current accessibility tree." : `${unnamedInteractive.length} unnamed interactive nodes found.`);

    check("browser-runtime-exceptions", report.browser_exceptions.length === 0,
      report.browser_exceptions.length === 0 ? "No uncaught browser exceptions were observed." : `${report.browser_exceptions.length} browser exceptions were observed.`);
    progress("automation scenarios complete");
  } catch (error) {
    report.status = "FAIL";
    report.failure = {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 1000),
    };
    if (cdp) {
      // This browser/profile is owned by the harness and contains synthetic data only.
      await capture("failure").catch(() => undefined);
      report.failure.context = await evaluate(`({
        headings: [...document.querySelectorAll('h1,h2')].map(node => node.textContent.trim()),
        dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map(node => ({ id: node.id, name: document.getElementById(node.getAttribute('aria-labelledby'))?.textContent.trim() })),
        alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent.trim().slice(0, 300)),
        buttons: [...document.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => (node.getAttribute('aria-label') || node.textContent).trim()).slice(0, 60),
      })`).catch(() => null);
    }
    throw error;
  } finally {
    report.status ??= report.checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
    report.completed_at = new Date().toISOString();
    await writeFile(join(artifactRoot, "ux-automation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    cdp?.close();
    const stopProcess = async (child) => {
      if (!child || child.exitCode !== null) return;
      const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
      child.kill();
      await Promise.race([exited, sleep(2_000)]);
    };
    await stopProcess(edgeProcess);
    await stopProcess(previewProcess);
    if (edgeProfilePath) {
      const resolvedProfile = resolve(edgeProfilePath);
      const profileIsOwned = dirname(resolvedProfile) === resolve(artifactRoot)
        && basename(resolvedProfile).startsWith("edge-profile-");
      if (profileIsOwned) await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return report;
}

try {
  const report = await run();
  const summary = {
    status: report.status,
    passed_checks: report.checks.filter((item) => item.status === "PASS").length,
    total_checks: report.checks.length,
    timings: Object.fromEntries(Object.entries(report.timings).map(([key, value]) => [key, { p95_ms: value.p95_ms, threshold_ms: value.threshold_ms, status: value.status }])),
    report: ".test-results/ux-automation/ux-automation-report.json",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`UX automation failed: ${String(error?.message ?? error)}\n`);
  process.stderr.write("Sanitized report: .test-results/ux-automation/ux-automation-report.json\n");
  process.exitCode = 1;
}
