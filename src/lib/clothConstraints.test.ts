import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyGoalDampedAttraction, applyRawAttraction, projectKelagerBend, reconstructClothRope, reconstructClothTwist, type TwistNode } from './clothConstraints';
import type { ClothKelagerBend, ClothTwist } from './feModel';

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const axisZ = v(0, 0, 1);

describe('compiled animation attraction', () => {
  it('uses force for goal displacement and vertex for velocity damping in goal mode', () => {
    const position = v(8);
    const previous = v(6);
    applyGoalDampedAttraction(position, previous, v(), 0.25, 0.5);
    expect(position.x).toBe(6);
    expect(previous.x).toBe(6);
  });

  it('can damp without pulling, and full attraction resets both history buffers', () => {
    const position = v(8);
    const previous = v(6);
    applyGoalDampedAttraction(position, previous, v(), 0, 1);
    expect(position.x).toBe(8);
    expect(previous.x).toBe(8);
    applyGoalDampedAttraction(position, previous, v(2), 1, 0);
    expect(position.x).toBe(2);
    expect(previous.x).toBe(2);
  });

  it('settles an undriven displaced particle without the preview damping floor', () => {
    const position = v(8);
    const previous = v(8);
    for (let i = 0; i < 1200; i++) {
      const velocity = position.clone().sub(previous);
      previous.copy(position);
      position.add(velocity);
      applyGoalDampedAttraction(position, previous, v(), 0.05, 0.3);
    }
    expect(position.length()).toBeLessThan(1e-8);
    expect(position.distanceTo(previous)).toBeLessThan(1e-8);
  });

  it('uses the raw position blend in both buffers with its history correction', () => {
    const position = v();
    const previous = v();
    applyRawAttraction(position, previous, v(10), 0, 30, 1 / 60);
    expect(position.x).toBe(5);
    expect(previous.x).toBe(2.5);
    // This distinguishes the raw path from the same coefficients in goal mode.
    const damped = v();
    applyGoalDampedAttraction(damped, v(), v(10), 0, 30);
    expect(damped.x).toBe(0);
  });

  it('raw force imparts velocity without translating history', () => {
    const position = v();
    const previous = v();
    applyRawAttraction(position, previous, v(10), 3, 0, 1 / 60);
    expect(position.x).toBeCloseTo(1);
    expect(previous.x).toBe(0);
  });
});

describe('Kelager bending', () => {
  const bend: ClothKelagerBend = { node: [0, 1, 2], weight: [-1, 0.5, 0.5], height0: 0 };
  const nodes = () => [v(0, 1), v(-1), v(1)].map((pos) => ({ pos, kinematic: false }));

  it('straightens a bent segment while conserving its centroid', () => {
    const points = nodes();
    projectKelagerBend(points, bend);
    for (const point of points) expect(point.pos.y).toBeCloseTo(1 / 3);
    expect(points[1].pos.distanceTo(points[2].pos)).toBeCloseTo(2);
  });

  it('leaves a bend below its authored height unchanged', () => {
    const points = nodes();
    projectKelagerBend(points, { ...bend, height0: 1 });
    expect(points.map((point) => point.pos.toArray())).toEqual([[0, 1, 0], [-1, 0, 0], [1, 0, 0]]);
  });

  it('honors a compiled share of three without moving either anchor', () => {
    const points = [
      { pos: v(), kinematic: true },
      { pos: v(-1, 1), kinematic: false },
      { pos: v(1), kinematic: true },
    ];
    projectKelagerBend(points, { ...bend, weight: [0, 3, 0] });
    expect(points.map((point) => point.pos.toArray())).toEqual([[0, 0, 0], [-1, 0, 0], [1, 0, 0]]);
  });

  it('is invariant under rigid transforms and handles a collapsed segment', () => {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 1.2));
    const offset = v(18, -43, 12);
    const points = nodes();
    const transformed = nodes();
    transformed.forEach((point) => point.pos.applyQuaternion(rotation).add(offset));
    projectKelagerBend(points, bend);
    projectKelagerBend(transformed, bend);
    points.forEach((point, i) => {
      expect(point.pos.applyQuaternion(rotation).add(offset).distanceTo(transformed[i].pos)).toBeLessThan(1e-10);
    });
    const collapsed = [v(), v(), v()].map((pos) => ({ pos, kinematic: false }));
    projectKelagerBend(collapsed, bend);
    expect(collapsed.every((point) => point.pos.length() === 0)).toBe(true);
  });
});

describe('rope bone reconstruction', () => {
  const nodes = (): TwistNode[] => [0, 1, 2].map((x) => ({
    pos: v(0, x), initPos: [x, 0, 0], initRot: [0, 0, 0, 1],
    solvedRot: new THREE.Quaternion(), targetRot: new THREE.Quaternion(),
  }));

  it('aligns the animated X axis to each segment and copies the terminal rotation', () => {
    const points = nodes();
    points[2].pos.set(1, 1, 0);
    points[1].targetRot.setFromAxisAngle(v(1), 0.8);
    reconstructClothRope(points, [0, 1, 2], new Set([0, 1, 2]));
    expect(v(1).applyQuaternion(points[0].solvedRot).distanceTo(v(0, 1))).toBeLessThan(1e-7);
    expect(points[1].solvedRot.angleTo(points[1].targetRot)).toBeLessThan(1e-7);
    expect(points[2].solvedRot.angleTo(points[1].solvedRot)).toBeLessThan(1e-7);
    expect(points.map((point) => point.pos.toArray())).toEqual([[0, 0, 0], [0, 1, 0], [1, 1, 0]]);
  });

  it('preserves a two-node tip own animated twist and leaves rotation-locked anchors alone', () => {
    const points = nodes();
    points[1].targetRot.setFromAxisAngle(v(1), 0.8);
    reconstructClothRope(points, [0, 1], new Set([1]));
    expect(points[0].solvedRot.toArray()).toEqual([0, 0, 0, 1]);
    expect(v(1).applyQuaternion(points[1].solvedRot).distanceTo(v(0, 1))).toBeLessThan(1e-7);
    expect(v(0, 0, 1).applyQuaternion(points[1].solvedRot).z).toBeCloseTo(Math.cos(0.8));
  });

  it('recovers reversed X direction from the rest pose and keeps collapsed links finite', () => {
    const points = nodes();
    points[1].initPos = [-1, 0, 0];
    reconstructClothRope(points, [0, 1], new Set([0, 1]));
    expect(v(-1).applyQuaternion(points[0].solvedRot).distanceTo(v(0, 1))).toBeLessThan(1e-7);
    points[1].pos.copy(points[0].pos);
    reconstructClothRope(points, [0, 1], new Set([0, 1]));
    expect(points[0].solvedRot.toArray()).toEqual([0, 0, 0, 1]);
  });
});

describe('directed twist and swing reconstruction', () => {
  const link: ClothTwist = { nodeOrient: 0, nodeEnd: 1, twistRelax: 1, swingRelax: 1 };
  const nodes = (): TwistNode[] => [
    { pos: v(), initPos: [0, 0, 0], initRot: [0, 0, 0, 1], solvedRot: new THREE.Quaternion(), targetRot: new THREE.Quaternion() },
    { pos: v(0, 0, 1), initPos: [0, 0, 1], initRot: [0, 0, 0, 1], solvedRot: new THREE.Quaternion(), targetRot: new THREE.Quaternion() },
  ];

  it('orients the skinning axis toward a bent segment without moving either particle', () => {
    const points = nodes();
    points[1].pos.set(0, -1, 0);
    reconstructClothTwist(points, { ...link, twistRelax: 0 });
    expect(axisZ.clone().applyQuaternion(points[0].solvedRot).distanceTo(v(0, -1, 0))).toBeLessThan(1e-7);
    expect(points[0].pos.toArray()).toEqual([0, 0, 0]);
    expect(points[1].pos.toArray()).toEqual([0, -1, 0]);
  });

  it('transfers axial twist independently of swing', () => {
    const points = nodes();
    points[1].solvedRot.setFromAxisAngle(axisZ, Math.PI / 2);
    reconstructClothTwist(points, { ...link, swingRelax: 0 });
    expect(points[0].solvedRot.angleTo(points[1].solvedRot)).toBeLessThan(1e-7);
    expect(axisZ.clone().applyQuaternion(points[0].solvedRot).distanceTo(axisZ)).toBeLessThan(1e-7);
  });

  it('keeps a zero-weight orientation and a degenerate link finite', () => {
    const points = nodes();
    points[1].pos.set(0, -1, 0);
    reconstructClothTwist(points, { ...link, twistRelax: 0, swingRelax: 0 });
    expect(points[0].solvedRot.toArray()).toEqual([0, 0, 0, 1]);
    points[1].pos.copy(points[0].pos);
    reconstructClothTwist(points, link);
    expect(points[0].solvedRot.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('relaxes combined swing and twist without normalizing the projection before blending', () => {
    const points = nodes();
    points[1].solvedRot.setFromAxisAngle(v(1), 1.2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(axisZ, 0.8));
    points[1].pos.copy(axisZ).applyQuaternion(points[1].solvedRot);
    reconstructClothTwist(points, { ...link, twistRelax: 0.618, swingRelax: 0.5 });
    // Analytic result: swing 0.54081718 radians, twist 0.45818280 radians.
    const expected = new THREE.Quaternion(0.2601460571638217, -0.060662198251375664, 0.21884062134845542, 0.9384843680601453);
    expect(points[0].solvedRot.angleTo(expected)).toBeLessThan(1e-7);
  });

  it('uses the animation orientation for a self link', () => {
    const points = nodes();
    points[0].targetRot.setFromAxisAngle(axisZ, 0.7);
    reconstructClothTwist(points, { ...link, nodeEnd: 0 });
    expect(points[0].solvedRot.angleTo(points[0].targetRot)).toBeLessThan(1e-7);
  });

  it('preserves authored relative rotations under a rigidly transformed pose', () => {
    const points = nodes();
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.8, -0.6));
    const rest0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.5, 0.3));
    const rest1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.8, 0.1, 1.1));
    points[0].initRot = rest0.toArray();
    points[1].initRot = rest1.toArray();
    points[0].solvedRot.copy(rotation).multiply(rest0);
    points[1].solvedRot.copy(rotation).multiply(rest1);
    points.forEach((point) => point.pos.applyQuaternion(rotation).add(v(7, 5, -9)));
    const expected = points[0].solvedRot.clone();
    reconstructClothTwist(points, { ...link, twistRelax: 0.618, swingRelax: 0.5 });
    expect(points[0].solvedRot.angleTo(expected)).toBeLessThan(1e-7);
  });
});
