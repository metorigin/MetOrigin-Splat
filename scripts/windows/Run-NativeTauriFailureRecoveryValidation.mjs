import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

const projectPath = process.env.METORIGIN_TEST_PROJECT_PATH;
const videoPath = process.env.METORIGIN_TEST_VIDEO;
const reportDirectory = process.env.METORIGIN_NATIVE_REPORT_DIR;
const expectedSourceHash = process.env.METORIGIN_EXPECTED_SOURCE_SHA256?.toUpperCase() ?? null;
const debugPort = Number(process.env.METORIGIN_TAURI_DEBUG_PORT ?? "9231");
const pollIntervalMs = 100;
const failureTimeoutMs = Number(process.env.METORIGIN_FAILURE_TIMEOUT_MS ?? String(2 * 60 * 1_000));
const recoveryTimeoutMs = Number(process.env.METORIGIN_RECOVERY_TIMEOUT_MS ?? String(10 * 60 * 1_000));

if (!projectPath || !videoPath || !reportDirectory) {
  throw new Error("METORIGIN_TEST_PROJECT_PATH, METORIGIN_TEST_VIDEO, and report directory are required.");
}
if (!existsSync(projectPath) || !existsSync(videoPath)) {
  throw new Error("The configured test project or source video does not exist.");
}
if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
  throw new Error("Invalid debug port.");
}

const resolvedProject = resolve(projectPath);
const resolvedVideo = resolve(videoPath);
const resolvedReportDirectory = resolve(reportDirectory);

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("CDP connection timed out.")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new Error("CDP connection failed."));
      }, { once: true });
    });
    this.socket.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data);
      const message = JSON.parse(raw);
      if (!message.id) return;
      const resolver = this.pending.get(message.id);
      if (!resolver) return;
      this.pending.delete(message.id);
      if (message.error) resolver.reject(new Error(message.error.message));
      else resolver.resolve(message.result ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const resolver of this.pending.values()) resolver.reject(new Error("CDP connection closed."));
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); rejectPromise(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket.close();
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex").toUpperCase();
}

function listBrushPids() {
  const output = execFileSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq brush_app.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^"brush_app\.exe",/i.test(line))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function stageError(snapshot, stageId) {
  return snapshot?.state?.stages?.[stageId]?.error ?? null;
}

function legacyErrorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  if (typeof error !== "string") return null;
  return error.match(/^\[([^\]]+)\]/)?.[1] ?? error.match(/错误代码[：:]\s*([^）)\s]+)/u)?.[1] ?? null;
}

function sanitize(message) {
  return String(message)
    .replaceAll(resolvedProject, "<PROJECT>")
    .replaceAll(resolvedVideo, "<SOURCE>")
    .replaceAll(resolvedReportDirectory, "<REPORT_DIR>")
    .slice(0, 500);
}

async function main() {
  await mkdir(resolvedReportDirectory, { recursive: true });
  const reportPath = resolve(resolvedReportDirectory, "native-failure-recovery-report.json");
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runner: "native Tauri + controlled Brush process termination",
    project_alias: "native-fast-bicycle",
    source_alias: "primary-video",
    source_policy: "read-only with before/after SHA-256 comparison",
    status: "RUNNING",
    checks: [],
    failure_observation: null,
    recovery: null,
    source_checksum: { before: null, after: null, unchanged: null, matches_expected: null },
    limitations: [
      "The process fault is injected only into the uniquely identified Brush process created by this test run.",
      "Windows sleep/resume and independent human usability judgment are outside this automated run.",
    ],
  };
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const check = async (name, passed, detail) => {
    report.checks.push({ name, status: passed ? "PASS" : "FAIL", detail });
    await persist();
    process.stdout.write(`[${passed ? "PASS" : "FAIL"}] ${name}: ${detail}\n`);
    if (!passed) throw new Error(`${name} failed`);
  };

  let cdp = null;
  let invoke = null;
  let openedProject = null;
  let injectedPid = null;
  try {
    process.stdout.write("[RUN] discovering native Tauri WebView2 target\n");
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find((item) => item.type === "page"
      && item.title === "MetOrigin Splat"
      && item.url?.startsWith("http://tauri.localhost"));
    if (!target?.webSocketDebuggerUrl) throw new Error("Native MetOrigin WebView2 target not found.");
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    const evaluate = async (expression, timeoutMs = 30_000) => {
      const response = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, timeoutMs);
      if (response.exceptionDetails) throw new Error("Native WebView command failed.");
      return response.result?.value;
    };
    invoke = (command, args = {}, timeoutMs = 30_000) => evaluate(
      `(async () => await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))()`,
      timeoutMs,
    );

    await check(
      "native-webview-runtime",
      await evaluate("document.title === 'MetOrigin Splat' && Boolean(window.__TAURI_INTERNALS__)") === true,
      "Real tauri.localhost UI and Tauri IPC are available.",
    );
    const baselinePids = listBrushPids();
    await check(
      "brush-process-baseline",
      baselinePids.length === 0,
      "No pre-existing Brush process can be confused with the injected test target.",
    );

    report.source_checksum.before = await sha256(resolvedVideo);
    report.source_checksum.matches_expected = expectedSourceHash == null
      || report.source_checksum.before === expectedSourceHash;
    await check(
      "source-checksum-baseline",
      report.source_checksum.matches_expected,
      "The source matches the approved pre-run checksum.",
    );

    openedProject = await invoke("open_project", { path: resolvedProject }, 120_000);
    await check(
      "completed-project-baseline",
      openedProject?.status === "completed" && openedProject?.current_stage == null,
      "The isolated baseline project is complete before fault injection.",
    );
    const checkpoints = await invoke("list_checkpoints", { projectPath: resolvedProject }, 120_000);
    const validCheckpoints = Array.isArray(checkpoints)
      ? checkpoints.filter((checkpoint) => checkpoint.valid).sort((left, right) => left.iteration - right.iteration)
      : [];
    await check(
      "checkpoint-baseline",
      validCheckpoints.length >= 2,
      `The baseline contains ${validCheckpoints.length} valid checkpoints for controlled recovery.`,
    );

    const restoreIteration = validCheckpoints[0].iteration;
    const restored = await invoke(
      "restore_checkpoint",
      { projectPath: resolvedProject, iteration: restoreIteration },
      120_000,
    );
    await check(
      "checkpoint-restore",
      Array.isArray(restored)
        && restored.some((checkpoint) => checkpoint.iteration === restoreIteration && checkpoint.current),
      `The project was safely restored to checkpoint iteration ${restoreIteration}.`,
    );

    process.stdout.write("[RUN] starting Brush recovery and waiting for its unique process\n");
    await invoke("start_pipeline", { projectPath: resolvedProject }, 120_000);
    const processDeadline = Date.now() + failureTimeoutMs;
    while (Date.now() < processDeadline) {
      const snapshot = await invoke("get_pipeline_state", { projectPath: resolvedProject }, 30_000);
      const brushPids = listBrushPids().filter((pid) => !baselinePids.includes(pid));
      if (brushPids.length > 1) throw new Error("More than one new Brush process appeared; refusing unsafe termination.");
      if (snapshot?.status === "running"
        && snapshot?.state?.current_stage === "BrushTraining"
        && brushPids.length === 1) {
        injectedPid = brushPids[0];
        process.kill(injectedPid);
        process.stdout.write("[FAULT] terminated the uniquely identified Brush test process\n");
        break;
      }
      if (snapshot?.status === "failed" || snapshot?.status === "completed") {
        throw new Error("Pipeline reached a terminal state before the Brush fault could be injected.");
      }
      await sleep(pollIntervalMs);
    }
    await check(
      "brush-process-termination",
      injectedPid != null,
      "The uniquely identified Brush process was terminated during active training.",
    );

    let failedSnapshot = null;
    const failedDeadline = Date.now() + failureTimeoutMs;
    while (Date.now() < failedDeadline) {
      const snapshot = await invoke("get_pipeline_state", { projectPath: resolvedProject }, 30_000);
      if (snapshot?.status === "failed") {
        failedSnapshot = snapshot;
        break;
      }
      if (snapshot?.status === "completed") throw new Error("The injected process failure was incorrectly reported as success.");
      await sleep(250);
    }
    const error = stageError(failedSnapshot, "BrushTraining");
    const errorCode = legacyErrorCode(error);
    const userFacingErrorLocalized = typeof error === "string"
      && /[\u3400-\u9fff]/u.test(error)
      && !error.includes("Brush returned an error");
    const retryActionAvailable = failedSnapshot?.state?.stages?.BrushTraining?.status === "failed"
      && errorCode === "E-4003";
    report.failure_observation = {
      project_status: failedSnapshot?.status ?? null,
      stage_status: failedSnapshot?.state?.stages?.BrushTraining?.status ?? null,
      error_code: errorCode,
      user_facing_error_localized: userFacingErrorLocalized,
      retry_action_available: retryActionAvailable,
    };
    await check(
      "native-failure-state",
      failedSnapshot?.status === "failed"
        && failedSnapshot?.state?.stages?.BrushTraining?.status === "failed"
        && errorCode === "E-4003"
        && userFacingErrorLocalized
        && retryActionAvailable,
      "Brush termination produced a localized E-4003 stage failure with a recovery action instead of a false success.",
    );

    let active = await invoke("get_active_pipeline_summary", {}, 30_000);
    const activeDeadline = Date.now() + 30_000;
    while (active != null && Date.now() < activeDeadline) {
      await sleep(250);
      active = await invoke("get_active_pipeline_summary", {}, 30_000);
    }
    await check(
      "failed-active-task-cleanup",
      active == null,
      "The failed process no longer occupies the global active-pipeline slot.",
    );
    const preserved = await invoke("list_checkpoints", { projectPath: resolvedProject }, 120_000);
    await check(
      "failure-checkpoint-preserved",
      Array.isArray(preserved)
        && preserved.some((checkpoint) => checkpoint.iteration === restoreIteration && checkpoint.valid),
      "The selected recovery checkpoint remained valid after external process failure.",
    );

    process.stdout.write("[RUN] retrying Brush from the preserved checkpoint\n");
    await invoke(
      "retry_stage",
      { projectPath: resolvedProject, stageId: "BrushTraining" },
      120_000,
    );
    await invoke("start_pipeline", { projectPath: resolvedProject }, 120_000);
    const recoveryStartedAt = Date.now();
    let finalSnapshot = null;
    const recoveryDeadline = recoveryStartedAt + recoveryTimeoutMs;
    while (Date.now() < recoveryDeadline) {
      const snapshot = await invoke("get_pipeline_state", { projectPath: resolvedProject }, 30_000);
      if (snapshot?.status === "completed") {
        finalSnapshot = snapshot;
        break;
      }
      if (snapshot?.status === "failed") throw new Error("Checkpoint recovery failed after the injected process fault.");
      await sleep(500);
    }
    report.recovery = {
      duration_ms: Date.now() - recoveryStartedAt,
      status: finalSnapshot?.status ?? null,
      progress: finalSnapshot?.state?.overall_progress ?? null,
    };
    await check(
      "native-checkpoint-recovery",
      finalSnapshot?.status === "completed" && finalSnapshot?.state?.overall_progress === 1,
      "Retry from the preserved checkpoint returned the pipeline to Completed at 100%.",
    );

    const artifacts = await invoke("get_project_artifacts", { projectPath: resolvedProject }, 120_000);
    const finalCheckpoints = await invoke("list_checkpoints", { projectPath: resolvedProject }, 120_000);
    const ply = await invoke(
      "inspect_ply",
      { projectPath: resolvedProject, relativePath: "output/scene.ply" },
      120_000,
    );
    await check(
      "recovered-artifacts",
      artifacts?.scene_ply?.exists === true
        && artifacts?.scene_ply?.validated === true
        && artifacts?.output_manifest?.exists === true
        && Array.isArray(finalCheckpoints)
        && finalCheckpoints.length > 0
        && ply?.gaussian_compatible === true
        && Number(ply?.vertex_count) > 0,
      `Recovered artifacts are valid with ${finalCheckpoints?.length ?? 0} checkpoints and ${ply?.vertex_count ?? 0} PLY vertices.`,
    );

    report.source_checksum.after = await sha256(resolvedVideo);
    report.source_checksum.unchanged = report.source_checksum.before === report.source_checksum.after;
    await check(
      "source-checksum-unchanged",
      report.source_checksum.unchanged,
      "The source video SHA-256 is unchanged after fault injection and recovery.",
    );

    await invoke(
      "remove_recent_project",
      { projectId: openedProject.id, projectPath: resolvedProject },
      30_000,
    );
    const recent = await invoke("list_recent_project_index", {}, 30_000);
    await check(
      "test-recent-entry-cleanup",
      Array.isArray(recent)
        && !recent.some((item) => item.id === openedProject.id && item.path === resolvedProject),
      "The isolated test project was removed from the recent-project index without deleting its files.",
    );

    report.status = "PASS";
    report.completed_at = new Date().toISOString();
    await persist();
    process.stdout.write("[PASS] native external-process failure recovery validation completed\n");
  } catch (error) {
    report.status = "FAIL";
    report.completed_at = new Date().toISOString();
    report.failure = { message: sanitize(error?.message ?? error) };
    await persist();
    throw error;
  } finally {
    if (invoke && openedProject) {
      try {
        const active = await invoke("get_active_pipeline_summary", {}, 30_000);
        if (active?.project_id === openedProject.id) await invoke("cancel_pipeline", {}, 120_000);
        await invoke(
          "remove_recent_project",
          { projectId: openedProject.id, projectPath: resolvedProject },
          30_000,
        );
      } catch {
        // Best-effort cleanup must not mask the recorded validation result.
      }
    }
    cdp?.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Native failure recovery validation failed: ${sanitize(error?.message ?? error)}\n`);
  process.exitCode = 1;
}
