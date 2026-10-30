import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { GaussianCamera } from "../../types";
import { canUseCaptureCamera, getCaptureOrientation, type FramingBounds } from "./gaussianFraming";

const pose: GaussianCamera = { position: [0, 0, 5], forward: [0, 0, -1], up: [0, 1, 0], fov_y_degrees: 52 };
const cloud = (y = 0): FramingBounds => {
  const samples = Array.from({ length: 1000 }, (_, i) => new THREE.Vector3((i % 10) / 5 - 0.9, y + (Math.floor(i / 10) % 10) / 5 - 0.9, Math.floor(i / 100) / 5 - 0.9));
  return { samples, bounds: new THREE.Box3().setFromPoints(samples) };
};

describe("capture camera compatibility", () => {
  it.each([Number.MIN_VALUE, 1e308])("normalizes finite camera axes of magnitude %s without producing invalid values", (magnitude) => {
    const orientation = getCaptureOrientation({ ...pose, forward: [0, 0, -magnitude], up: [0, -magnitude, 0] });
    expect(orientation?.forward.toArray()).toEqual([0, 0, -1]);
    expect(orientation?.up.toArray()).toEqual([0, -1, 0]);
    expect(orientation?.right.distanceTo(new THREE.Vector3(-1, 0, 0))).toBe(0);
  });

  it("keeps an aligned capture but rejects the same pose after the model moves out of view", () => {
    for (const aspect of [0.75, 1, 1.31, 16 / 9, 2.5]) {
      expect(canUseCaptureCamera(pose, cloud(), aspect)).toBe(true);
      expect(canUseCaptureCamera(pose, cloud(20), aspect)).toBe(false);
    }
  });

  it("keeps interior room cameras even when the box center and sampled walls are behind them", () => {
    const framing = cloud(-20);
    framing.bounds.expandByPoint(new THREE.Vector3(2, 2, 8));
    expect(canUseCaptureCamera({ ...pose, forward: [0, 0, 1] }, framing, 1)).toBe(true);
  });

  it("keeps off-center captures with visible geometry, but ignores an isolated visible floater", () => {
    const framing = cloud(20);
    framing.bounds.expandByPoint(new THREE.Vector3(0, 0, 0));
    framing.samples.push(new THREE.Vector3(0, 0, 0));
    expect(canUseCaptureCamera(pose, framing, 1)).toBe(false);
    framing.samples.push(new THREE.Vector3(0.1, 0, 0));
    expect(canUseCaptureCamera(pose, framing, 1)).toBe(true);
  });

  it("keeps the existing capture when there are too few samples to infer a mismatch", () => {
    const framing = cloud(20);
    framing.samples = framing.samples.slice(0, 9);
    expect(canUseCaptureCamera(pose, framing, 1)).toBe(true);
  });
});
