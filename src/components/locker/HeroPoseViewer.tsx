import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRCubeTextureLoader } from 'three/examples/jsm/loaders/HDRCubeTextureLoader.js';
import { Loader2 } from 'lucide-react';
import { getAssetPath } from '../../lib/assetPath';
import {
  getHeroPoseInfo,
  exportHeroPose,
  getRiggedHeroPose,
  exportRiggedHeroPose,
  getHeroClothModel,
  getHeroEffectInfo,
  exportHeroEffect,
  previewTrippySprite,
} from '../../lib/api';
import { loadGltfPreview } from '../../lib/loadGltfPreview';
import { ParticleEffect } from './ParticleEffect';
import type { FxDescriptor } from './fxDescriptor';
import { useClothSim, type FeModel } from '../../lib/useClothSim';
import ClothTuner from './ClothTuner';
import {
  isNprMaterial,
  wrapMaterialWithNpr,
  buildOutlineShell,
  unwrapNprBase,
  summarizeNprScene,
  applySource2MaterialHints,
  type NprWrapResult,
} from '../../lib/source2NprMaterial';
import type { HeroPoseSkinSource } from '../../types/portrait';
import type { TrippySpriteResult } from '../../types/mod';
import type { TrippyPreview } from '../../stores/trippyPreviewStore';

/**
 * Live 3D preview of a hero's menu pose for the Locker's per-hero view.
 *
 * The GLB is a static posed still produced on demand by the bundled
 * `vpkmerge model export --pose` (exportHeroPose) and served from the user's
 * library via the privileged `grimoire-hero:` scheme. It carries no skeleton,
 * skin, or clips and has the toon-outline / glow halo shells stripped, so it
 * loads as plain meshes (no SkinnedMesh, no skin-strip needed here).
 *
 * Interactive: drag to orbit, scroll to zoom. Loading uses three's GLTFLoader
 * directly (no @react-three/drei): each mount loads its own GLB once and
 * disposes the scene on unmount.
 */

const HERO_POSE_SCHEME = 'grimoire-hero';

// Six faces of a real Deadlock skybox IBL probe (the overcast probe: bright and
// neutral, not the moody dusk one), baked from the game's HDR cubemap to Radiance
// .hdr by `vpkmerge cubemap`. Order is the loader's expected [+X, -X, +Y, -Y, +Z,
// -Z]. Image-based lighting from this makes metallic and glossy surfaces read like
// in-game instead of dead-flat under bare directionals.
const IBL_FACES = [
  getAssetPath('/ibl/px.hdr'),
  getAssetPath('/ibl/nx.hdr'),
  getAssetPath('/ibl/py.hdr'),
  getAssetPath('/ibl/ny.hdr'),
  getAssetPath('/ibl/pz.hdr'),
  getAssetPath('/ibl/nz.hdr'),
];

// Rigged (animated, skinned) preview is gated OFF for now: the idle clip is WIP
// and too many heroes fall back to a default A-pose, so the static `--pose` menu
// pose stays the default. The rigged backend + viewer path remain in place; flip
// this to true to bring them back once the animation is improved.
const USE_RIGGED_PREVIEW: boolean = false;

// Source 2 NPR cel/rim/tint restyle layered ON TOP of the PMREM IBL + ACES
// tonemap output (not a replacement pass). Gated per-material on userData.morphic
// + F_USE_NPR_LIGHTING, so heroes/materials without that data render exactly as
// today. This flag is the global kill switch; flip to true to ship cel+rim+tint.
const USE_NPR_PREVIEW: boolean = false;

// Inverted-hull solid-color outline (Source 2's method; vpkmerge strips the
// engine shells from the export, so we regenerate them). Independent flag, default
// off: the skinned shell binding is the highest-risk piece and the cel+rim+tint
// already deliver the bulk of the in-game look. Honors per-material outline data.
const USE_NPR_OUTLINE: boolean = false;

// Broader Source 2 material approximations for shader-heavy heroes (glass,
// translucency/additive, self-illum, unlit, sheen). Kept separate from the NPR
// CSM so shader experiments can be toggled without touching the default path.
const USE_SOURCE2_SHADER_HINTS: boolean = false;

// Ambient particle FX overlay (the effects-preview axis). Default off: current
// shader work deliberately avoids effects rendering, which needs separate CP /
// child-system plumbing. Dev opt-in: localStorage grimoire.preview.effects=1.
const USE_EFFECT_PREVIEW: boolean = false;

function previewFlag(name: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(name);
  if (raw === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function effectDescriptorUrl(key: string): string {
  return `${HERO_POSE_SCHEME}://m/${encodeURIComponent(key)}/effect.json`;
}

function effectTextureBaseUrl(key: string): string {
  return `${HERO_POSE_SCHEME}://m/${encodeURIComponent(key)}/effect-tex/`;
}

// Turntable rotation rate (rad/s). The spin pauses while the user holds (orbits)
// the model with the mouse.
const SPIN_SPEED = 0.25;

function meshUrlFor(key: string, mtimeMs: number | null): string {
  // The key contains `::` (and a `/` for overflow skins), which a standard
  // scheme forbids in the host, so carry it as a single encoded path segment
  // under a fixed `m` host.
  return `${HERO_POSE_SCHEME}://m/${encodeURIComponent(key)}/model.glb?v=${mtimeMs ?? 0}`;
}

function riggedMeshUrlFor(key: string, mtimeMs: number | null): string {
  return `${HERO_POSE_SCHEME}://m/${encodeURIComponent(key)}/model-rigged.glb?v=${mtimeMs ?? 0}`;
}

/** Free a loaded scene's GPU resources (geometry, materials, textures,
 *  skeletons). */
function disposeScene(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      // Releases the bone texture / internal buffers held by the skeleton.
      skinned.skeleton.dispose?.();
    }
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      [sm.map, sm.normalMap, sm.roughnessMap, sm.metalnessMap, sm.emissiveMap, sm.aoMap].forEach(
        (t) => t?.dispose()
      );
      m?.dispose();
    }
  });
}

/** Enable per-vertex COLOR multiply wherever the attribute exists. Pure
 *  read/write of an existing material flag, so material identity is untouched
 *  (the NPR CustomShaderMaterial wrap still finds the same instances). */
function enableVertexColors(scene: THREE.Object3D): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.color) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm && !sm.vertexColors) {
        sm.vertexColors = true;
        sm.needsUpdate = true;
      }
    }
  });
}

/** Pick the idle clip to play. The export already ships exactly one clip
 *  (primary_stand_idle), so this is a thin guard: prefer the named idle, else
 *  the first non-trivial clip, else clip[0]; null if there are no clips at all
 *  (mesh-skin / clipless hero -> render skinned bind pose, no mixer). */
function pickIdleClip(clips: THREE.AnimationClip[]): THREE.AnimationClip | null {
  if (clips.length === 0) return null;
  const named = clips.find((c) => c.name === 'primary_stand_idle' && c.duration > 0.001);
  if (named) return named;
  const animated = clips.find((c) => c.duration > 0.001);
  return animated ?? clips[0];
}

/** Shared pointer-interaction state between OrbitControls and the model group:
 *  the turntable pauses while `dragging`. A mutable ref so it updates without
 *  re-rendering. */
type TurntableInteraction = { dragging: boolean; paused: boolean };

/** Slow turntable auto-rotation on the model group, paused while the user holds
 *  (orbits) the model with the mouse. */
function useTurntable(
  groupRef: RefObject<THREE.Group | null>,
  interaction: RefObject<TurntableInteraction>
): void {
  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g || interaction.current.dragging || interaction.current.paused) return;
    g.rotation.y += delta * SPIN_SPEED;
  });
}

/** The posed figure, normalized to a consistent height and centered, with a
 *  slow idle turntable. */
function PosedModel({
  scene,
  interaction,
  effect,
}: {
  scene: THREE.Object3D;
  interaction: RefObject<TurntableInteraction>;
  effect?: EffectMount | null;
}) {
  const groupRef = useRef<THREE.Group>(null);

  // Normalize by the largest dimension so every hero fills the frame the same
  // regardless of native model scale, and recenter on the origin.
  const norm = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 2.0 / maxDim : 1;
    return { scale, center };
  }, [scene]);

  // Per-vertex COLOR multiply where present (skin tone / accents render flat
  // white without it); see enableVertexColors.
  useEffect(() => {
    enableVertexColors(scene);
  }, [scene]);

  useTurntable(groupRef, interaction);

  return (
    <group ref={groupRef} scale={norm.scale}>
      <group position={[-norm.center.x, -norm.center.y, -norm.center.z]}>
        <primitive object={scene} />
        {effect && (
          <ParticleEffect descriptor={effect.descriptor} textureBaseUrl={effect.baseUrl} />
        )}
      </group>
    </group>
  );
}

/** The descriptor + bundled-texture base URL for the ambient FX overlay mounted
 *  inside a model's normalized group (so it shares the preview scale/centering). */
interface EffectMount {
  descriptor: FxDescriptor;
  baseUrl: string;
}

/** The skinned figure, idle clip driven by an AnimationMixer. gltf.scene is
 *  rendered AS-IS under wrapper groups so the SkinnedMesh's bone references stay
 *  valid (no reparenting, no clone). The normalize box is computed ONCE from the
 *  bind pose so the model does not breathe/drift as the clip plays. */
function RiggedModel({
  scene,
  clips,
  interaction,
  clothModel,
  effect,
}: {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  interaction: RefObject<TurntableInteraction>;
  clothModel: FeModel | null;
  effect?: EffectMount | null;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  // Normalize from the BIND/rest pose, once. Force the skeleton to bind pose and
  // flush world matrices first so the AABB is the true rest extent and does not
  // change frame to frame.
  const norm = useMemo(() => {
    scene.traverse((obj) => {
      const s = obj as THREE.SkinnedMesh;
      if (s.isSkinnedMesh && s.skeleton) s.skeleton.pose();
    });
    scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 2.0 / maxDim : 1;
    return { scale, center };
  }, [scene]);

  useEffect(() => {
    enableVertexColors(scene);
  }, [scene]);

  // Build the mixer + play the idle clip once per scene. Kept in a ref so React
  // re-renders never restart playback.
  useEffect(() => {
    const clip = pickIdleClip(clips);
    if (!clip) return; // no clip -> stays at bind pose (still a valid render).
    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.reset().play();
    return () => {
      action.stop();
      mixer.stopAllAction();
      mixer.uncacheClip(clip);
      mixer.uncacheRoot(scene);
      mixerRef.current = null;
    };
  }, [scene, clips]);

  // Cloth bones swing under gravity + turntable inertia, AFTER the mixer poses
  // the skeleton, and collide with the body capsules/spheres from the FeModel
  // sidecar (null on a model with no cloth -> the sim no-ops).
  const clothStep = useClothSim(scene, clothModel);
  useFrame((_, delta) => {
    mixerRef.current?.update(delta);
    clothStep(delta);
  });

  useTurntable(groupRef, interaction);

  return (
    <group ref={groupRef} scale={norm.scale}>
      <group position={[-norm.center.x, -norm.center.y, -norm.center.z]}>
        <primitive object={scene} />
        {effect && (
          <ParticleEffect descriptor={effect.descriptor} textureBaseUrl={effect.baseUrl} />
        )}
      </group>
    </group>
  );
}

/** Mouse orbit + zoom, damped. Auto-rotation lives on the model group so the
 *  controls don't fight it; dragging just reorients the camera. */
function Controls({ interaction }: { interaction: RefObject<TurntableInteraction> }) {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.enablePan = true; // right-drag pans (moves) the model
    controls.minDistance = 1.6;
    controls.maxDistance = 6;
    controls.target.set(0, 0, 0);
    // OrbitControls ignores the wheel whenever a drag is active (state !== NONE),
    // so we handle zoom ourselves to keep scroll working while holding the mouse.
    controls.enableZoom = false;
    controlsRef.current = controls;
    // Pause the turntable while held; kick a wobble on release (maglev feel).
    const onStart = () => {
      interaction.current.dragging = true;
    };
    const onEnd = () => {
      interaction.current.dragging = false;
    };
    // Dolly toward/away from the target in any state, clamped to min/max distance.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const offset = camera.position.clone().sub(controls.target);
      const dist = THREE.MathUtils.clamp(
        offset.length() * (e.deltaY > 0 ? 1.1 : 1 / 1.1),
        controls.minDistance,
        controls.maxDistance
      );
      camera.position.copy(controls.target).add(offset.setLength(dist));
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);
    gl.domElement.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      gl.domElement.removeEventListener('wheel', onWheel);
      controlsRef.current = null;
      controls.dispose();
    };
  }, [camera, gl, interaction]);
  // enableDamping requires update() every frame: without it the inertial glide
  // after a drag never runs (and on some three builds the orbit barely tracks).
  // R3F's default frameloop renders every frame, so this update() always runs.
  useFrame(() => controlsRef.current?.update());
  return null;
}

/** Image-based lighting from the baked Deadlock dusk probe. Loads the six .hdr
 *  faces once, runs them through PMREM, and assigns the result as
 *  `scene.environment` so every MeshStandardMaterial gets real reflections and
 *  ambient instead of dead-flat directional-only shading. The PMREM target is
 *  bound to this Canvas's GL context, so it is generated per-mount (the per-hero
 *  view shows a single viewer); SoulContainerViewer would want a shared probe. */
function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    let disposed = false;
    const pmrem = new THREE.PMREMGenerator(gl);
    let envRT: THREE.WebGLRenderTarget | null = null;
    new HDRCubeTextureLoader()
      .setDataType(THREE.HalfFloatType)
      .load(IBL_FACES, (cube) => {
        if (disposed) {
          cube.dispose();
          pmrem.dispose();
          return;
        }
        envRT = pmrem.fromCubemap(cube);
        scene.environment = envRT.texture;
        cube.dispose();
        pmrem.dispose();
      });
    return () => {
      disposed = true;
      scene.environment = null;
      envRT?.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** Live trippy-skin preview: paints the body meshes with the trippy pattern and
 *  animates it. The sprite from `previewTrippySprite` is a horizontal frame
 *  strip (the same asset the 2D swatch flipbooks); we draw the current frame
 *  onto an offscreen canvas and feed it as a tiling CanvasTexture, so the paint
 *  flows on the model. This is an approximation of the engine's UV-scroll shader
 *  (body only; the GLB carries no weapon mesh), not the exact bake.
 *
 *  Originals are captured per material and restored on unmount, so toggling the
 *  preview off (or closing the panel) returns the model to its real skin. */
function TrippyPaint({
  scene,
  sprite,
  fps = 12,
  repeat = 2,
}: {
  scene: THREE.Object3D;
  sprite: TrippySpriteResult;
  fps?: number;
  repeat?: number;
}) {
  const texRef = useRef<THREE.CanvasTexture | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const startRef = useRef<number | null>(null);
  const lastFrameRef = useRef(-1);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = sprite.size;
    canvas.height = sprite.size;
    canvasRef.current = canvas;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.colorSpace = THREE.SRGBColorSpace;
    texRef.current = tex;

    const img = new Image();
    img.src = sprite.dataUrl;
    imgRef.current = img;

    // Unique materials so meshes sharing one material are touched once.
    const originals = new Map<THREE.MeshStandardMaterial, { map: THREE.Texture | null; color: number }>();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm || originals.has(sm)) continue;
        originals.set(sm, { map: sm.map ?? null, color: sm.color?.getHex() ?? 0xffffff });
        sm.map = tex;
        sm.color?.setHex(0xffffff);
        sm.needsUpdate = true;
      }
    });

    return () => {
      for (const [sm, original] of originals) {
        sm.map = original.map;
        sm.color?.setHex(original.color);
        sm.needsUpdate = true;
      }
      originals.clear();
      tex.dispose();
      startRef.current = null;
      lastFrameRef.current = -1;
    };
  }, [scene, sprite, repeat]);

  useFrame((state) => {
    const tex = texRef.current;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!tex || !canvas || !img || !img.complete || img.naturalWidth === 0) return;
    const now = state.clock.elapsedTime;
    if (startRef.current === null) startRef.current = now;
    const frame = Math.floor((now - startRef.current) * fps) % sprite.frames;
    if (frame === lastFrameRef.current) return;
    lastFrameRef.current = frame;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      img,
      frame * sprite.size,
      0,
      sprite.size,
      sprite.size,
      0,
      0,
      sprite.size,
      sprite.size
    );
    tex.needsUpdate = true;
  });

  return null;
}

/** Wraps every NPR-eligible material in `scene` with a CSM that layers the
 *  Deadlock cel ramp + rim + tint mask on the lit PBR output. Side-effects the
 *  shared scene graph in place (like the model effects / TrippyPaint), so one
 *  instance serves both PosedModel and RiggedModel (both render the same scene).
 *  Restores originals and disposes its CSM wrappers + mask clones on cleanup.
 *  No-op when disabled or when no material carries morphic data. */
function NprMaterials({
  scene,
  enabled,
  outline,
  tint,
}: {
  scene: THREE.Object3D;
  enabled: boolean;
  outline: boolean;
  tint: THREE.Color | null;
}) {
  // Live handle to the wraps so the tint effect can poke uniforms without a rebuild.
  const wrapsRef = useRef<Map<THREE.Material, NprWrapResult>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const wraps = new Map<THREE.Material, NprWrapResult>();
    const restore: Array<() => void> = [];

    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const skinned = obj as THREE.SkinnedMesh;
      if (!mesh.isMesh && !skinned.isSkinnedMesh) return;

      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      list.forEach((mat, i) => {
        if (!mat || !isNprMaterial(mat)) return;
        // Idempotency: a CSM stamps `__csm` on the instance it copies from, so a
        // StrictMode double-invoke never double-wraps.
        if ((mat as { __csm?: unknown }).__csm) return;

        let w = wraps.get(mat);
        if (!w) {
          const built = wrapMaterialWithNpr(mat, undefined, tint);
          if (!built) return;
          w = built;
          wraps.set(mat, w);
        }
        const csm = w.material;
        if (Array.isArray(mesh.material)) {
          const arr = mesh.material;
          arr[i] = csm;
          restore.push(() => {
            arr[i] = mat;
            unwrapNprBase(mat);
          });
        } else {
          mesh.material = csm;
          restore.push(() => {
            mesh.material = mat;
            unwrapNprBase(mat);
          });
        }
      });

      if (outline) {
        const dispose = buildOutlineShell(mesh);
        if (dispose) restore.push(dispose);
      }
    });

    wrapsRef.current = wraps;

    return () => {
      // Restore originals first, then dispose only what this wrap created (the CSM
      // wrappers and the mask clones). The parent loader effect's disposeScene then
      // disposes the restored originals, so there is no double-free.
      restore.forEach((fn) => fn());
      wraps.forEach((w) => {
        w.material.dispose();
        w.ownedTextures.forEach((t) => t.dispose());
      });
      wraps.clear();
      wrapsRef.current = new Map();
    };
    // `tint` is intentionally excluded: the separate effect below applies it by
    // mutating uniforms, so a recolor never tears down and rebuilds the wraps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, enabled, outline]);

  // Drive uTime for the self-illum UV scroll (viscous_head's liquid glow).
  useFrame((state) => {
    if (!enabled) return;
    wrapsRef.current.forEach((w) => {
      if (w.uniforms.uTime) w.uniforms.uTime.value = state.clock.elapsedTime;
    });
  });

  // Live tint (ability-recolor preview): mutate uniforms only, no rebuild.
  useEffect(() => {
    if (!enabled) return;
    wrapsRef.current.forEach((w) => {
      const u = w.uniforms.uTintColor.value as THREE.Color;
      if (tint) u.copy(tint);
      else u.setRGB(1, 1, 1);
    });
  }, [tint, enabled]);

  return null;
}

function Source2MaterialHints({
  scene,
  enabled,
  debug,
}: {
  scene: THREE.Object3D;
  enabled: boolean;
  debug: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const hints = applySource2MaterialHints(scene, debug);
    if (debug) console.info('[source2hints] summary', hints.stats);
    return () => hints.restore();
  }, [scene, enabled, debug]);

  return null;
}

const q = (x: number): number => Math.round(x * 100) / 100;

export default function HeroPoseViewer({
  heroName,
  skinSources = [],
  fallbackSkinMetaKey,
  trippyPreview,
}: {
  heroName: string;
  /** Active visual VPK stack for this hero, ordered by the main process before export. */
  skinSources?: HeroPoseSkinSource[];
  /** Single-skin fallback when a multi-source preview stack cannot be exported. */
  fallbackSkinMetaKey?: string;
  /** Live Body + Gun trippy params to paint on the body in real time, or
   *  undefined for the plain skin. */
  trippyPreview?: TrippyPreview;
}) {
  const { t } = useTranslation();
  const [scene, setScene] = useState<THREE.Object3D | null>(null);
  const [clips, setClips] = useState<THREE.AnimationClip[]>([]);
  const [rigged, setRigged] = useState(false);
  const [clothModel, setClothModel] = useState<FeModel | null>(null);
  const [generating, setGenerating] = useState(false);
  const interaction = useRef<TurntableInteraction>({ dragging: false, paused: false });
  const [spinPaused, setSpinPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [effect, setEffect] = useState<EffectMount | null>(null);
  const sourceKey = skinSources.map((source) => `${source.priority}:${source.metaKey}`).join('|');
  // Dev shader toggles: state-backed (not just localStorage) so the in-app panel
  // re-applies live. The child effects key on these flags, so flipping one cleanly
  // applies/restores its material mutations without a reload.
  const [devFlags, setDevFlags] = useState(() => ({
    npr: previewFlag('grimoire.preview.npr', USE_NPR_PREVIEW),
    nprOutline: previewFlag('grimoire.preview.nprOutline', USE_NPR_OUTLINE),
    source2: previewFlag('grimoire.preview.source2Shaders', USE_SOURCE2_SHADER_HINTS),
    nprDebug: previewFlag('grimoire.preview.nprDebug', false),
  }));
  const setDevFlag = (key: keyof typeof devFlags, storageKey: string, value: boolean) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(storageKey, value ? '1' : '0');
    setDevFlags((f) => ({ ...f, [key]: value }));
  };
  const nprPreviewEnabled = devFlags.npr;
  const nprOutlineEnabled = devFlags.nprOutline;
  const source2ShaderHintsEnabled = devFlags.source2;
  const nprDebugEnabled = devFlags.nprDebug;
  const effectPreviewEnabled = useMemo(
    () => previewFlag('grimoire.preview.effects', USE_EFFECT_PREVIEW),
    []
  );

  // The pose GLB has no weapon mesh, so a weapons-only paint has nothing to show
  // here, and intensity 0 is "no paint". Otherwise fetch the pattern as an
  // animated sprite strip (debounced) and flipbook it onto the body materials.
  const showTrippy =
    !!trippyPreview && trippyPreview.targets !== 'weapons' && trippyPreview.intensity > 0;
  const trippyKey = showTrippy
    ? `${trippyPreview.style}:${q(trippyPreview.intensity)}:${q(trippyPreview.phase)}:${q(trippyPreview.scroll)}`
    : null;
  const [trippySprite, setTrippySprite] = useState<TrippySpriteResult | null>(null);
  useEffect(() => {
    if (!showTrippy || !trippyPreview) {
      setTrippySprite(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      previewTrippySprite({
        style: trippyPreview.style,
        phase: q(trippyPreview.phase),
        scroll: q(trippyPreview.scroll),
        intensity: q(trippyPreview.intensity),
        frames: 24,
        size: 128,
      })
        .then((sprite) => {
          if (!cancelled) setTrippySprite(sprite);
        })
        .catch(() => {
          if (!cancelled) setTrippySprite(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // trippyKey encodes the params that change the sprite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trippyKey]);

  useEffect(() => {
    // The caller remounts this component (via a hero+skin `key`) when the
    // selection changes, so initial state is already fresh here.
    let cancelled = false;
    let loaded: THREE.Object3D | null = null;

    (async () => {
      try {
        // --- Attempt 1: rigged (animated, skinned) glb. Gated OFF for now: the
        //     idle anim is WIP and too many heroes fall back to A-pose, so the
        //     static --pose menu pose (Attempt 2) is the default. ---
        if (USE_RIGGED_PREVIEW) {
          try {
            let rig = await getRiggedHeroPose(heroName, skinSources);
            if (cancelled) return;
            if (!rig.hasModel) {
              setGenerating(true);
              rig = await exportRiggedHeroPose(heroName, skinSources, fallbackSkinMetaKey);
              if (cancelled) return;
              setGenerating(false);
            }
            if (rig.hasModel) {
              const url = riggedMeshUrlFor(rig.key, rig.mtimeMs);
              const gltf = await loadGltfPreview(url);
              if (cancelled) {
                disposeScene(gltf.scene);
                return;
              }
              loaded = gltf.scene;
              setClips(gltf.animations ?? []);
              setRigged(true);
              setScene(gltf.scene);
              // Cloth-sim sidecar (colliders) for the rigged path. Best-effort:
              // a model with no cloth returns null and the sim simply no-ops.
              getHeroClothModel(heroName, skinSources).then((fe) => {
                if (!cancelled) setClothModel(fe);
              });
              return; // rigged path won.
            }
          } catch {
            // Rigged export/load failed; fall through to the static pose path.
            setGenerating(false);
          }
        }

        // --- Attempt 2: static --pose glb (the default). ---
        let info = await getHeroPoseInfo(heroName, skinSources);
        if (!info.hasModel) {
          if (cancelled) return;
          setGenerating(true);
          info = await exportHeroPose(heroName, skinSources, fallbackSkinMetaKey);
          if (cancelled) return;
          setGenerating(false);
        }
        if (!info.hasModel) {
          if (!cancelled) setFailed(true);
          return;
        }
        const url = meshUrlFor(info.key, info.mtimeMs);
        const gltf = await loadGltfPreview(url);
        if (cancelled) {
          disposeScene(gltf.scene);
          return;
        }
        loaded = gltf.scene;
        setRigged(false);
        setClips([]);
        setClothModel(null); // static path has no skeleton; nothing to simulate.
        setScene(gltf.scene);
      } catch {
        if (!cancelled) {
          setGenerating(false);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) disposeScene(loaded);
    };
    // `skinSources` is deliberately not a dependency: `sourceKey` already
    // encodes its contents, and the array reference changes on every parent
    // mods refresh, which would tear down and re-fetch the GLB for an
    // identical stack (visible viewer churn on unrelated toggles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroName, sourceKey, fallbackSkinMetaKey]);

  useEffect(() => {
    if (!scene || !nprDebugEnabled) return;
    console.info('[HeroPoseViewer] NPR material summary', heroName, summarizeNprScene(scene));
  }, [scene, heroName, nprDebugEnabled]);

  // Ambient FX overlay (skin-independent): only the curated heroes have one, so
  // getHeroEffectInfo cheaply returns hasEffect=false for everyone else. The
  // bundle is built on demand, then the descriptor JSON is fetched over the
  // grimoire-hero: scheme and handed to the renderer.
  useEffect(() => {
    if (!effectPreviewEnabled) return;
    let cancelled = false;
    setEffect(null);
    (async () => {
      try {
        let info = await getHeroEffectInfo(heroName);
        if (cancelled || !info.entry) return; // no curated effect for this hero.
        if (!info.hasEffect) {
          info = await exportHeroEffect(heroName);
          if (cancelled || !info.hasEffect) return;
        }
        const res = await fetch(effectDescriptorUrl(info.key));
        if (!res.ok) return;
        const descriptor = (await res.json()) as FxDescriptor;
        if (cancelled) return;
        setEffect({ descriptor, baseUrl: effectTextureBaseUrl(info.key) });
      } catch {
        // Effects are a non-essential overlay; a failure leaves the plain pose.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [heroName, effectPreviewEnabled]);

  if (failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="max-w-xs text-center text-sm text-text-secondary">
          {t('locker.pose.cannotPose')}
        </p>
      </div>
    );
  }

  if (!scene) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-white/80" />
        {generating && (
          <p className="text-xs text-text-secondary">
            {skinSources.length > 1
              ? t('locker.pose.posingWithMods', { hero: heroName, count: skinSources.length })
              : t('locker.pose.posing', { hero: heroName })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <Canvas
        camera={{ position: [0, 0, 3.2], fov: 40 }}
        dpr={[1, 2]}
        gl={{
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 0.8,
        }}
      >
        {/* The IBL probe supplies ambient + reflections, so the bare ambientLight
            is gone and the directionals are softened to a warm key + cool fill
            that just shapes the form on top of the environment. */}
        <Environment />
        <ambientLight intensity={0.12} />
        <directionalLight position={[3, 5, 4]} intensity={1.1} color="#fff3e0" />
        <directionalLight position={[-4, 2, -3]} intensity={0.4} color="#cfe0ff" />
        {rigged ? (
          <RiggedModel
            scene={scene}
            clips={clips}
            interaction={interaction}
            clothModel={clothModel}
            effect={effect}
          />
        ) : (
          <PosedModel scene={scene} interaction={interaction} effect={effect} />
        )}
        {source2ShaderHintsEnabled && scene && (
          <Source2MaterialHints scene={scene} enabled={source2ShaderHintsEnabled} debug={nprDebugEnabled} />
        )}
        {nprPreviewEnabled && scene && (
          <NprMaterials
            scene={scene}
            enabled={nprPreviewEnabled && !trippySprite}
            outline={nprOutlineEnabled}
            tint={null /* wire to a recolor color once the Locker recolor surface exists */}
          />
        )}
        {trippySprite && <TrippyPaint scene={scene} sprite={trippySprite} />}
        <Controls interaction={interaction} />
      </Canvas>
      <button
        type="button"
        onClick={() => {
          const next = !interaction.current.paused;
          interaction.current.paused = next;
          setSpinPaused(next);
        }}
        className="absolute bottom-3 left-3 z-10 rounded bg-black/60 px-3 py-1.5 text-xs text-white hover:bg-black/80"
      >
        {spinPaused ? 'Resume spin' : 'Pause spin'}
      </button>
      {import.meta.env.DEV && (
        <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded bg-black/60 p-2 text-xs text-white">
          {(
            [
              ['source2', 'grimoire.preview.source2Shaders', 'Source2 shaders'],
              ['npr', 'grimoire.preview.npr', 'NPR cel'],
              ['nprOutline', 'grimoire.preview.nprOutline', 'NPR outline'],
              ['nprDebug', 'grimoire.preview.nprDebug', 'Debug log'],
            ] as const
          ).map(([key, storageKey, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={devFlags[key]}
                onChange={(e) => setDevFlag(key, storageKey, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {rigged && clothModel && <ClothTuner />}
    </div>
  );
}
