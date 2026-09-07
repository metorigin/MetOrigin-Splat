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
const edgeCandidates = [
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
    browserProcess.on("exit", (code) => this.rejectAll(new AutomationError(`Edge CDP process exited: code=${code ?? "unknown"}`)));
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

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
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
  throw new AutomationError("未找到 Microsoft Edge。请安装 Edge 后重试自动化验收。");
}

function mockTauriBootstrap() {
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
  const makeSnapshot = (project, stage, status = project.status, sequence = 1, progress = 0.42) => ({
    project_id: project.id,
    project_path: project.path,
    status,
    state: { stages: {}, current_stage: stage, overall_progress: progress },
    sequence,
    accepted_at: now(),
    started_at: "2026-08-14T08:00:01Z",
    control_intent: "none",
  });
  const state = {
    projects: [projectA, projectB],
    activeSnapshot: makeSnapshot(projectA, "BrushTraining", "running", 12, 0.42),
    snapshots: {
      [projectA.id]: makeSnapshot(projectA, "BrushTraining", "running", 12, 0.42),
      [projectB.id]: makeSnapshot(projectB, null, "ready", 0, 0),
    },
    eventListeners: new Map(),
    callbacks: new Map(),
    callbackSequence: 1,
    previewSequence: 1,
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
          availability: "available",
          checked_at: now(),
          reason_code: null,
          refreshed_project: project ?? null,
        };
      }
      case "get_app_settings": return null;
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
        latest_checkpoint: null,
        scene_ply: artifact("output/scene.ply", false),
        output_manifest: artifact("output/manifest.json", false),
        registered_images: 80,
        total_images: 100,
        sparse_points: 12345,
        mean_reprojection_error: 0.51,
        colmap_validation: null,
        colmap_attempts: [],
        splat_count: null,
      };
      case "list_checkpoints": return [];
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
      case "execute_workspace_action": return {
        kind: "completed",
        receipt: {
          id: "e2e-receipt",
          action: "pause",
          status: "success",
          title: "合成操作已完成",
          message: "没有修改真实数据。",
          completedAt: now(),
          affectedResources: [],
          dismissible: true,
        },
      };
      case "open_project_location": return {
        opened: true,
        missing: false,
        target_type: args.request?.targetType ?? "project_root",
        message: null,
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
    setStage(stageId) {
      const nextSequence = state.activeSnapshot.sequence + 1;
      const progress = stageId === "ModelValidation" ? 0.82 : 0.52;
      const snapshot = makeSnapshot(projectA, stageId, "running", nextSequence, progress);
      state.activeSnapshot = snapshot;
      state.snapshots[projectA.id] = snapshot;
      projectA.stage_label = stageId;
      emit("pipeline://event", {
        project_id: projectA.id,
        sequence: nextSequence,
        timestamp: now(),
        event: { kind: "stage_started", stage_id: stageId },
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
    runner: "Microsoft Edge headless + Chrome DevTools Protocol",
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
      if (await evaluate(expression)) return;
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
  const dispatchKey = async (key) => {
    const keyCode = { ArrowDown: 40, ArrowRight: 39, Escape: 27, Home: 36, End: 35 }[key] ?? 0;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };

  try {
    progress("locating Edge and building frontend");
    const edgeExecutable = await findExecutable(edgeCandidates);
    const build = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm.CMD build"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    check("production-build", build.status === 0, build.status === 0 ? "Vite production build completed." : "Vite production build failed.");

    progress("starting preview server and Edge CDP session");
    const viteEntry = join(repositoryRoot, "apps", "desktop", "node_modules", "vite", "bin", "vite.js");
    previewProcess = spawn(process.execPath, [
      viteEntry,
      "preview",
      "--host", "127.0.0.1",
      "--port", String(previewPort),
    ], { cwd: join(repositoryRoot, "apps", "desktop"), stdio: "ignore", windowsHide: true });
    previewProcess.unref();
    await waitForHttp(appUrl);

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
    ], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
    cdp = new CdpClient(edgeProcess);
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

    await clickButton("自动化项目 B");
    await waitFor("[...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === '自动化项目 B')", 10_000, "未进入项目 B。");
    await waitFor("Boolean(document.querySelector('.run-actions button[aria-disabled=\"true\"][aria-describedby]'))", 10_000, "项目 B 未阻止与活动项目冲突的启动操作。");
    const conflictState = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('开始重建'));
      return button ? { focusable: !button.disabled, ariaDisabled: button.getAttribute('aria-disabled'), described: Boolean(document.getElementById(button.getAttribute('aria-describedby'))?.textContent?.trim()) } : null;
    })()`);
    check("active-project-conflict", conflictState?.focusable && conflictState.ariaDisabled === "true" && conflictState.described,
      "Project B remains navigable while its start action is focusable, described, and blocked by active project A.");
    await evaluate(`(() => {
      const button = document.querySelector('.run-actions button[aria-disabled="true"]');
      button.focus();
      button.click();
    })()`);
    await waitFor("document.querySelector('.run-conflict-feedback[role=alert]')?.textContent?.includes('当前有重建任务尚未结束')", 2_000, "受阻的启动操作未显示原因。");
    const blockedAttempt = await evaluate(`({
      focusRetained: document.activeElement?.getAttribute('aria-disabled') === 'true',
      started: window.__E2E__.state.commandCalls.some((call) => call.command === 'start_pipeline'),
    })`);
    check("active-project-blocked-attempt", blockedAttempt.focusRetained && !blockedAttempt.started,
      "Attempting the blocked start explains the conflict, retains focus, and never invokes start_pipeline.");
    await clickButton("自动化项目 A");
    await waitFor("[...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === '自动化项目 A')", 10_000, "未返回活动项目 A。");
    await waitFor("Boolean(document.querySelector('.preview-panel'))", 10_000, "项目工作区未完成加载。");

    const workspaceLayout = await evaluate(`(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
      };
      return {
        content: rect('.workspace-content'),
        grid: rect('.project-workspace-grid'),
        feedback: rect('.project-resource-feedback'),
        timeline: rect('.timeline-panel'),
        inspector: rect('.inspector-column'),
        preview: rect('.preview-panel'),
        monitor: rect('.workspace-inspector-stack'),
      };
    })()`);
    const workspaceLayoutValid = Boolean(
      workspaceLayout.content
      && workspaceLayout.grid
      && workspaceLayout.feedback
      && workspaceLayout.timeline
      && workspaceLayout.inspector
      && workspaceLayout.preview
      && workspaceLayout.monitor
      && (workspaceLayout.feedback.height === 0 || workspaceLayout.feedback.bottom <= workspaceLayout.timeline.top + 1)
      && workspaceLayout.timeline.height > 0
      && workspaceLayout.timeline.bottom <= workspaceLayout.inspector.top + 1
      && Math.abs(workspaceLayout.preview.top - workspaceLayout.monitor.top) <= 1
      && workspaceLayout.preview.right <= workspaceLayout.monitor.left + 1
      && workspaceLayout.preview.height >= 288
      && workspaceLayout.inspector.bottom <= workspaceLayout.content.bottom + 1
    );
    check("project-workspace-grid-placement", workspaceLayoutValid,
      workspaceLayoutValid
        ? "Stage milestones sit above the side-by-side preview and monitoring panels within the visible workspace."
        : `Workspace children escaped their intended tracks: ${JSON.stringify(workspaceLayout)}`);
    await capture("project-workspace-layout-1440x1024-100pct");

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

    progress("collecting SC-009 pipeline-update timing samples");
    await evaluate("window.__E2E__.setStage('BrushTraining'); true");
    await waitFor("[...document.querySelectorAll('.run-time-copy strong')][1]?.textContent?.includes('Brush 训练')", 3_000,
      "Pipeline 状态传播预热失败。");
    const pipelineSamples = [];
    for (let index = 0; index < 20; index += 1) {
      const stage = index % 2 === 0 ? "ModelValidation" : "BrushTraining";
      const label = stage === "ModelValidation" ? "模型校验" : "Brush 训练";
      await evaluate(`window.__E2E_TIMING_START__ = performance.now(); window.__E2E__.setStage(${JSON.stringify(stage)}); true`);
      await waitFor(`(() => {
        const values = [...document.querySelectorAll('.run-time-copy strong')];
        return values[1]?.textContent?.includes(${JSON.stringify(label)});
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

    progress("collecting SC-010 thousand-event search timing samples");
    await clickButton("查看日志与活动");
    await waitFor("Boolean(document.querySelector('input[aria-label=\"搜索活动记录\"]'))", 10_000, "活动搜索框未出现。");
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="搜索活动记录"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'SyntheticTarget-0840');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor("[...document.querySelectorAll('.activity-event-row')].some((item) => item.textContent?.includes('SyntheticTarget-0840'))", 3_000,
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
      await waitFor(`[...document.querySelectorAll('.activity-event-row')].some((item) => item.textContent?.includes(${JSON.stringify(targetText)}))`, 3_000, "千条活动记录搜索未及时返回目标项。");
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
      const trigger = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '操作');
      trigger.focus();
      return document.activeElement === trigger;
    })()`);
    await dispatchKey("ArrowDown");
    await waitFor("document.activeElement?.getAttribute('role') === 'menuitem'", 2_000, "操作菜单未按方向键打开并聚焦菜单项。");
    await dispatchKey("Escape");
    await waitFor("!document.querySelector('[role=menu]') && document.activeElement?.textContent?.trim() === '操作'", 2_000,
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
    check("keyboard-tabs-contract", true, "Right Arrow activates the next tab using a single roving tab stop.");

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
      await waitFor("Boolean(document.querySelector('button[aria-label=\"打开全部项目\"]'))", 3_000, "窄窗项目入口未出现。");
      const drawerTrigger = await evaluate(`(() => {
        const button = document.querySelector('button[aria-label="打开全部项目"]');
        button.focus();
        button.click();
        return Boolean(button);
      })()`);
      await waitFor("Boolean(document.querySelector('[role=dialog] h2')) && document.body.innerText.includes('全部项目')", 3_000, "完整项目抽屉未通过一次操作打开。");
      const drawerState = await evaluate(`(() => {
        const dialog = document.querySelector('[role=dialog]');
        return {
          projects: dialog ? [...dialog.querySelectorAll('button')].filter((item) => item.getAttribute('aria-label')?.startsWith('自动化项目 ')).length : 0,
          focusInside: Boolean(dialog?.contains(document.activeElement)),
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        };
      })()`);
      check(`compact-project-drawer-${scale}x`, drawerTrigger && drawerState.projects >= 2 && drawerState.focusInside,
        `One action opens the complete project drawer at conservative ${cssWidth}x${cssHeight} CSS viewport emulation.`);
      await capture(`project-drawer-1024x768-${String(scale).replace('.', '_')}x`);
      await dispatchKey("Escape");
      await waitFor("!document.querySelector('[role=dialog]') && document.activeElement?.getAttribute('aria-label') === '打开全部项目'", 2_000,
        "Escape 关闭项目抽屉后未恢复入口焦点。");
      check(`compact-drawer-focus-${scale}x`, true, "Escape closes the drawer and restores its trigger focus.");
    }

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
