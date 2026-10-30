import type { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import type { GaussianCamera } from "../../types";

export interface FramingBounds {
  bounds: THREE.Box3;
  samples: THREE.Vector3[];
}

// Ignore distant floaters for framing only; every splat is still rendered.
export function sampleFramingBounds(mesh: SplatMesh): FramingBounds {
  const samples: THREE.Vector3[] = [];
  const stride = Math.max(1, Math.floor(mesh.numSplats / 10_000));
  mesh.forEachSplat((index, center, _scales, _rotation, opacity) => {
    if (index % stride !== 0 || opacity < 0.05) return;
    if ([center.x, center.y, center.z].every(Number.isFinite)) samples.push(center.clone());
  });
  if (samples.length < 10) return { bounds: mesh.getBoundingBox(), samples };
  const axes = ["x", "y", "z"].map((axis) => samples.map((point) => point[axis as "x" | "y" | "z"]).sort((a, b) => a - b));
  const low = axes.map((axis) => axis[Math.floor((axis.length - 1) * 0.02)]);
  const high = axes.map((axis) => axis[Math.ceil((axis.length - 1) * 0.98)]);
  return { bounds: new THREE.Box3(new THREE.Vector3(...low), new THREE.Vector3(...high)), samples };
}

export function getCaptureOrientation(pose: GaussianCamera | null) {
  if (!pose || ![...pose.position, ...pose.forward, ...pose.up, pose.fov_y_degrees].every(Number.isFinite)
    || pose.fov_y_degrees <= 0 || pose.fov_y_degrees >= 180) return null;
  const forwardLength = Math.hypot(...pose.forward), upLength = Math.hypot(...pose.up);
  if (!Number.isFinite(forwardLength) || !Number.isFinite(upLength) || forwardLength === 0 || upLength === 0) return null;
  const forward = new THREE.Vector3().fromArray(pose.forward.map((value) => value / forwardLength));
  const up = new THREE.Vector3().fromArray(pose.up.map((value) => value / upLength));
  const right = new THREE.Vector3().crossVectors(forward, up);
  const rightLength = Math.hypot(right.x, right.y, right.z);
  if (rightLength === 0) return null;
  return { forward, up, right: right.set(right.x / rightLength, right.y / rightLength, right.z / rightLength) };
}

export function canUseCaptureCamera(pose: GaussianCamera, { bounds, samples }: FramingBounds, aspect: number): boolean {
  const orientation = getCaptureOrientation(pose);
  if (!orientation) return false;
  const position = new THREE.Vector3().fromArray(pose.position);
  const { forward, right } = orientation;
  // Interior captures must stay inside the scene instead of moving outside its walls.
  if (bounds.containsPoint(position) || samples.length < 10) return true;
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const relative = new THREE.Vector3();
  // These are conservative framing heuristics, not reconstruction-quality tolerances:
  // allow a 5% border and reject only a pose seeing at most 0.1% of the robust core.
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(pose.fov_y_degrees / 2)) * 1.05;
  const halfWidth = halfHeight * aspect;
  const inView = (point: THREE.Vector3) => {
    relative.subVectors(point, position);
    const depth = relative.dot(forward);
    return depth > 0 && Math.abs(relative.dot(right)) <= depth * halfWidth && Math.abs(relative.dot(up)) <= depth * halfHeight;
  };
  if (inView(bounds.getCenter(new THREE.Vector3()))) return true;
  let core = 0, visible = 0;
  for (const point of samples) {
    if (!bounds.containsPoint(point)) continue;
    core += 1;
    if (inView(point)) visible += 1;
  }
  return core < 10 || visible / core > 0.001;
}
