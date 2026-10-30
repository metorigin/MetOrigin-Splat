import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { PreviewCamera, PreviewPoint } from "../../types";
import { PointCloudPreview } from "./PointCloudPreview";

const harness = vi.hoisted(() => ({ scene: null as THREE.Scene | null, camera: null as THREE.PerspectiveCamera | null }));

// Keep actual Three geometry, transforms and OrbitControls. jsdom only replaces
// the WebGL surface and animation scheduling; no GPU or project files are used.
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement("canvas");
    setPixelRatio() {} setSize() {} dispose() {}
    render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
      harness.scene = scene;
      harness.camera = camera;
    }
  } };
});

const syntheticPoints = (): PreviewPoint[] => [
  { x: -2, y: -3, z: -1, r: 80, g: 120, b: 160 },
  { x: 2, y: 3, z: 1, r: 160, g: 120, b: 80 },
  { x: -1, y: 2, z: 2, r: 30, g: 60, b: 90 },
];
const syntheticCameras = (up: readonly number[]): PreviewCamera[] => [
  { x: 0, y: 0, z: 6, forward_x: 0, forward_y: 0, forward_z: -1, up_x: up[0], up_y: up[1], up_z: up[2], name: "synthetic-camera" },
];

beforeEach(() => {
  harness.scene = null;
  harness.camera = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("sparse preview orientation with real OrbitControls", () => {
  it.each([
    { name: "negative-Y", up: [0, -1, 0] },
    { name: "oblique", up: [1, -2, 1] },
  ])("uses $name image-up for the camera, ground and keyboard navigation", ({ up: components }) => {
    const points = syntheticPoints(), cameras = syntheticCameras(components);
    const original = structuredClone({ points, cameras });
    points.forEach(Object.freeze); cameras.forEach(Object.freeze);
    Object.freeze(points); Object.freeze(cameras);
    const view = render(<PointCloudPreview points={points} cameras={cameras} label="synthetic sparse preview" showToolbar={false} />);
    const camera = harness.camera!;
    const scene = harness.scene!;
    const up = new THREE.Vector3(...components).normalize();
    const cloud = scene.children.find((node) => node.type === "Points") as THREE.Points;
    const grid = scene.children.find((node) => node.type === "GridHelper") as THREE.GridHelper;
    const cameraLines = scene.children.find((node) => node.type === "LineSegments") as THREE.LineSegments;
    const center = cloud.geometry.boundingSphere!.center;

    expect(camera.up.dot(up)).toBeCloseTo(1);
    expect(camera.position.clone().sub(center).dot(up)).toBeGreaterThan(0);
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(grid.quaternion).dot(up)).toBeCloseTo(1);
    const floor = Math.min(...points.map((point) => new THREE.Vector3(point.x, point.y, point.z).dot(up)));
    expect(grid.position.dot(up)).toBeCloseTo(floor);
    expect([...cloud.geometry.getAttribute("position").array]).toEqual(points.flatMap(({ x, y, z }) => [x, y, z]));
    expect([...cameraLines.geometry.getAttribute("position").array].slice(0, 3)).toEqual([cameras[0].x, cameras[0].y, cameras[0].z]);

    const canvas = screen.getByRole("application");
    expect(view.container.querySelector(".preview-toolbar")).toBeNull();
    const initialPosition = camera.position.clone();
    const initialHeight = initialPosition.clone().sub(center).dot(up);
    const initialRadius = initialPosition.distanceTo(center);
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(camera.position.distanceTo(initialPosition)).toBeGreaterThan(0.01);
    expect(camera.position.clone().sub(center).dot(up)).toBeCloseTo(initialHeight);
    expect(camera.position.distanceTo(center)).toBeCloseTo(initialRadius);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(camera.position.clone().sub(center).dot(up)).toBeCloseTo(initialHeight);
    expect(camera.position.distanceTo(center)).toBeCloseTo(initialRadius);
    camera.position.set(9, 8, 7);
    fireEvent.keyDown(canvas, { key: "r" });
    expect(camera.position.distanceTo(initialPosition)).toBeCloseTo(0);
    expect({ points, cameras }).toEqual(original);
    view.unmount();
  });

  it("keeps a finite +Y default when camera orientation is unavailable", () => {
    const cameras: PreviewCamera[] = [{ x: 0, y: 0, z: 6, name: "legacy-camera" }];
    const view = render(<PointCloudPreview points={syntheticPoints()} cameras={cameras} label="legacy sparse preview" />);
    const camera = harness.camera!;
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect([...camera.position.toArray(), ...camera.quaternion.toArray()].every(Number.isFinite)).toBe(true);
    view.unmount();
  });
});
