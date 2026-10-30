import { describe, expect, it } from "vitest";
import type { PreviewCamera } from "../../types";
import { inferSparseUp } from "./sparseFraming";

function camera(up?: readonly number[]): PreviewCamera {
  return {
    x: 0, y: 0, z: 3, name: "synthetic-camera",
    ...(up && { up_x: up[0], up_y: up[1], up_z: up[2] }),
  };
}

describe("sparse preview image-up convention", () => {
  it("recognizes COLMAP's negative-Y image up without assuming world +Y", () => {
    expect(inferSparseUp([camera([0, -1, 0]), camera([0, -2, 0])]).toArray()).toEqual([0, -1, 0]);
  });

  it("normalizes every camera before averaging, preserving oblique orientations", () => {
    const cameras = [camera([100, 0, 0]), camera([0, -1, 0])];
    cameras.forEach(Object.freeze);
    Object.freeze(cameras);
    const up = inferSparseUp(cameras);
    expect(up.x).toBeCloseTo(Math.SQRT1_2);
    expect(up.y).toBeCloseTo(-Math.SQRT1_2);
    expect(up.z).toBe(0);
    expect(up.length()).toBeCloseTo(1);
    expect(cameras[0].up_x).toBe(100);
  });

  it("ignores absent, incomplete, nonfinite and zero-length orientations", () => {
    const invalid = [camera(), camera([0]), camera([0, 0, 0]), camera([NaN, 1, 0]), camera([0, Infinity, 0])];
    expect(inferSparseUp(invalid).toArray()).toEqual([0, 1, 0]);
    expect(inferSparseUp([...invalid, camera([0, -1, 0])]).toArray()).toEqual([0, -1, 0]);
    expect(inferSparseUp([]).toArray()).toEqual([0, 1, 0]);
  });

  it("retains a finite neutral view for opposing or weakly coherent image directions", () => {
    const positive = camera([0, 1, 0]), negative = camera([0, -1, 0]);
    expect(inferSparseUp([positive, negative]).toArray()).toEqual([0, 1, 0]);
    expect(inferSparseUp([negative, negative, negative, positive, positive]).toArray()).toEqual([0, 1, 0]);
  });
});
