import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseFeModel } from '../lib/feModel';
import { CLOTH_TIMESTEP, createClothSimHarness, type ClothSimHarness } from '../lib/useClothSim';

function element<T extends HTMLElement>(id: string, ctor: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof ctor)) throw new Error(`Missing preview element: ${id}`);
  return value;
}
const viewport = element('viewport', HTMLDivElement);
const status = element('status', HTMLParagraphElement);
const metrics = element('metrics', HTMLPreElement);
const clipSelect = element('clip', HTMLSelectElement);
const physics = element('physics', HTMLInputElement);
const frozen = element('frozen', HTMLInputElement);
const bonesToggle = element('skeleton', HTMLInputElement);
const play = element('play', HTMLButtonElement);
const view = element('view', HTMLSelectElement);
const checks = element('checks', HTMLButtonElement);
const checksResult = element('checks-result', HTMLPreElement);
const checksSummary = element('checks-summary', HTMLElement);
const inputs = document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input');
inputs.forEach((input) => { input.disabled = true; });

async function main() {
  const assets = '/.codex-run/source2-physics/seven';
  const [gltf, raw, metadata] = await Promise.all([
    new GLTFLoader().loadAsync(`${assets}/model.glb`),
    fetch(`${assets}/cloth.json`).then((response) => response.json()),
    fetch(`${assets}/metadata.json`).then((response) => response.json()),
  ]);
  const model = parseFeModel(raw);
  if (!model) throw new Error('Export did not contain a FeModel.');
  const root = gltf.scene;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#202633');
  scene.add(root, new THREE.HemisphereLight(0xddeaff, 0x474347, 2.4));
  const key = new THREE.DirectionalLight(0xffedd6, 3.5);
  key.position.set(4, 6, 3);
  const fill = new THREE.DirectionalLight(0x9cbeff, 2);
  fill.position.set(-4, 3, -3);
  scene.add(key, fill);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  viewport.append(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.25, 0);
  const updateCamera = () => {
    camera.position.set(view.value === 'Side' ? 6.2 : 0, 1.5, view.value === 'Back' ? -6.2 : view.value === 'Side' ? 0 : 6.2);
    controls.update();
  };
  updateCamera();
  view.addEventListener('change', updateCamera);
  const resize = new ResizeObserver(() => {
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  });
  resize.observe(viewport);
  const grid = new THREE.GridHelper(8, 16, 0x647086, 0x343f50);
  scene.add(grid);
  const skeleton = new THREE.SkeletonHelper(root);
  skeleton.visible = false;
  scene.add(skeleton);
  bonesToggle.addEventListener('change', () => { skeleton.visible = bonesToggle.checked; });
  const bind = new Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3 }>();
  let skinnedMeshes = 0;
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) { object.frustumCulled = false; skinnedMeshes++; }
    if (object instanceof THREE.Bone) bind.set(object, { position: object.position.clone(), rotation: object.quaternion.clone(), scale: object.scale.clone() });
  });
  for (const clip of gltf.animations) clipSelect.add(new Option(clip.name, clip.name));
  const mixer = new THREE.AnimationMixer(root);
  let harness: ClothSimHarness | null = null;
  let elapsed = 0;
  let playing = false;
  let checking = false;
  let checkReport: unknown = null;
  const matched = model.nodes.filter((node) => root.getObjectByName(node.name)).length;
  const reset = () => {
    harness?.dispose();
    mixer.stopAllAction();
    for (const [object, pose] of bind) {
      object.position.copy(pose.position);
      object.quaternion.copy(pose.rotation);
      object.scale.copy(pose.scale);
    }
    root.updateWorldMatrix(true, true);
    harness = physics.checked ? createClothSimHarness(root, model) : null;
    mixer.time = 0;
    const clip = gltf.animations.find((item) => item.name === clipSelect.value);
    if (clip) mixer.clipAction(clip).reset().play();
    mixer.update(0);
    elapsed = 0;
  };
  const advance = (dt: number) => {
    const animate = (delta: number) => { if (!frozen.checked) mixer.update(delta); };
    if (harness) harness.step(dt, animate);
    else animate(dt);
    elapsed += dt;
    root.updateWorldMatrix(true, true);
  };
  const report = () => ({ metadata, clip: clipSelect.value, physics: physics.checked, frozen: frozen.checked,
    elapsed, matched, controls: model.nodes.length, skinnedMeshes, metrics: harness?.metrics() ?? null, checks: checkReport });
  clipSelect.addEventListener('change', reset);
  physics.addEventListener('change', reset);
  element('reset', HTMLButtonElement).addEventListener('click', reset);
  play.addEventListener('click', () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; });
  element('step', HTMLButtonElement).addEventListener('click', () => { for (let i = 0; i < 120; i++) advance(CLOTH_TIMESTEP); });
  element('settle', HTMLButtonElement).addEventListener('click', () => {
    frozen.checked = true;
    playing = false;
    play.textContent = 'Play';
    for (let i = 0; i < 1200; i++) advance(CLOTH_TIMESTEP);
  });
  const pose = () => model.nodes.map((node) => {
    const bone = root.getObjectByName(node.name);
    return { position: bone?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(),
      rotation: bone?.getWorldQuaternion(new THREE.Quaternion()).normalize() ?? new THREE.Quaternion() };
  });
  const poseDifference = (before: ReturnType<typeof pose>, after: ReturnType<typeof pose>, count = before.length) => ({
    position: Math.max(0, ...before.slice(0, count).map((node, index) => node.position.distanceTo(after[index].position))),
    angle: Math.max(0, ...before.slice(0, count).map((node, index) => node.rotation.angleTo(after[index].rotation))),
  });
  checks.addEventListener('click', async () => {
    if (checking) return;
    checking = true;
    playing = false;
    play.textContent = 'Play';
    inputs.forEach((input) => { input.disabled = true; });
    const cases = [];
    try {
      for (const clip of gltf.animations) {
        clipSelect.value = clip.name;
        frozen.checked = false;
        physics.checked = false;
        reset();
        for (let i = 0; i < 600; i++) advance(CLOTH_TIMESTEP);
        const animatedPose = pose();
        let reference: ReturnType<typeof pose> | undefined;
        for (const fps of [30, 60, 144, 360]) {
          physics.checked = true;
          reset();
          checksResult.textContent = `Checking ${clip.name} at ${fps} FPS...`;
          checksSummary.textContent = checksResult.textContent;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const start = performance.now();
          for (let i = 0; i < 5 * fps; i++) advance(1 / fps);
          const duration = performance.now() - start;
          const solvedPose = pose();
          reference ??= solvedPose;
          cases.push({ clip: clip.name, fps, milliseconds: duration,
            frameRateDifference: poseDifference(reference, solvedPose),
            bodyAnchorDifference: poseDifference(animatedPose, solvedPose, model.rotLockStaticNodeCount),
            staticPositionError: poseDifference(animatedPose, solvedPose, model.staticNodeCount).position,
            metrics: harness?.metrics() });
        }
      }
      frozen.checked = true;
      for (let i = 0; i < 1200; i++) advance(CLOTH_TIMESTEP);
      const settledPose = pose();
      for (let i = 0; i < 120; i++) advance(CLOTH_TIMESTEP);
      const after = pose();
      const damped = model.nodes.map((node, index) => ({ node, index }))
        .filter(({ node }) => !node.pinned && node.animVertex > 0).map(({ index }) => index);
      const passed = cases.filter((test) => matched === model.nodes.length
        && test.metrics?.finite === 1 && test.metrics.simulationSteps === 600
        && test.frameRateDifference.position < 1e-7 && test.frameRateDifference.angle < 1e-6
        && test.bodyAnchorDifference.position < 1e-7 && test.bodyAnchorDifference.angle < 1e-6
        && test.staticPositionError < 1e-7).length;
      checkReport = {
        poseChecks: { passed, total: cases.length },
        units: { posePosition: 'meters', poseAngle: 'radians', solverDistance: 'Source units' },
        cases,
        frozenPoseChangeAfterTenSeconds: poseDifference(settledPose, after),
        dampedClothChangeAfterTenSeconds: poseDifference(damped.map((index) => settledPose[index]), damped.map((index) => after[index])),
        settled: harness?.metrics(),
        note: 'Zero-damping chains may keep swinging. These checks do not establish in-game visual parity.',
      };
      checksResult.textContent = JSON.stringify(checkReport, null, 2);
      checksSummary.textContent = `${passed}/${cases.length} pose and anchor checks passed`;
    } catch (error) {
      checksResult.textContent = error instanceof Error ? error.message : String(error);
      checksSummary.textContent = 'Checks failed. Expand for details.';
    } finally {
      checking = false;
      inputs.forEach((input) => { input.disabled = false; });
    }
  });
  element('report', HTMLButtonElement).addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `seven-${clipSelect.value}-physics.json`; link.click();
    URL.revokeObjectURL(url);
  });
  reset();
  inputs.forEach((input) => { input.disabled = false; });
  let last = performance.now();
  renderer.setAnimationLoop((time) => {
    if (playing && !checking) advance(Math.min((time - last) / 1000, 0.1));
    last = time;
    controls.update();
    renderer.render(scene, camera);
    status.textContent = `${elapsed.toFixed(2)} seconds | ${matched}/${model.nodes.length} controls matched | ${skinnedMeshes} skinned meshes`;
    metrics.textContent = JSON.stringify(harness?.metrics() ?? { physics: 'off' }, null, 2);
  });
}
void main().catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); console.error(error); });
