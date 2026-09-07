import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

const videoPath = process.env.METORIGIN_TEST_VIDEO;
const projectRoot = process.env.METORIGIN_TEST_PROJECT_ROOT;
const reportDirectory = process.env.METORIGIN_NATIVE_REPORT_DIR ?? projectRoot;
const expectedSourceHash = process.env.METORIGIN_EXPECTED_SOURCE_SHA256?.toUpperCase() ?? null;
const debugPort = Number(process.env.METORIGIN_TAURI_DEBUG_PORT ?? "9231");
const pollIntervalMs = 1_000;
const pipelineTimeoutMs = Number(process.env.METORIGIN_PIPELINE_TIMEOUT_MS ?? String(45 * 60 * 1_000));

if (!videoPath || !projectRoot || !reportDirectory) {
  throw new Error("METORIGIN_TEST_VIDEO, METORIGIN_TEST_PROJECT_ROOT, and report directory are required.");
}
if (!existsSync(videoPath)) throw new Error("The configured test video does not exist.");
if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) throw new Error("Invalid debug port.");

const resolvedVideo = resolve(videoPath);
const resolvedProjectRoot = resolve(projectRoot);
if (resolvedProjectRoot === dirname(resolvedVideo) || resolvedVideo.startsWith(`${resolvedProjectRoot}\\`)) {
  throw new Error("The isolated project root must not contain the source video.");
}

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

function isoNow() {
  return new Date().toISOString();
}

function safeStage(snapshot) {
  return snapshot?.state?.current_stage ?? "none";
}

function safeProgress(snapshot) {
  const value = snapshot?.state?.overall_progress;
  return Number.isFinite(value) ? Math.round(value * 1000) / 10 : null;
}

async function main() {
  await mkdir(resolvedProjectRoot, { recursive: true });
  await mkdir(resolve(reportDirectory), { recursive: true });
  const reportPath = resolve(reportDirectory, "native-fast-report.json");
  const report = {
    schema_version: 1,
    generated_at: isoNow(),
    runner: "native Tauri WebView2 + real Tauri IPC + packaged Windows engines",
    source_alias: "primary-video",
    source_policy: "read-only with before/after SHA-256 comparison",
    preset: "fast",
    project_alias: "native-fast-bicycle",
    status: "RUNNING",
    checks: [],
    controls: { pause: null, cancel: null, resume_after_pause: null, resume_after_cancel: null },
    stages: [],
    artifacts: null,
    source_checksum: { before: null, after: null, unchanged: null, matches_expected: null },
    limitations: [
      "The source selector is supplied through real Tauri IPC so the run does not depend on automating a native file picker.",
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
  let projectPath = null;
  try {
    process.stdout.write("[RUN] discovering native Tauri WebView2 target\n");
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find((item) => item.type === "page" && item.title === "MetOrigin Splat" && item.url?.startsWith("http://tauri.localhost"));
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
    const invoke = (command, args = {}, timeoutMs = 30_000) => evaluate(
      `(async () => await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))()`,
      timeoutMs,
    );

    const runtimeReady = await evaluate("document.title === 'MetOrigin Splat' && Boolean(window.__TAURI_INTERNALS__)");
    await check("native-webview-runtime", runtimeReady === true, "Real tauri.localhost UI and Tauri IPC are available.");

    const version = await invoke("app_version");
    await check("native-app-version", typeof version === "string" && version.length > 0, "Native app_version returned a value.");
    const engines = await invoke("check_engines", {}, 120_000);
    // FFprobe is resolved as part of the FFmpeg engine bundle and is verified
    // by the following real analyze_media command rather than a separate card.
    const requiredEngines = ["FFmpeg", "COLMAP", "Brush"];
    const enginesAvailable = requiredEngines.every((required) => engines.some((engine) =>
      String(engine.name).toLowerCase().includes(required.toLowerCase()) && engine.available));
    await check("native-engine-preflight", enginesAvailable, "FFmpeg/FFprobe, COLMAP, and Brush are available through the native command boundary.");

    process.stdout.write("[RUN] hashing source and analyzing media through real FFprobe adapter\n");
    report.source_checksum.before = await sha256(resolvedVideo);
    report.source_checksum.matches_expected = expectedSourceHash == null || report.source_checksum.before === expectedSourceHash;
    await check("source-checksum-baseline", report.source_checksum.matches_expected, "The source matches the approved pre-run checksum.");
    const analysis = await invoke("analyze_media", { path: resolvedVideo }, 120_000);
    const mediaValid = analysis?.valid === true
      && analysis?.video_metadata?.width === 3840
      && analysis?.video_metadata?.height === 2160
      && Math.round(analysis?.video_metadata?.frame_count ?? 0) === 3990;
    await check("native-media-analysis", mediaValid, "Real media analysis confirmed the expected 4K H.264 source profile.");

    const preflight = await invoke("preflight_project", {
      request: { sourcePath: resolvedVideo, projectRoot: resolvedProjectRoot, preset: "fast" },
    }, 120_000);
    await check("native-project-preflight", preflight?.can_continue === true,
      `Preflight passed with ${preflight?.estimated_frames ?? "unknown"} estimated frames.`);

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    process.stdout.write("[RUN] creating isolated native Fast project (source copy may take several seconds)\n");
    const created = await invoke("create_project", {
      request: {
        name: `native-fast-bicycle-${stamp}`,
        sourcePath: resolvedVideo,
        preset: "fast",
        projectRoot: resolvedProjectRoot,
        startAfterCreate: false,
      },
    }, 10 * 60 * 1_000);
    projectPath = created?.path;
    await check("native-project-create", typeof projectPath === "string" && existsSync(projectPath),
      "An isolated .splat-project was created outside the source directory.");

    process.stdout.write("[RUN] starting real Fast pipeline\n");
    const startedAt = Date.now();
    await invoke("start_pipeline", { projectPath }, 120_000);
    let pauseExercised = false;
    let cancelExercised = false;
    let lastKey = "";
    let lastStage = null;
    const deadline = Date.now() + pipelineTimeoutMs;

    while (Date.now() < deadline) {
      const snapshot = await invoke("get_pipeline_state", { projectPath }, 120_000);
      const stage = safeStage(snapshot);
      const progress = safeProgress(snapshot);
      const key = `${snapshot.status}|${stage}|${progress == null ? "unknown" : Math.floor(progress / 5) * 5}`;
      if (key !== lastKey) {
        lastKey = key;
        process.stdout.write(`[PIPELINE] status=${snapshot.status} stage=${stage} progress=${progress ?? "unknown"}%\n`);
      }
      if (stage !== lastStage) {
        report.stages.push({ stage, first_seen_at: isoNow(), status: snapshot.status });
        lastStage = stage;
        await persist();
      }

      if (!pauseExercised && snapshot.status === "running" && stage === "FrameExtraction") {
        process.stdout.write("[CONTROL] requesting pause during FrameExtraction\n");
        const before = Date.now();
        const paused = await invoke("pause_pipeline", {}, 120_000);
        report.controls.pause = { status: paused?.status ?? "unknown", acknowledgement_ms: Date.now() - before };
        pauseExercised = paused?.stopped === true && paused?.status === "paused";
        await check("native-pause", pauseExercised, `Pause acknowledged in ${Date.now() - before}ms.`);
        const resumed = await invoke("resume_pipeline", { projectPath }, 120_000);
        report.controls.resume_after_pause = { status: resumed?.status ?? "unknown" };
        await check("native-resume-after-pause", ["starting", "running", "recovering"].includes(resumed?.status),
          "Pipeline resumed after the acknowledged pause.");
        await sleep(1_000);
        continue;
      }

      if (!cancelExercised && snapshot.status === "running" && stage === "BrushTraining") {
        const checkpoints = await invoke("list_checkpoints", { projectPath }, 120_000);
        if (Array.isArray(checkpoints) && checkpoints.length > 0) {
          process.stdout.write(`[CONTROL] requesting cancel after ${checkpoints.length} real checkpoint(s)\n`);
          const before = Date.now();
          await invoke("cancel_pipeline", {}, 120_000);
          const cancelled = await invoke("get_pipeline_state", { projectPath }, 120_000);
          report.controls.cancel = {
            status: cancelled?.status ?? "unknown",
            acknowledgement_ms: Date.now() - before,
            preserved_checkpoint_count: checkpoints.length,
          };
          cancelExercised = cancelled?.status === "cancelled";
          await check("native-cancel-with-checkpoint", cancelExercised,
            `Cancel acknowledged with ${checkpoints.length} checkpoint(s) preserved.`);
          const resumed = await invoke("resume_pipeline", { projectPath }, 120_000);
          report.controls.resume_after_cancel = { status: resumed?.status ?? "unknown" };
          await check("native-resume-after-cancel", ["starting", "running", "recovering"].includes(resumed?.status),
            "Pipeline resumed from the cancelled checkpoint state.");
          await sleep(1_000);
          continue;
        }
      }

      if (snapshot.status === "completed") {
        report.pipeline_duration_ms = Date.now() - startedAt;
        break;
      }
      if (snapshot.status === "failed") throw new Error("The real pipeline entered a failed state.");
      await sleep(pollIntervalMs);
    }

    const finalSnapshot = await invoke("get_pipeline_state", { projectPath }, 120_000);
    await check("native-pipeline-completed", finalSnapshot?.status === "completed", "The resumed Fast pipeline reached Completed.");
    await check("native-control-coverage", pauseExercised && cancelExercised,
      "Pause, resume, checkpoint-preserving cancel, and resume were all exercised.");

    const artifacts = await invoke("get_project_artifacts", { projectPath }, 120_000);
    const checkpoints = await invoke("list_checkpoints", { projectPath }, 120_000);
    const outputValid = artifacts?.scene_ply?.exists === true
      && artifacts?.scene_ply?.validated === true
      && artifacts?.output_manifest?.exists === true
      && Array.isArray(checkpoints)
      && checkpoints.length > 0;
    report.artifacts = {
      scene_ply_exists: artifacts?.scene_ply?.exists === true,
      scene_ply_validated: artifacts?.scene_ply?.validated === true,
      output_manifest_exists: artifacts?.output_manifest?.exists === true,
      registered_images: artifacts?.registered_images ?? null,
      total_images: artifacts?.total_images ?? null,
      splat_count: artifacts?.splat_count ?? null,
      checkpoint_count: Array.isArray(checkpoints) ? checkpoints.length : 0,
    };
    await check("native-output-artifacts", outputValid, "Scene PLY, output manifest, and checkpoints are present and validated.");

    const ply = await invoke("inspect_ply", { projectPath, relativePath: "output/scene.ply" }, 120_000);
    await check("native-ply-preview", ply?.vertex_count > 0 && ply?.gaussian_compatible === true,
      `The real output PLY is Gaussian-compatible with ${ply?.vertex_count ?? 0} vertices.`);

    process.stdout.write("[RUN] re-hashing source after all project and pipeline mutations\n");
    report.source_checksum.after = await sha256(resolvedVideo);
    report.source_checksum.unchanged = report.source_checksum.before === report.source_checksum.after;
    await check("source-checksum-unchanged", report.source_checksum.unchanged,
      "The source video SHA-256 is unchanged after the complete native run.");

    report.status = "PASS";
    report.completed_at = isoNow();
    await persist();
    process.stdout.write(`[PASS] native Fast validation completed; report=${basename(reportPath)}\n`);
  } catch (error) {
    report.status = "FAIL";
    report.completed_at = isoNow();
    report.failure = { message: String(error?.message ?? error).replaceAll(resolvedVideo, "<SOURCE>").replaceAll(resolvedProjectRoot, "<PROJECT_ROOT>").slice(0, 500) };
    await persist();
    throw error;
  } finally {
    cdp?.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Native validation failed: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
}
