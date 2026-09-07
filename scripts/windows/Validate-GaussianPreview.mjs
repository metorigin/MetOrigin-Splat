import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { connectPreviewTest } from "./PreviewTestCdp.mjs";

const original = process.argv[2];
if (!original) throw new Error("Usage: node scripts/windows/Validate-GaussianPreview.mjs <completed-project-path>");
const output = resolve(".test-results/gaussian-live", `run-${Date.now()}`);
const projectPath = join(output, "preview.splat-project");
await mkdir(join(projectPath, "output"), { recursive: true });
const project = JSON.parse(await readFile(join(original, "project.json"), "utf8"));
project.id = randomUUID();
await writeFile(join(projectPath, "project.json"), JSON.stringify(project));
await copyFile(join(original, "output/scene.ply"), join(projectPath, "output/scene.ply"));
await mkdir(join(projectPath, "training/dataset/sparse/0"), { recursive: true });
for (const name of ["images.bin", "cameras.bin"]) {
  await copyFile(join(original, "training/dataset/sparse/0", name), join(projectPath, "training/dataset/sparse/0", name));
}
const cdp = await connectPreviewTest(Number(process.env.METORIGIN_TAURI_DEBUG_PORT ?? 9246));
const checks = [];
const check = (name, passed, evidence) => {
  checks.push({ name, passed, evidence });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}`);
  if (!passed) throw new Error(name);
};
const waitFor = async (predicate, timeout = 60000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error("Timed out waiting for preview");
};
const invoke = (command, args) => cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
let engine;
let engineLog;
try {
  const source = await invoke("get_gaussian_preview", { projectId: project.id, projectPath });
  const binary = await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke("read_gaussian_ply", ${JSON.stringify({ projectId: project.id, projectPath, relativePath: source.relative_path, expectedRevision: source.revision })}).then(bytes => ({binary: bytes instanceof ArrayBuffer, size: bytes.byteLength, header: new TextDecoder().decode(bytes.slice(0,600))}))`);
  check("full-binary-tauri-transfer", binary.binary && binary.size === source.size_bytes && binary.header.includes("scale_0") && binary.header.includes("rot_0"), { ...source, binary: binary.binary, transferred: binary.size });
  const props = { projectId: project.id, projectPath, relativePath: "output/scene.ply", live: false, running: false };
  await cdp.evaluate(`(async () => {
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default ?? ReactModule;
    const ClientModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = ClientModule.default ?? ClientModule;
    const { GaussianSplatPreview } = await import('/src/components/workspace/GaussianSplatPreview.tsx');
    const host = document.createElement('div'); host.id = 'preview-validation'; host.style = 'position:fixed;inset:12px;z-index:99999;background:#11161c;border-radius:16px;overflow:hidden';
    document.body.appendChild(host);
    window.__previewValidation = { root: createRoot(host), component: GaussianSplatPreview, create: React.createElement };
    const test = window.__previewValidation; test.root.render(test.create(test.component, ${JSON.stringify(props)}));
  })()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#preview-validation .gaussian-updated')?.textContent`));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const staticState = await cdp.evaluate(`({text:document.querySelector('#preview-validation').innerText, canvas:!!document.querySelector('#preview-validation canvas'), error:document.querySelector('#preview-validation [role=alert]')?.textContent})`);
  check("native-gaussian-render", staticState.canvas && !staticState.error && staticState.text.includes(source.vertex_count.toLocaleString()), staticState);
  await cdp.screenshot(join(output, "gaussian-static.png"));

  const sessionId = randomUUID();
  const liveRoot = join(projectPath, "training/live-preview");
  const liveDir = join(liveRoot, sessionId);
  await mkdir(liveDir, { recursive: true });
  await writeFile(join(liveRoot, "session.json"), JSON.stringify({ protocol: 1, session_id: sessionId, available: true, running: true }));
  const liveProps = { ...props, relativePath: null, live: true, running: true };
  await cdp.evaluate(`window.__previewValidation.root.render(window.__previewValidation.create(window.__previewValidation.component, ${JSON.stringify(liveProps)}))`);
  const binaryPath = resolve(".engines/brush-v0.3.0-windows-x64/brush_live.exe");
  const args = [join(original, "training/dataset"), "--total-steps", "3000", "--max-frames", "16", "--max-resolution", "512", "--subsample-points", "4", "--sh-degree", "1", "--export-every", "3000", "--export-path", join(output, "checkpoints"), "--export-name", "checkpoint_{iter}.ply", "--eval-every", "3000"];
  engine = spawn(binaryPath, args, { windowsHide: true, cwd: output, env: { ...process.env, METORIGIN_BRUSH_LIVE_DIR: liveDir, METORIGIN_BRUSH_LIVE_SESSION: sessionId, RUST_LOG: "brush_cli=info,brush_process=info" } });
  console.log(`Brush PID ${engine.pid}, evidence ${output}`);
  engineLog = createWriteStream(join(output, "brush.log"));
  engine.stdout.pipe(engineLog, { end: false });
  engine.stderr.pipe(engineLog, { end: false });
  const done = new Promise((resolve, reject) => { engine.once("error", reject); engine.once("exit", (code) => resolve(code)); });
  const revisions = [];
  const started = Date.now();
  let pausedChecked = false;
  while (Date.now() - started < 180000 && engine.exitCode === null) {
    const state = await cdp.evaluate(`({iteration:document.querySelector('#preview-validation .gaussian-iteration')?.textContent,text:document.querySelector('#preview-validation').innerText,error:document.querySelector('#preview-validation [role=alert]')?.textContent})`);
    if (state.iteration && !revisions.includes(state.iteration)) {
      revisions.push(state.iteration);
      console.log(`LIVE ${state.iteration}`);
      if (revisions.length === 2 && !pausedChecked) {
        await cdp.screenshot(join(output, "gaussian-live.png"));
        await cdp.evaluate(`(() => {const s=document.querySelector('#preview-validation select'); s.value='off';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(() => cdp.evaluate(`document.querySelector('#preview-validation').innerText.includes('预览已暂停')`));
        const before = JSON.parse(await readFile(join(liveDir, "latest.json"), "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const after = JSON.parse(await readFile(join(liveDir, "latest.json"), "utf8"));
        check("preview-pause-leaves-training-alive", engine.exitCode === null && after.revision <= before.revision + 1, { before: before.revision, after: after.revision, engineAlive: engine.exitCode === null });
        await cdp.evaluate(`(() => {const s=document.querySelector('#preview-validation select'); s.value='live';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        pausedChecked = true;
      }
    }
    if (state.error) throw new Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (engine.exitCode === null) throw new Error("Short Brush training timed out");
  const exitCode = await done;
  check("live-frames-before-final-checkpoint", revisions.length >= 3 && revisions.some((value) => parseInt(value.replaceAll(",", "")) < 3000), revisions);
  check("training-completes", exitCode === 0, { exitCode, previews: revisions.length });
  check("bounded-preview-cache", (await readdir(liveDir)).filter((name) => name.endsWith(".ply")).length <= 2, await readdir(liveDir));
  check("no-renderer-exceptions", cdp.errors.length === 0, cdp.errors);
} finally {
  if (engine && engine.exitCode === null) engine.kill();
  engineLog?.end();
  await cdp.evaluate("window.__previewValidation?.root.unmount();document.getElementById('preview-validation')?.remove()").catch(() => {});
  cdp.close();
  await writeFile(join(output, "report.json"), JSON.stringify({ output, checks, errors: cdp.errors }, null, 2));
  console.log(`Report: ${output}`);
}
