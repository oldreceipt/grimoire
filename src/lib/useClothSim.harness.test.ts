import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ClothModel, ClothNode } from './feModel';
import { CLOTH_TIMESTEP, createClothSimHarness } from './useClothSim';

const Q: [number, number, number, number] = [0, 0, 0, 1];
const jiggleParams = {} as NonNullable<ClothModel['jiggleBones'][number]['params']>;

function node(name: string, initPos: [number, number, number], pinned = false): ClothNode {
  return {
    name,
    invMass: pinned ? 0 : 1,
    pinned,
    gravity: pinned ? 0 : 0.5,
    damping: 0.02,
    animForce: pinned ? 0 : 20,
    animVertex: pinned ? 0 : 4,
    initPos,
    initRot: Q,
    collideRadius: 0,
    friction: 0,
    collisionMask: 0xffff,
  };
}

function syntheticClothModel(): ClothModel {
  return {
    nodes: [
      node('cloth_anchor', [0, 0, 0], true),
      node('cloth_mid', [1, 0.25, 0.2]),
      node('cloth_tip', [0.35, 1.1, -0.25]),
    ],
    rods: [
      { a: 0, b: 1, min: 1.05, max: 1.05, relax: 1, weight: 0 },
      { a: 1, b: 2, min: 1.1608, max: 1.1608, relax: 1, weight: 0.5 },
    ],
    capsules: [],
    animatedRods: [],
    decodeIssues: [],
    staticNodeFlags: null,
    dynamicNodeFlags: null,
    goalDampedSpringIntegrators: [],
    spheres: [],
    boxes: [],
    nodeBases: [],
    ctrlOffsets: [],
    reverseOffsets: [],
    softOffsets: [],
    strayRadii: [],
    skelParents: [-1, 0, 1],
    staticNodeCount: 1,
    addWorldCollisionRadius: 0,
    defaultGravityScale: 1,
    extraIterations: 8,
    extraGoalIterations: 0,
    twists: [],
    fitMatrices: [],
    fitWeights: [],
    freeNodes: [],
    lockToParent: [],
    lockToGoal: [],
    collisionPlanes: [],
    ropes: [],
    jiggleBones: [],
    kelagerBends: [],
    firstPositionDrivenNode: 3,
    rodVelocitySmoothRate: 0,
    rodVelocitySmoothIterations: 0,
    rotLockStaticNodeCount: 0,
  };
}

function syntheticRoot(): { root: THREE.Group; anchor: THREE.Bone } {
  const root = new THREE.Group();
  const anchor = new THREE.Bone();
  const mid = new THREE.Bone();
  const tip = new THREE.Bone();
  anchor.name = 'cloth_anchor';
  mid.name = 'cloth_mid';
  tip.name = 'cloth_tip';
  anchor.position.set(0, 0, 0);
  mid.position.set(1, 0.25, 0.2);
  tip.position.set(0.35, 1.1, -0.25);
  root.add(anchor, mid, tip);
  root.updateWorldMatrix(true, true);
  return { root, anchor };
}

function syntheticFitClothModel(): ClothModel {
  return {
    ...syntheticClothModel(),
    nodes: [
      node('fit_anchor', [0, 0, 0], true),
      node('fit_left', [1, 0.15, 0.1]),
      node('fit_right', [0.15, 1, -0.1]),
      node('fit_ctrl', [0.55, 0.55, 0.35]),
    ],
    rods: [
      { a: 0, b: 1, min: 1.016, max: 1.016, relax: 0.9, weight: 0 },
      { a: 0, b: 2, min: 1.016, max: 1.016, relax: 0.9, weight: 0 },
      { a: 1, b: 2, min: 1.22, max: 1.22, relax: 0.8, weight: 0.5 },
    ],
    skelParents: [-1, 0, 0, 0],
    firstPositionDrivenNode: 4,
    fitMatrices: [{
      node: 3,
      endWeight: 3,
      beginDynamic: 0,
      bone: [0.55, 0.55, 0.35],
      boneRot: Q,
      center: [0.35, 0.35, 0],
      ctrl: 3,
    }],
    fitWeights: [
      { node: 0, weight: 2 },
      { node: 1, weight: 1 },
      { node: 2, weight: 1 },
    ],
  };
}

function syntheticStrayClothModel(): ClothModel {
  return {
    ...syntheticClothModel(),
    nodes: [
      node('stray_anchor', [0, 0, 0], true),
      node('stray_tip', [0.45, 0, 0]),
      node('stray_tail', [0.45, 0.2, 0]),
    ],
    rods: [
      { a: 1, b: 2, min: 0.2, max: 0.2, relax: 1, weight: 0.5 },
    ],
    strayRadii: [{ node: [1, 0], maxDist: 0.35, relax: 1 }],
    skelParents: [-1, 0, 1],
    staticNodeCount: 1,
    firstPositionDrivenNode: 3,
  };
}

function syntheticPlaneClothModel(): ClothModel {
  return {
    ...syntheticClothModel(),
    nodes: [
      node('plane_anchor', [0, 0, 0], true),
      node('plane_child', [0, -1, 0]),
      node('plane_spare', [1, 0, 0]),
    ],
    rods: [],
    collisionPlanes: [
      { ctrlParent: 0, childNode: 1, normal: [0, 1, 0], offset: 0, strength: 1 },
      { ctrlParent: 0, childNode: 9, normal: [0, 1, 0], offset: 100, strength: 1 },
    ],
    skelParents: [-1, 0, 0],
    firstPositionDrivenNode: 3,
  };
}

function syntheticJiggleClothModel(): ClothModel {
  return {
    ...syntheticClothModel(),
    nodes: [
      node('jiggle_anchor', [0, 0, 0], true),
      node('jiggle_dynamic', [0.4, 0.7, 0.2]),
      node('jiggle_spare', [1, 0, 0], true),
    ],
    rods: [],
    skelParents: [-1, 0, 0],
    staticNodeCount: 1,
    firstPositionDrivenNode: 3,
    jiggleBones: [{ node: 1, jiggleParent: 0, params: jiggleParams }],
  };
}

function syntheticFitRoot(): THREE.Group {
  const root = new THREE.Group();
  for (const [name, pos] of [
    ['fit_anchor', [0, 0, 0]],
    ['fit_left', [1, 0.15, 0.1]],
    ['fit_right', [0.15, 1, -0.1]],
    ['fit_ctrl', [0.55, 0.55, 0.35]],
  ] as const) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(pos);
    root.add(bone);
  }
  root.updateWorldMatrix(true, true);
  return root;
}

function syntheticStrayRoot(): THREE.Group {
  const root = new THREE.Group();
  for (const [name, pos] of [
    ['stray_anchor', [0, 0, 0]],
    ['stray_tip', [0.45, 0, 0]],
    ['stray_tail', [0.45, 0.2, 0]],
  ] as const) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(pos);
    root.add(bone);
  }
  root.updateWorldMatrix(true, true);
  return root;
}

function syntheticPlaneRoot(): THREE.Group {
  const root = new THREE.Group();
  for (const [name, pos] of [
    ['plane_anchor', [0, 0, 0]],
    ['plane_child', [0, -1, 0]],
    ['plane_spare', [1, 0, 0]],
  ] as const) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(pos);
    root.add(bone);
  }
  root.updateWorldMatrix(true, true);
  return root;
}

function syntheticJiggleRoot(): { root: THREE.Group; jiggle: THREE.Bone } {
  const root = new THREE.Group();
  const anchor = new THREE.Bone();
  const jiggle = new THREE.Bone();
  const spare = new THREE.Bone();
  anchor.name = 'jiggle_anchor';
  jiggle.name = 'jiggle_dynamic';
  spare.name = 'jiggle_spare';
  anchor.position.set(0, 0, 0);
  jiggle.position.set(0.4, 0.7, 0.2);
  spare.position.set(1, 0, 0);
  root.add(anchor, jiggle, spare);
  root.updateWorldMatrix(true, true);
  return { root, jiggle };
}

describe('createClothSimHarness', () => {
  it('samples moving body anchors without restoring them to the initial pose', () => {
    const { root, anchor } = syntheticRoot();
    const harness = createClothSimHarness(root, syntheticClothModel());
    for (let i = 0; i < 120; i++) {
      harness.step(CLOTH_TIMESTEP, (dt) => { anchor.position.x += dt; });
    }
    expect(anchor.position.x).toBeCloseTo(1, 8);
    expect(harness.metrics().simulationSteps).toBe(120);
    harness.dispose();
    expect(anchor.position.x).toBeCloseTo(1, 8);
  });

  it('does not write a simulated node-base rotation into an animated body anchor', () => {
    const { root, anchor } = syntheticRoot();
    const model = syntheticClothModel();
    model.nodeBases = [{ node: 0, x0: 0, x1: 1, y0: 0, y1: 2, qAdjust: Q }];
    const harness = createClothSimHarness(root, model);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    harness.step(CLOTH_TIMESTEP, () => { anchor.quaternion.copy(rotation); });
    expect(anchor.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
    harness.dispose();
    expect(anchor.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
  });

  it('restores unkeyed cloth channels before animation and on disposal', () => {
    const { root, anchor } = syntheticRoot();
    const tip = root.getObjectByName('cloth_tip')!;
    const initial = tip.position.clone();
    const mixer = new THREE.AnimationMixer(root);
    const clip = new THREE.AnimationClip('partial', 2, [
      new THREE.NumberKeyframeTrack('cloth_anchor.position[x]', [0, 2], [0, 2]),
      new THREE.QuaternionKeyframeTrack('cloth_tip.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 1, 0]),
    ]);
    mixer.clipAction(clip).play();
    const harness = createClothSimHarness(root, syntheticClothModel());
    for (let i = 0; i < 60; i++) {
      harness.step(CLOTH_TIMESTEP, (dt) => {
        expect(tip.position.distanceTo(initial)).toBeLessThan(1e-8);
        mixer.update(dt);
      });
    }
    expect(tip.position.distanceTo(initial)).toBeGreaterThan(0.01);
    const animatedRotation = tip.quaternion.clone();
    harness.dispose();
    expect(tip.position.distanceTo(initial)).toBeLessThan(1e-8);
    expect(tip.quaternion.angleTo(animatedRotation)).toBeLessThan(1e-7);
    expect(anchor.position.x).toBeCloseTo(0.5, 8);
    harness.dispose();
    expect(anchor.position.x).toBeCloseTo(0.5, 8);
  });

  it('runs the same animated simulation at 30, 60, 144 and 360 render fps', () => {
    const runs = [30, 60, 144, 360].map((fps) => {
      const { root, anchor } = syntheticRoot();
      const harness = createClothSimHarness(root, syntheticClothModel());
      const mixer = new THREE.AnimationMixer(root);
      const clip = new THREE.AnimationClip('move', 4, [
        new THREE.NumberKeyframeTrack('cloth_anchor.position[x]', [0, 4], [0, 2]),
      ]);
      mixer.clipAction(clip).play();
      for (let frame = 0; frame < fps * 2; frame++) {
        harness.step(1 / fps, (dt) => mixer.update(dt));
      }
      expect(anchor.position.x).toBeCloseTo(1, 8);
      expect(harness.metrics().simulationSteps).toBe(240);
      return root.children.map((bone) => bone.position.toArray()).flat();
    });
    for (const run of runs.slice(1)) {
      run.forEach((value, index) => expect(value).toBeCloseTo(runs[0][index], 8));
    }
  });

  it('accumulates short frames, ignores invalid time and treats a suspended tab as paused', () => {
    const { root, anchor } = syntheticRoot();
    const harness = createClothSimHarness(root, syntheticClothModel());
    const animate = (dt: number) => { anchor.position.x += dt; };
    harness.step(CLOTH_TIMESTEP / 2, animate);
    expect(anchor.position.x).toBe(0);
    harness.step(CLOTH_TIMESTEP / 2, animate);
    expect(anchor.position.x).toBeCloseTo(CLOTH_TIMESTEP, 10);
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2]) {
      harness.step(invalid, animate);
    }
    expect(harness.metrics().simulationSteps).toBe(1);
    harness.step(CLOTH_TIMESTEP, animate);
    expect(anchor.position.x).toBeCloseTo(2 * CLOTH_TIMESTEP, 10);
    const metrics = harness.step(0.2, animate);
    expect(metrics.simulationSteps).toBe(14);
    expect(metrics.finite).toBe(1);
  });

  it('can step zero time headlessly without moving the pinned node', () => {
    const { root, anchor } = syntheticRoot();
    const harness = createClothSimHarness(root, syntheticClothModel());
    const before = anchor.getWorldPosition(new THREE.Vector3());

    const metrics = harness.step(0);
    const after = anchor.getWorldPosition(new THREE.Vector3());

    expect(metrics).toMatchObject({
      finite: 1,
      nodeCount: 3,
      kinematicCount: 1,
    });
    expect(metrics.maxFrameMotion).toBeLessThan(0.02);
    expect(after.distanceTo(before)).toBeCloseTo(0, 8);
  });

  it('stays finite and bounded over a small 60fps run', () => {
    const { root } = syntheticRoot();
    const harness = createClothSimHarness(root, syntheticClothModel());
    let metrics = harness.metrics();

    for (let i = 0; i < 600; i++) {
      metrics = harness.step(1 / 60);
    }

    expect(metrics.finite).toBe(1);
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.kinematicCount).toBe(1);
    expect(metrics.rmse).toBeLessThan(0.5);
    expect(metrics.maxDistanceFromInit).toBeLessThan(1);
    expect(metrics.maxFrameMotion).toBeLessThan(0.05);
  });

  it('keeps a FitMatrix control bounded while source nodes settle', () => {
    const root = syntheticFitRoot();
    const harness = createClothSimHarness(root, syntheticFitClothModel());
    let metrics = harness.metrics();

    for (let i = 0; i < 180; i++) {
      metrics = harness.step(1 / 60);
    }

    expect(metrics.finite).toBe(1);
    expect(metrics.nodeCount).toBe(4);
    expect(metrics.kinematicCount).toBe(2);
    expect(metrics.maxDistanceFromInit).toBeLessThan(0.75);
    expect(metrics.maxFrameMotion).toBeLessThan(0.04);
  });

  it('keeps a stray-radius clamp finite and bounded over repeated steps', () => {
    const root = syntheticStrayRoot();
    const harness = createClothSimHarness(root, syntheticStrayClothModel());
    let metrics = harness.metrics();

    for (let i = 0; i < 240; i++) {
      metrics = harness.step(1 / 60);
    }

    expect(metrics.finite).toBe(1);
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.kinematicCount).toBe(1);
    expect(metrics.maxDistanceFromInit).toBeLessThan(0.75);
    expect(metrics.maxFrameMotion).toBeLessThan(0.12);
  });

  it('applies a collision plane through the solver pass', () => {
    const root = syntheticPlaneRoot();
    const child = root.children.find((obj) => obj.name === 'plane_child') as THREE.Bone;
    const harness = createClothSimHarness(root, syntheticPlaneClothModel());

    const metrics = harness.step(CLOTH_TIMESTEP);
    root.updateWorldMatrix(true, true);

    expect(metrics.finite).toBe(1);
    expect(child.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0, 6);
  });

  it('keeps a param-bearing jiggle node on its target under gravity', () => {
    const { root, jiggle } = syntheticJiggleRoot();
    const expected = jiggle.getWorldPosition(new THREE.Vector3());
    const harness = createClothSimHarness(root, syntheticJiggleClothModel());
    let metrics = harness.metrics();

    for (let i = 0; i < 180; i++) {
      metrics = harness.step(1 / 60);
    }

    root.updateWorldMatrix(true, true);
    expect(metrics.finite).toBe(1);
    expect(metrics.kinematicCount).toBe(3);
    expect(metrics.maxDistanceFromTarget).toBeLessThan(1e-6);
    expect(jiggle.getWorldPosition(new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-6);
  });
});
