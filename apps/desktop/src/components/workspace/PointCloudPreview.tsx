import { ArrowsOut, Eye, GridFour } from "../primitives/icons";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { PreviewCamera, PreviewPoint } from "../../types";

export function PointCloudPreview({ points, cameras = [], label }: {
  points: PreviewPoint[];
  cameras?: PreviewCamera[];
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const [gridVisible, setGridVisible] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || points.length === 0) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x11161c);
    const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      colors[index * 3] = point.r / 255;
      colors[index * 3 + 1] = point.g / 255;
      colors[index * 3 + 2] = point.b / 255;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const radius = Math.max(geometry.boundingSphere?.radius ?? 1, 0.01);
    const material = new THREE.PointsMaterial({ size: Math.max(radius / 260, 0.006), vertexColors: true, sizeAttenuation: true });
    const cloud = new THREE.Points(geometry, material);
    scene.add(cloud);
    const center = geometry.boundingSphere?.center.clone() ?? new THREE.Vector3();

    const cameraLineVertices: number[] = [];
    cameras.forEach((item) => {
      const origin = new THREE.Vector3(item.x, item.y, item.z);
      const forward = item.forward_x == null
        ? center.clone().sub(origin).normalize()
        : new THREE.Vector3(item.forward_x, item.forward_y ?? 0, item.forward_z ?? 1).normalize();
      const up = item.up_x == null
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(item.up_x, item.up_y ?? 1, item.up_z ?? 0).normalize();
      const right = new THREE.Vector3().crossVectors(up, forward).normalize();
      const correctedUp = new THREE.Vector3().crossVectors(forward, right).normalize();
      const depth = radius * 0.09;
      const planeCenter = origin.clone().addScaledVector(forward, depth);
      const halfWidth = depth * 0.48;
      const halfHeight = depth * 0.32;
      const corners = [
        planeCenter.clone().addScaledVector(right, -halfWidth).addScaledVector(correctedUp, halfHeight),
        planeCenter.clone().addScaledVector(right, halfWidth).addScaledVector(correctedUp, halfHeight),
        planeCenter.clone().addScaledVector(right, halfWidth).addScaledVector(correctedUp, -halfHeight),
        planeCenter.clone().addScaledVector(right, -halfWidth).addScaledVector(correctedUp, -halfHeight),
      ];
      const addSegment = (from: THREE.Vector3, to: THREE.Vector3) => {
        cameraLineVertices.push(from.x, from.y, from.z, to.x, to.y, to.z);
      };
      corners.forEach((corner) => addSegment(origin, corner));
      corners.forEach((corner, index) => addSegment(corner, corners[(index + 1) % corners.length]));
    });
    const cameraPositions = new Float32Array(cameraLineVertices);
    const cameraGeometry = new THREE.BufferGeometry();
    cameraGeometry.setAttribute("position", new THREE.BufferAttribute(cameraPositions, 3));
    const cameraLines = new THREE.LineSegments(cameraGeometry, new THREE.LineBasicMaterial({ color: 0x4c8dff }));
    scene.add(cameraLines);

    const grid = new THREE.GridHelper(radius * 3, 20, 0x34404d, 0x232b34);
    grid.position.y = geometry.boundingBox?.min.y ?? 0;
    gridRef.current = grid;
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const reset = () => {
      camera.position.copy(center).add(new THREE.Vector3(radius * 1.5, radius * 1.1, radius * 1.8));
      camera.near = Math.max(radius / 1000, 0.001);
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };
    resetRef.current = reset;
    reset();

    const onKeyDown = (event: KeyboardEvent) => {
      const offset = camera.position.clone().sub(controls.target);
      const verticalAxis = new THREE.Vector3(0, 1, 0);
      const rightAxis = new THREE.Vector3().crossVectors(verticalAxis, offset).normalize();
      if (event.key === "ArrowLeft") offset.applyAxisAngle(verticalAxis, 0.1);
      else if (event.key === "ArrowRight") offset.applyAxisAngle(verticalAxis, -0.1);
      else if (event.key === "ArrowUp") offset.applyAxisAngle(rightAxis, -0.1);
      else if (event.key === "ArrowDown") offset.applyAxisAngle(rightAxis, 0.1);
      else if (event.key === "+" || event.key === "=") offset.multiplyScalar(0.88);
      else if (event.key === "-" || event.key === "_") offset.multiplyScalar(1.12);
      else if (event.key.toLowerCase() === "r") {
        reset();
        event.preventDefault();
        return;
      } else return;
      camera.position.copy(controls.target).add(offset);
      controls.update();
      event.preventDefault();
    };
    host.addEventListener("keydown", onKeyDown);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();
    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      host.removeEventListener("keydown", onKeyDown);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      cameraGeometry.dispose();
      (cameraLines.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      gridRef.current = null;
      resetRef.current = null;
    };
  }, [cameras, points]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = gridVisible;
  }, [gridVisible]);

  return (
    <div className="point-cloud-viewer">
      <div className="preview-toolbar">
        <span><Eye size={15} />{label}</span>
        <button className="icon-button" type="button" onClick={() => resetRef.current?.()} aria-label="重置视角" title="重置视角"><ArrowsOut size={16} /></button>
        <button className={`icon-button ${gridVisible ? "is-active" : ""}`} type="button" onClick={() => setGridVisible((value) => !value)} aria-label="切换地面网格" title="切换地面网格"><GridFour size={16} /></button>
      </div>
      <div className="point-cloud-canvas" ref={hostRef} tabIndex={0} role="application" aria-describedby="point-cloud-keyboard-help" aria-label={`真实三维预览，共 ${points.length} 个显示点`} />
      <span id="point-cloud-keyboard-help" className="visually-hidden">方向键旋转视角，加号和减号缩放，R 重置视角。</span>
    </div>
  );
}
