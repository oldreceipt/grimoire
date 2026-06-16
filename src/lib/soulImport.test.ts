import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeSceneStats,
  deriveNameFromPath,
  norm360,
  TRIANGLE_WARN_THRESHOLD,
} from './soulImport';

function boxMesh(size = 2): THREE.Mesh {
  // BoxGeometry has 24 vertices and 36 indices (12 triangles).
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());
}

describe('deriveNameFromPath', () => {
  it('drops directory and extension and de-snakes', () => {
    expect(deriveNameFromPath('/home/me/My_Cool-Model.glb')).toBe('My Cool Model');
  });

  it('handles Windows separators', () => {
    expect(deriveNameFromPath('C:\\models\\soul_thing.glb')).toBe('soul thing');
  });

  it('is case-insensitive on the extension and trims', () => {
    expect(deriveNameFromPath('  spooky.GLB')).toBe('spooky');
  });

  it('collapses runs of separators', () => {
    expect(deriveNameFromPath('a__b--c.glb')).toBe('a b c');
  });
});

describe('norm360', () => {
  it('wraps negatives into [0, 360)', () => {
    expect(norm360(-90)).toBe(270);
  });

  it('wraps values at or above 360', () => {
    expect(norm360(450)).toBe(90);
    expect(norm360(360)).toBe(0);
  });

  it('leaves in-range values untouched', () => {
    expect(norm360(45)).toBe(45);
  });
});

describe('computeSceneStats', () => {
  it('counts meshes, vertices, triangles, and span for an indexed box', () => {
    const stats = computeSceneStats(boxMesh(2));
    expect(stats.meshCount).toBe(1);
    expect(stats.vertexCount).toBe(24);
    expect(stats.triangleCount).toBe(12);
    expect(stats.hasBounds).toBe(true);
    expect(stats.span).toBeCloseTo(2, 5);
  });

  it('sums across multiple meshes in a group', () => {
    const group = new THREE.Group();
    group.add(boxMesh(), boxMesh());
    const stats = computeSceneStats(group);
    expect(stats.meshCount).toBe(2);
    expect(stats.triangleCount).toBe(24);
  });

  it('falls back to position count for non-indexed geometry', () => {
    const geometry = new THREE.BufferGeometry();
    // 6 vertices, no index buffer -> 2 triangles.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    const stats = computeSceneStats(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    expect(stats.triangleCount).toBe(2);
    expect(stats.meshCount).toBe(1);
  });

  it('reports no bounds and zero span for an empty object', () => {
    const stats = computeSceneStats(new THREE.Group());
    expect(stats.meshCount).toBe(0);
    expect(stats.triangleCount).toBe(0);
    expect(stats.hasBounds).toBe(false);
    expect(stats.span).toBe(0);
  });

  it('crosses the warning threshold only past the cap', () => {
    // A high-res sphere should blow well past the soft cap.
    const dense = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 256), new THREE.MeshBasicMaterial());
    expect(computeSceneStats(dense).triangleCount).toBeGreaterThan(TRIANGLE_WARN_THRESHOLD);
    expect(computeSceneStats(boxMesh()).triangleCount).toBeLessThan(TRIANGLE_WARN_THRESHOLD);
  });
});
