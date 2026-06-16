import * as THREE from 'three';

/**
 * Pure helpers for the soul-container GLB import flow, kept out of the modal
 * component so they're unit-testable without rendering React or Electron IPC.
 */

// Soul containers are small static props (the stock model is a few thousand
// triangles). A high-poly import still builds, but can hurt in-game perf, so we
// surface a soft warning past this count. Tunable; not a hard cap.
export const TRIANGLE_WARN_THRESHOLD = 50_000;

/** Derive a human name from a GLB path: drop dir + extension, de-snake. */
export function deriveNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.glb$/i, '');
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Wrap a degree value into the [0, 360) range. */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export interface SceneStats {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  /** Largest bounding-box dimension in model units; 0 when there's no geometry. */
  span: number;
  hasBounds: boolean;
}

/**
 * Walk a loaded scene and tally mesh/vertex/triangle counts plus overall span.
 * Triangle count prefers the index buffer (the real draw count) and falls back
 * to position count for non-indexed geometry.
 */
export function computeSceneStats(scene: THREE.Object3D): SceneStats {
  let meshCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  const box = new THREE.Box3();
  let hasBounds = false;

  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount += 1;
    const position = mesh.geometry?.attributes?.position;
    const verts = position?.count ?? 0;
    vertexCount += verts;
    const index = mesh.geometry?.index;
    triangleCount += Math.floor((index ? index.count : verts) / 3);
    const meshBox = new THREE.Box3().setFromObject(mesh);
    if (!meshBox.isEmpty()) {
      if (hasBounds) box.union(meshBox);
      else box.copy(meshBox);
      hasBounds = true;
    }
  });

  const span = hasBounds ? Math.max(...box.getSize(new THREE.Vector3()).toArray()) : 0;
  return { meshCount, vertexCount, triangleCount, span, hasBounds };
}
