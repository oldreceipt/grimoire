import * as THREE from 'three';
import type { ClothKelagerBend, ClothTwist, Vec3, Vec4 } from './feModel';

// Compiled coefficients, not authoring strengths. See docs/source2-preview-physics.md.
const unit = (value: number) => Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
const _delta = new THREE.Vector3();

export function applyGoalDampedAttraction(
  position: THREE.Vector3,
  previous: THREE.Vector3,
  goal: THREE.Vector3,
  force: number,
  vertex: number,
): void {
  const attraction = unit(force);
  if (attraction > 0.9999) {
    position.copy(goal);
    previous.copy(goal);
    return;
  }
  position.lerp(goal, attraction);
  previous.lerp(position, unit(vertex));
}

export function applyRawAttraction(
  position: THREE.Vector3,
  previous: THREE.Vector3,
  goal: THREE.Vector3,
  force: number,
  vertex: number,
  dt: number,
): void {
  const p = unit(vertex * dt);
  const f = Number.isFinite(force) ? Math.max(0, force) * dt * 2 : 0;
  _delta.copy(goal).sub(position);
  previous.addScaledVector(_delta, p * (1 - p));
  position.addScaledVector(_delta, p + f);
}

interface BendNode {
  pos: THREE.Vector3;
  kinematic: boolean;
}

export function projectKelagerBend(nodes: readonly BendNode[], bend: ClothKelagerBend): void {
  const a = nodes[bend.node[0]];
  const b = nodes[bend.node[1]];
  const c = nodes[bend.node[2]];
  if (!a || !b || !c) return;
  _delta.copy(a.pos).multiplyScalar(2).sub(b.pos).sub(c.pos).multiplyScalar(1 / 3);
  const height = _delta.length();
  if (height <= bend.height0 || height < 1e-12) return;
  _delta.multiplyScalar(1 - bend.height0 / height);
  // Signed shares already include the compiler's mass weighting.
  if (!a.kinematic) a.pos.addScaledVector(_delta, bend.weight[0]);
  if (!b.kinematic) b.pos.addScaledVector(_delta, bend.weight[1]);
  if (!c.kinematic) c.pos.addScaledVector(_delta, bend.weight[2]);
}

export interface TwistNode {
  pos: THREE.Vector3;
  initPos: Vec3;
  initRot: Vec4;
  solvedRot: THREE.Quaternion;
  targetRot: THREE.Quaternion;
}

const _axis = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _restEnd = new THREE.Quaternion();
const _restOrient = new THREE.Quaternion();
const _desired = new THREE.Quaternion();
const _align = new THREE.Quaternion();
const _error = new THREE.Quaternion();
const _twist = new THREE.Quaternion();
const _swing = new THREE.Quaternion();
const _weightedTwist = new THREE.Quaternion();

/** Orient an ordered rope from its animated X axes and solved segment directions. */
export function reconstructClothRope(
  nodes: readonly TwistNode[],
  chain: readonly number[],
  rotationNodes: ReadonlySet<number>,
): void {
  if (chain.length < 2) return;
  const first = nodes[chain[0]];
  const second = nodes[chain[1]];
  _axis.set(1, 0, 0).applyQuaternion(_restOrient.fromArray(first.initRot).normalize());
  _direction.fromArray(second.initPos).sub(_delta.fromArray(first.initPos));
  const sign = _axis.dot(_direction) < 0 ? -1 : 1;

  for (let i = 0; i < chain.length; i++) {
    if (!rotationNodes.has(chain[i])) continue;
    const node = nodes[chain[i]];
    if (i === chain.length - 1 && chain.length > 2) {
      node.solvedRot.copy(nodes[chain[i - 1]].solvedRot);
      continue;
    }
    const start = Math.min(i, chain.length - 2);
    _direction.copy(nodes[chain[start + 1]].pos).sub(nodes[chain[start]].pos).multiplyScalar(sign);
    // Collapsed links keep their animated orientation, including two-node tips.
    node.solvedRot.copy(node.targetRot);
    if (_direction.lengthSq() <= 0.03 * 0.03) continue;
    _axis.set(1, 0, 0).applyQuaternion(node.targetRot).normalize();
    _align.setFromUnitVectors(_axis, _direction.normalize());
    node.solvedRot.premultiply(_align).normalize();
  }
}

function blendIdentity(q: THREE.Quaternion, amount: number): THREE.Quaternion {
  return q.set(q.x * amount, q.y * amount, q.z * amount, 1 + (q.w - 1) * amount).normalize();
}

/** Reconstruct one directed link, preserving the authored local axis and rest twist. */
export function reconstructClothTwist(nodes: readonly TwistNode[], link: ClothTwist): void {
  const node = nodes[link.nodeOrient];
  const end = nodes[link.nodeEnd];
  if (!node || !end) return;
  if (node === end) {
    _axis.set(0, 0, 0);
    _desired.copy(node.targetRot);
  } else {
    _axis.fromArray(end.initPos).sub(_direction.fromArray(node.initPos));
    _direction.copy(end.pos).sub(node.pos);
    if (_axis.lengthSq() < 1e-12 || _direction.lengthSq() < 1e-12) return;
    _restOrient.fromArray(node.initRot).normalize();
    _restEnd.fromArray(end.initRot).normalize();
    _axis.normalize().applyQuaternion(_restOrient.clone().invert());
    _desired.copy(end.solvedRot).multiply(_restEnd.invert()).multiply(_restOrient).normalize();
    _direction.normalize().applyQuaternion(_desired.clone().invert());
    _align.setFromUnitVectors(_axis, _direction);
    _desired.multiply(_align).normalize();
  }
  if (node.solvedRot.dot(_desired) < 0) {
    _desired.set(-_desired.x, -_desired.y, -_desired.z, -_desired.w);
  }
  const twist = unit(link.twistRelax);
  const swing = unit(link.swingRelax);
  if (twist === swing) {
    node.solvedRot.set(
      THREE.MathUtils.lerp(node.solvedRot.x, _desired.x, twist),
      THREE.MathUtils.lerp(node.solvedRot.y, _desired.y, twist),
      THREE.MathUtils.lerp(node.solvedRot.z, _desired.z, twist),
      THREE.MathUtils.lerp(node.solvedRot.w, _desired.w, twist),
    ).normalize();
    return;
  }
  _error.copy(node.solvedRot).invert().multiply(_desired);
  const along = _error.x * _axis.x + _error.y * _axis.y + _error.z * _axis.z;
  _twist.set(_axis.x * along, _axis.y * along, _axis.z * along, _error.w);
  // The compiled relaxation blends the unnormalized twist projection.
  blendIdentity(_weightedTwist.copy(_twist), twist);
  _swing.copy(_error).multiply(_twist.conjugate());
  blendIdentity(_swing, swing);
  node.solvedRot.multiply(_swing.multiply(_weightedTwist)).normalize();
}
