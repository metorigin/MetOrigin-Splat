import * as THREE from "three";
import type { PreviewCamera } from "../../types";

/** Image-up consensus is a viewing convention, not a measurement of gravity. */
export function inferSparseUp(cameras: readonly PreviewCamera[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  let count = 0;
  for (const camera of cameras) {
    const components = [camera.up_x, camera.up_y, camera.up_z];
    if (!components.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    const up = new THREE.Vector3(camera.up_x, camera.up_y, camera.up_z);
    const length = up.length();
    if (length < 1e-6 || !Number.isFinite(length)) continue;
    sum.add(up.divideScalar(length));
    count += 1;
  }
  // Contradictory or absent image orientations must not amplify tiny numerical
  // residuals into an arbitrary scene flip. Keep the legacy neutral view then.
  if (count === 0 || sum.length() / count < 0.25) return new THREE.Vector3(0, 1, 0);
  return sum.normalize();
}
