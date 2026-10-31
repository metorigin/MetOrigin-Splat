import { Button } from "@/components/ui/button";
import { Notification } from "@/components/feedback";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { localizeMessage, t, getLocale } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ArrowsOut, ArrowClockwise, Eye, GridFour, SpinnerGap } from "../primitives/icons";
import { desktopApi } from "../../services/desktop";
import type { GaussianCamera, GaussianPreviewSource, LivePreviewMode, PreviewResourcePolicy } from "../../types";
import { canUseCaptureCamera, getCaptureOrientation, sampleFramingBounds } from "./gaussianFraming";

interface Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  spark: SparkRenderer;
  mesh: SplatMesh | null;
  grid: THREE.GridHelper;
  sourceKey: string | null;
  initialCamera: GaussianCamera | null;
  fit: (overview?: boolean) => void;
}

interface Props {
  projectId: string;
  projectPath: string;
  relativePath: string | null;
  live: boolean;
  running: boolean;
  showToolbar?: boolean;
}

export function GaussianSplatPreview({ projectId, projectPath, relativePath, live, running, showToolbar = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [gridVisible, setGridVisible] = useState(false);
  const [mode, setMode] = useState<LivePreviewMode>("live");
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayed, setDisplayed] = useState<GaussianPreviewSource | null>(null);
  const [liveAvailable, setLiveAvailable] = useState<boolean | null>(null);
  const [liveSessionKnown, setLiveSessionKnown] = useState(false);
  const [liveStreamRunning, setLiveStreamRunning] = useState(false);
  const [hasCurrentLiveFrame, setHasCurrentLiveFrame] = useState(false);
  const [resourceReason, setResourceReason] = useState<string | null>(null);
  const [resourceAction, setResourceAction] = useState<"allow" | "pause" | "release">("allow");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const liveFallbackPath = useRef(relativePath);
  const staticRelativePath = live ? null : relativePath;

  useEffect(() => {
    // New checkpoints change the live stream's fallback, not its session or ACK.
    liveFallbackPath.current = relativePath;
  }, [relativePath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer | null = null;
    let spark: SparkRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x11161c, 1);
      // Brush sorts projected splats by depth. Keep full SH and full model resolution.
      spark = new SparkRenderer({ renderer, sortRadial: false, enableLod: false, accumExtSplats: true, maxStdDev: 3, preBlurAmount: 0.3, blurAmount: 0 });
    } catch (cause) {
      renderer?.dispose();
      setError(t("无法启动高斯渲染：{0}", String(cause)));
      setLoading(false);
      return;
    }
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(spark);
    const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 10000);
    let controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const grid = new THREE.GridHelper(1, 20, 0x34404d, 0x232b34);
    grid.visible = false;
    scene.add(grid);
    const viewer: Viewer = { scene, camera, controls, spark, mesh: null, grid, sourceKey: null, initialCamera: null, fit: () => {} };
    viewer.fit = (overview = false) => {
      if (!viewer.mesh) return;
      const framing = sampleFramingBounds(viewer.mesh);
      const { bounds } = framing;
      if (bounds.isEmpty()) return;
      const orientation = !overview ? getCaptureOrientation(viewer.initialCamera) : null;
      const pose = !overview && viewer.initialCamera && canUseCaptureCamera(viewer.initialCamera, framing, camera.aspect)
        ? viewer.initialCamera : null;
      camera.fov = pose?.fov_y_degrees ?? 52;
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01);
      const halfFov = Math.min(THREE.MathUtils.degToRad(camera.fov / 2), Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
      const distance = radius / Math.sin(halfFov) * 1.1;
      camera.position.copy(center).add(new THREE.Vector3(1.2, 0.6, 1.8).normalize().multiplyScalar(distance));
      camera.near = Math.max(radius / 10_000, 0.0001);
      camera.far = Math.max(radius * 1000, 100);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      if (pose && orientation) {
        camera.position.fromArray(pose.position);
        camera.up.copy(orientation.up);
        const depth = Math.max(center.clone().sub(camera.position).dot(orientation.forward), radius * 0.25);
        controls.target.copy(camera.position).addScaledVector(orientation.forward, depth);
      } else if (orientation) {
        // Reframe the current geometry from the original viewing direction.
        camera.position.copy(center).addScaledVector(orientation.forward, -distance);
        camera.up.copy(orientation.up);
      } else {
        camera.up.set(0, 1, 0);
      }
      // OrbitControls captures the up axis at construction. Rebind after a pose reset.
      const target = controls.target.clone();
      controls.dispose();
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.copy(target);
      viewer.controls = controls;
      controls.update();
      grid.position.set(center.x, bounds.min.y, center.z);
      grid.scale.setScalar(radius * 4);
    };
    viewerRef.current = viewer;
    const resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "r") { viewer.fit(); event.preventDefault(); }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setError(t("GPU 渲染上下文已丢失，请重新打开项目恢复预览。"));
    };
    host.addEventListener("keydown", onKeyDown);
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.setAnimationLoop(() => {
      if (document.hidden) return;
      controls.update();
      renderer.render(scene, camera);
    });
    setReady(true);
    return () => {
      setReady(false);
      viewerRef.current = null;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      host.removeEventListener("keydown", onKeyDown);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      controls.dispose();
      viewer.mesh?.dispose();
      spark.dispose();
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      materials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.grid.visible = gridVisible;
  }, [gridVisible, ready]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | null = null;
    let revision = 0;
    let busy = false;
    let resourceInterval = 500;
    let pressureTimer: ReturnType<typeof setTimeout> | undefined;
    let currentResourceAction: PreviewResourcePolicy["action"] = "allow";
    let resourceEpoch = 0;
    let needsReload = false;
    let healthyResourceSamples = 0;
    const acceptPolicy = (policy: PreviewResourcePolicy | undefined, allowRecovery: boolean) => {
      if (!policy) return;
      if (policy.action !== "allow") healthyResourceSamples = 0;
      const severity = { allow: 0, pause: 1, release: 2 };
      if (!allowRecovery && severity[policy.action] < severity[currentResourceAction]) return;
      if (currentResourceAction !== "allow" && policy.action === "allow") {
        const requiredSamples = Math.max(1, policy.recovery_samples ?? 1);
        healthyResourceSamples += 1;
        if (healthyResourceSamples < requiredSamples) return;
      }
      if (policy.action === "allow") healthyResourceSamples = 0;
      currentResourceAction = policy.action;
      resourceInterval = policy.poll_interval_ms;
      setResourceAction(policy.action); setResourceReason(policy.reason);
      if (policy.action !== "allow") resourceEpoch += 1;
      if (policy.action === "release") {
        const viewer = viewerRef.current;
        if (viewer?.mesh) { viewer.scene.remove(viewer.mesh); viewer.mesh.dispose(); viewer.mesh = null; viewer.sourceKey = null; }
        setDisplayed(null); setHasCurrentLiveFrame(false); setLastUpdated(null);
        revision = 0;
        needsReload = true;
      }
    };
    // Independent from the serialized frame loop: pressure can arrive while
    // IPC is reading bytes or a new mesh is initializing on the GPU.
    const watchPressure = async () => {
      try {
        const policy = await desktopApi.getPreviewResourcePolicy();
        if (disposed) return;
        const previousAction = currentResourceAction;
        acceptPolicy(policy, true);
        const recovered = previousAction !== "allow" && currentResourceAction === "allow";
        if ((recovered || (!live && currentResourceAction !== "allow")) && !busy) {
          if (timer) clearTimeout(timer);
          void tick();
        }
        if (currentResourceAction !== "allow" && live) {
          await desktopApi.pollLivePreview(projectId, projectPath, "off", revision, sessionId);
        }
      } catch { healthyResourceSamples = 0; /* Unknown observations retain the last safe policy. */ }
      finally { if (!disposed) pressureTimer = setTimeout(() => void watchPressure(), 1000); }
    };

    const apply = async (source: GaussianPreviewSource) => {
      const viewer = viewerRef.current;
      if (!viewer || disposed || currentResourceAction !== "allow") return false;
      const epoch = resourceEpoch;
      const sourceKey = `${source.relative_path}:${source.revision}`;
      if (viewer.sourceKey === sourceKey) { setError(null); return true; }
      setLoading(true);
      const [bytes, initialCamera] = await Promise.all([
        desktopApi.readGaussianPly(projectId, projectPath, source),
        viewer.mesh ? Promise.resolve(viewer.initialCamera) : desktopApi.getGaussianCamera(projectId, projectPath).catch(() => null),
      ]);
      if (disposed || viewerRef.current !== viewer || currentResourceAction !== "allow" || resourceEpoch !== epoch) return false;
      const mesh = new SplatMesh({ fileBytes: bytes, fileName: "scene.ply", extSplats: true, lod: false, enableLod: false });
      try {
        await mesh.initialized;
        if (disposed || viewerRef.current !== viewer || currentResourceAction !== "allow" || resourceEpoch !== epoch) { mesh.dispose(); return false; }
        if (mesh.numSplats !== source.vertex_count) throw new Error(t("高斯模型读取不完整。"));
        const previous = viewer.mesh;
        viewer.initialCamera = initialCamera;
        viewer.scene.add(mesh);
        viewer.mesh = mesh;
        viewer.sourceKey = sourceKey;
        if (!previous) viewer.fit();
        if (previous) { viewer.scene.remove(previous); previous.dispose(); }
        setDisplayed(source);
        setLastUpdated(Date.now());
        setError(null);
        needsReload = false;
        return true;
      } catch (cause) {
        mesh.dispose();
        throw cause;
      }
    };

    const tick = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        if (live) {
          const effectiveMode = document.hidden || !running || currentResourceAction !== "allow" ? "off" : mode;
          const status = await desktopApi.pollLivePreview(projectId, projectPath, effectiveMode, revision, sessionId);
          if (disposed) return;
          acceptPolicy(status.resource_policy, false);
          setLiveAvailable(status.available);
          setLiveSessionKnown(status.session_id !== null);
          setLiveStreamRunning(status.running);
          if (sessionId !== status.session_id) { sessionId = status.session_id; revision = 0; setHasCurrentLiveFrame(false); }
          if (currentResourceAction === "allow" && !document.hidden && (mode !== "off" || !viewerRef.current?.mesh)) {
            const fallbackPath = liveFallbackPath.current;
            if (!running && fallbackPath) {
              await apply(await desktopApi.getGaussianPreview(projectId, projectPath, fallbackPath));
              if (!disposed) setHasCurrentLiveFrame(false);
            } else if (status.frame) {
              if (await apply(status.frame)) {
                if (!disposed) setHasCurrentLiveFrame(true);
                // ACK only a model installed before any intervening pressure event.
                revision = status.revision;
              }
            } else if (fallbackPath && revision === 0) {
              await apply(await desktopApi.getGaussianPreview(projectId, projectPath, fallbackPath));
            }
          }
        } else if (!document.hidden) {
          // Metadata, file decoding and GPU initialization can all take time.
          // Keep the installed model visible, but label it as the previous source
          // until the requested static model has actually been installed.
          setLoading(true);
          await apply(await desktopApi.getGaussianPreview(projectId, projectPath, staticRelativePath));
        }
      } catch (cause) {
        if (!disposed && currentResourceAction === "allow") setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busy = false;
        if (!disposed) {
          setLoading(false);
          if (live || running || needsReload) timer = setTimeout(() => void tick(), document.hidden ? Math.max(4000, resourceInterval) : Math.max(resourceInterval, mode === "low" ? 1500 : 500));
        }
      }
    };
    const onVisibility = () => { if (timer) clearTimeout(timer); void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    void watchPressure();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (pressureTimer) clearTimeout(pressureTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      // Requests also expire after 10 seconds if the window or process disappears.
      if (live) void desktopApi.pollLivePreview(projectId, projectPath, "off", revision, sessionId).catch(() => {});
    };
  }, [ready, projectId, projectPath, staticRelativePath, live, running, mode, retry]);

  const previousSourceShown = !live && displayed !== null
    && displayed.relative_path !== (relativePath?.replaceAll("\\", "/") ?? "output/scene.ply");
  const staticStatus = previousSourceShown
    ? loading ? t("正在加载所选模型 · 暂时显示上一帧") : t("所选模型尚未显示 · 保留上一帧")
    : loading ? t("正在加载高斯模型") : t("高斯渲染");
  const statusText = resourceAction === "release" ? running ? t("内存不足 · 已释放预览 · 训练继续") : t("内存不足 · 预览已释放")
    : resourceAction === "pause" ? !running ? t("内存压力升高 · 预览暂停") : resourceReason === "snapshot_budget" ? t("预览超出内存预算 · 训练继续") : resourceReason === "low_available_memory" ? t("内存余量不足 · 预览暂停 · 训练继续") : t("内存压力升高 · 预览暂停 · 训练继续")
    : !live ? staticStatus
    : !running ? t("训练未运行 · 保留最近画面")
      : mode === "off" ? t("预览已暂停 · 训练继续")
        : !liveSessionKnown ? t("等待训练预览")
          : liveAvailable === false ? t("当前为检查点预览")
            : !liveStreamRunning ? t("最近一次训练画面")
              : hasCurrentLiveFrame ? t("训练实时预览") : t("等待首帧");

  return <div className="point-cloud-viewer gaussian-viewer" aria-busy={loading}>
    {showToolbar && <div className="preview-toolbar gaussian-toolbar">
      <span className="gaussian-preview-label"><Eye size={15} />{displayed ? t("{0} 高斯", displayed.vertex_count.toLocaleString(getLocale())) : t("高斯模型")}<small>{statusText}</small></span>
      {displayed?.iteration != null && <span className="gaussian-iteration">{displayed.iteration.toLocaleString(getLocale())} step</span>}
      {live && <NativeSelect aria-label={t("训练预览刷新")} value={mode} onChange={(event) => setMode(event.target.value as LivePreviewMode)}><NativeSelectOption value="live">{t("实时")}</NativeSelectOption><NativeSelectOption value="low">{t("低频")}</NativeSelectOption><NativeSelectOption value="off">{t("暂停预览")}</NativeSelectOption></NativeSelect>}
      <Button variant="ghost" size="icon-sm"  type="button" onClick={() => viewerRef.current?.fit()} aria-label={t("重置高斯视角")} title={t("重置视角")}><ArrowsOut size={16} /></Button>
      <Button variant="ghost" size="icon-sm"  type="button" onClick={() => viewerRef.current?.fit(true)} aria-label={t("查看模型整体")} title={t("查看模型整体")}><Eye size={16} /></Button>
      <Button variant="ghost" size="icon-sm" aria-pressed={gridVisible} className={gridVisible ? "bg-white/10 text-white" : "text-slate-300"} type="button" onClick={() => setGridVisible((value) => !value)} aria-label={t("切换高斯地面网格")} title={t("切换地面网格")}><GridFour size={16} /></Button>
    </div>}
    <div className="gaussian-canvas-wrapper">
      <div className="point-cloud-canvas" ref={hostRef} tabIndex={0} role="application" aria-label={t("三维高斯预览。拖动旋转，滚轮缩放，右键平移，R 重置视角。")} />
      {!displayed && <div className="gaussian-empty"><SpinnerGap size={30} className={loading || (live && running) ? "spin" : ""} /><strong>{loading ? t("正在加载高斯模型") : live ? t("等待训练模型") : t("暂无可显示模型")}</strong><span>{live ? t("模型准备好后会自动显示，可在训练过程中旋转和缩放。") : t("读取完整高斯参数后显示重建场景。")}</span></div>}
      {error && <Notification variant="error" className="gaussian-error"
        message={`${localizeMessage(error)}${displayed ? t(" 已保留上一帧。") : ""}`}
        actions={<Button variant="outline" type="button" onClick={() => setRetry((value) => value + 1)}><ArrowClockwise size={15} />{t("重试")}</Button>}
      />}
      {!showToolbar && (!error && (resourceAction !== "allow" || previousSourceShown)
        ? <Notification variant="warning" className="gaussian-preview-notice" message={statusText} />
        : <span role="status" className="sr-only">{statusText}</span>)}
      {loading && displayed && <div className="gaussian-updating"><SpinnerGap size={13} className="spin" />{t("更新模型")}</div>}
      {lastUpdated && displayed && <span className="gaussian-updated">{new Date(lastUpdated).toLocaleTimeString(getLocale())} {t("更新")}</span>}
    </div>
  </div>;
}
