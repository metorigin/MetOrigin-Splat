import { localizeMessage, t, getLocale } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ArrowsOut, ArrowClockwise, Eye, GridFour, SpinnerGap } from "../primitives/icons";
import { desktopApi } from "../../services/desktop";
import type { GaussianCamera, GaussianPreviewSource, LivePreviewMode } from "../../types";

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
}

// Ignore a small tail of distant floaters when framing the subject. This only
// affects the initial camera, never removes splats from rendering.
function robustBounds(mesh: SplatMesh): THREE.Box3 {
  const axes: number[][] = [[], [], []];
  const stride = Math.max(1, Math.floor(mesh.numSplats / 10_000));
  mesh.forEachSplat((index, center, _scales, _rotation, opacity) => {
    if (index % stride !== 0 || opacity < 0.05) return;
    if ([center.x, center.y, center.z].every(Number.isFinite)) {
      axes[0].push(center.x); axes[1].push(center.y); axes[2].push(center.z);
    }
  });
  if (axes[0].length < 10) return mesh.getBoundingBox();
  axes.forEach((axis) => axis.sort((a, b) => a - b));
  const low = axes.map((axis) => axis[Math.floor((axis.length - 1) * 0.02)]);
  const high = axes.map((axis) => axis[Math.ceil((axis.length - 1) * 0.98)]);
  return new THREE.Box3(new THREE.Vector3(...low), new THREE.Vector3(...high));
}

export function GaussianSplatPreview({ projectId, projectPath, relativePath, live, running }: Props) {
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
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    let spark: SparkRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x11161c, 1);
      // Brush sorts projected splats by depth. Keep full SH and full model resolution.
      spark = new SparkRenderer({ renderer, sortRadial: false, enableLod: false, accumExtSplats: true, maxStdDev: 3, preBlurAmount: 0.3, blurAmount: 0 });
    } catch (cause) {
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
      const bounds = robustBounds(viewer.mesh);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01);
      const halfFov = Math.min(THREE.MathUtils.degToRad(camera.fov / 2), Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
      const distance = radius / Math.sin(halfFov) * 1.1;
      camera.position.copy(center).add(new THREE.Vector3(1.2, 0.6, 1.8).normalize().multiplyScalar(distance));
      camera.near = Math.max(radius / 10_000, 0.0001);
      camera.far = Math.max(radius * 1000, 100);
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      const pose = viewer.initialCamera;
      if (pose && !overview) {
        camera.position.fromArray(pose.position);
        camera.up.fromArray(pose.up).normalize();
        camera.fov = pose.fov_y_degrees;
        camera.updateProjectionMatrix();
        const direction = new THREE.Vector3().fromArray(pose.forward).normalize();
        const depth = Math.max(center.clone().sub(camera.position).dot(direction), radius * 0.25);
        controls.target.copy(camera.position).addScaledVector(direction, depth);
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

    const apply = async (source: GaussianPreviewSource) => {
      const viewer = viewerRef.current;
      if (!viewer || disposed) return;
      const sourceKey = `${source.relative_path}:${source.revision}`;
      if (viewer.sourceKey === sourceKey) { setError(null); return; }
      setLoading(true);
      const [bytes, initialCamera] = await Promise.all([
        desktopApi.readGaussianPly(projectId, projectPath, source),
        viewer.mesh ? Promise.resolve(viewer.initialCamera) : desktopApi.getGaussianCamera(projectId, projectPath).catch(() => null),
      ]);
      if (disposed || viewerRef.current !== viewer) return;
      const mesh = new SplatMesh({ fileBytes: bytes, fileName: "scene.ply", extSplats: true, lod: false, enableLod: false });
      try {
        await mesh.initialized;
        if (disposed || viewerRef.current !== viewer) { mesh.dispose(); return; }
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
          const effectiveMode = document.hidden || !running ? "off" : mode;
          const status = await desktopApi.pollLivePreview(projectId, projectPath, effectiveMode, revision, sessionId);
          if (disposed) return;
          setLiveAvailable(status.available);
          setLiveSessionKnown(status.session_id !== null);
          setLiveStreamRunning(status.running);
          if (sessionId !== status.session_id) { sessionId = status.session_id; revision = 0; setHasCurrentLiveFrame(false); }
          if (!document.hidden && (mode !== "off" || !viewerRef.current?.mesh)) {
            if (status.frame) {
              await apply(status.frame);
              if (!disposed) setHasCurrentLiveFrame(true);
              // Acknowledge only after decoding and installing the model have succeeded.
              revision = status.revision;
            } else if (relativePath) {
              await apply(await desktopApi.getGaussianPreview(projectId, projectPath, relativePath));
            }
          }
        } else if (!document.hidden) {
          await apply(await desktopApi.getGaussianPreview(projectId, projectPath, relativePath));
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busy = false;
        if (!disposed) {
          setLoading(false);
          if (live || running) timer = setTimeout(() => void tick(), document.hidden ? 4000 : mode === "low" ? 1500 : 500);
        }
      }
    };
    const onVisibility = () => { if (timer) clearTimeout(timer); void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      // Requests also expire after 10 seconds if the window or process disappears.
      if (live) void desktopApi.pollLivePreview(projectId, projectPath, "off", revision, sessionId).catch(() => {});
    };
  }, [ready, projectId, projectPath, relativePath, live, running, mode, retry]);

  const statusText = !live ? t("高斯渲染")
    : !running ? t("训练未运行 · 保留最近画面")
      : mode === "off" ? t("预览已暂停 · 训练继续")
        : !liveSessionKnown ? t("等待训练预览")
          : liveAvailable === false ? t("当前为检查点预览")
            : !liveStreamRunning ? t("最近一次训练画面")
              : hasCurrentLiveFrame ? t("训练实时预览") : t("等待首帧");

  return <div className="point-cloud-viewer gaussian-viewer" aria-busy={loading}>
    <div className="preview-toolbar gaussian-toolbar">
      <span className="gaussian-preview-label"><Eye size={15} />{displayed ? t("{0} 高斯", displayed.vertex_count.toLocaleString(getLocale())) : t("高斯模型")}<small>{statusText}</small></span>
      {displayed?.iteration != null && <span className="gaussian-iteration">{displayed.iteration.toLocaleString(getLocale())} step</span>}
      {live && <select aria-label={t("训练预览刷新")} value={mode} onChange={(event) => setMode(event.target.value as LivePreviewMode)}><option value="live">{t("实时")}</option><option value="low">{t("低频")}</option><option value="off">{t("暂停预览")}</option></select>}
      <button className="icon-button" type="button" onClick={() => viewerRef.current?.fit()} aria-label={t("重置高斯视角")} title={t("重置视角")}><ArrowsOut size={16} /></button>
      <button className="icon-button" type="button" onClick={() => viewerRef.current?.fit(true)} aria-label={t("查看模型整体")} title={t("查看模型整体")}><Eye size={16} /></button>
      <button className={`icon-button ${gridVisible ? "is-active" : ""}`} type="button" onClick={() => setGridVisible((value) => !value)} aria-label={t("切换高斯地面网格")} title={t("切换地面网格")}><GridFour size={16} /></button>
    </div>
    <div className="gaussian-canvas-wrapper">
      <div className="point-cloud-canvas" ref={hostRef} tabIndex={0} role="application" aria-label={t("三维高斯预览。拖动旋转，滚轮缩放，右键平移，R 重置视角。")} />
      {!displayed && <div className="gaussian-empty"><SpinnerGap size={30} className={loading || (live && running) ? "spin" : ""} /><strong>{loading ? t("正在加载高斯模型") : live ? t("等待训练模型") : t("暂无可显示模型")}</strong><span>{live ? t("模型准备好后会自动显示，可在训练过程中旋转和缩放。") : t("读取完整高斯参数后显示重建场景。")}</span></div>}
      {error && <div className="gaussian-error" role="alert"><span>{localizeMessage(error)}{displayed ? t(" 已保留上一帧。") : ""}</span><button type="button" className="button button-secondary" onClick={() => setRetry((value) => value + 1)}><ArrowClockwise size={15} />{t("重试")}</button></div>}
      {loading && displayed && <div className="gaussian-updating"><SpinnerGap size={13} className="spin" />{t("更新模型")}</div>}
      {lastUpdated && displayed && <span className="gaussian-updated">{new Date(lastUpdated).toLocaleTimeString(getLocale())} {t("更新")}</span>}
    </div>
  </div>;
}
