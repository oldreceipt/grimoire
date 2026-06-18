import * as THREE from 'three';
import CustomShaderMaterial, { type CSMPatchMap } from 'three-custom-shader-material/vanilla';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Source 2 NPR (cel / rim / tint) restyle for the Locker hero preview.
 *
 * React-free. Owns reading the `morphic` extras vpkmerge emits, resolving the
 * Source 2 preview texture indices, and building the CSM that layers the
 * Deadlock toon look ON TOP of the existing PMREM IBL + ACES tonemap output (it
 * is additive on the lit result, never a replacement pass).
 *
 * Data contract (mirror of vpkmerge morphic/src/model/glb.rs `morphic_extras`):
 *   material.userData.morphic = {
 *     shader:   string,
 *     ints:     { [name]: number },   // F_* feature flags + int params (scalars)
 *     floats:   { [name]: number },   // scalars
 *     vectors:  { [name]: number[] }, // always [x, y, z, w]
 *     textures: { [slot]: number },   // glTF TEXTURE INDEX (not a Texture)
 *   }
 * three's GLTFLoader copies material.extras into material.userData verbatim, so
 * the param tables arrive for free; only the texture INDICES need resolving into
 * THREE.Texture (resolveMorphicTextures, run at load time while the parser lives).
 */

/**
 * Preview texture slots vpkmerge emits (mirror of SOURCE2_PREVIEW_TEXTURE_SLOTS
 * in vpkmerge morphic/src/model/glb.rs). These are not ordinary glTF PBR
 * bindings; they are resolved into linear data textures for NPR masks, shader
 * approximation, and debug scans.
 *   g_tTintMaskRimLightMask  R = tint enable, G = rim-light constant
 *   g_tNprOutlineMask        where outlines appear
 *   g_tNprTransmissiveColor  NPR transmissive color (deferred in v1)
 */
export const NPR_TEXTURE_SLOTS = [
  'g_tTintMaskRimLightMask',
  'g_tNprOutlineMask',
  'g_tNprTransmissiveColor',
] as const;

export const SOURCE2_PREVIEW_TEXTURE_SLOTS = [
  ...NPR_TEXTURE_SLOTS,
  'g_tGlass',
  'g_tAltTranslucency',
  'g_tJitterMask',
  'g_tSelfIllumMask',
  'g_tSheen',
] as const;

/**
 * Shape of `userData.morphic`. ints/floats are scalars in the wire format
 * (vpkmerge emits BTreeMap<String, i64/f32>), but the `scalar()` reader also
 * tolerates a single-element array defensively. vectors are always [x, y, z, w].
 * textures[slot] is a glTF texture index; resolvedTextures is filled in by
 * resolveMorphicTextures with per-material Texture clones.
 */
export interface MorphicExtras {
  shader: string;
  ints?: Record<string, number | number[]>;
  floats?: Record<string, number | number[]>;
  vectors?: Record<string, number[]>;
  textures?: Record<string, number>;
  resolvedTextures?: Record<string, THREE.Texture>;
}

/**
 * App-constant cel / rim coefficients. These correspond to engine __Attribute__
 * vars that are NOT present in any shipped material (so NOT in morphic); they are
 * hand-tuned to match in-game screenshots and exposed as uniforms.
 */
export interface NprTuning {
  bands: number;
  stepSharpness: number;
  wrap: number;
  rimStrength: number;
  rimPower: number;
  rimColor: THREE.Color;
  nprStrength: number;
  keyDir: THREE.Vector3;
}

export interface NprWrapResult {
  /**
   * The CSM. NOTE: this is NOT instanceof THREE.MeshPhysicalMaterial (CSM extends
   * THREE.Material). It carries the base's copied `isMeshStandardMaterial` /
   * `isMeshPhysicalMaterial` flags and proxies `type`, which is what the renderer
   * keys IBL/PMREM on; skinning is mesh-driven (SkinnedMesh.isSkinnedMesh), not
   * material-driven. Do NOT feed this to code that does `instanceof MeshPhysicalMaterial`.
   */
  material: THREE.Material;
  /** Per-material uniforms; mutate uTintColor.value for live recolor without a rebuild. */
  uniforms: Record<string, THREE.IUniform>;
  /** Mask clones THIS wrap created and is responsible for disposing on teardown. */
  ownedTextures: THREE.Texture[];
}

export interface NprSceneSummary {
  meshes: number;
  materials: number;
  morphicMaterials: number;
  nprMaterials: number;
  glassMaterials: number;
  translucentMaterials: number;
  additiveMaterials: number;
  selfIllumMaterials: number;
  jitterMaterials: number;
  sheenMaterials: number;
  unlitMaterials: number;
  backfaceMaterials: number;
  tintRimMasks: number;
  outlineTintMaterials: number;
  glassMasks: number;
  altTranslucencyMasks: number;
  jitterMasks: number;
  selfIllumMasks: number;
  resolvedTextureSlots: Record<string, number>;
  shaders: Record<string, number>;
}

export interface Source2MaterialHintStats {
  materials: number;
  glass: number;
  translucent: number;
  additive: number;
  selfIllum: number;
  unlit: number;
  sheen: number;
  backfaces: number;
  alphaMaps: number;
  emissiveMaps: number;
  jitterDisplacements: number;
}

export interface Source2MaterialHintsResult {
  restore: () => void;
  stats: Source2MaterialHintStats;
}

/**
 * Deadlock-tuned starting constants. keyDir matches the scene key light at
 * [3, 5, 4] so the cel terminator reads consistently with the lit form.
 */
export const DEFAULT_NPR_TUNING: NprTuning = {
  bands: 4,
  stepSharpness: 0.08,
  wrap: 0.5,
  rimStrength: 0.6,
  rimPower: 3.0,
  rimColor: new THREE.Color(0.6, 0.75, 1.0),
  nprStrength: 1.0,
  keyDir: new THREE.Vector3(3, 5, 4).normalize(),
};

// A 1x1 white texture so the mask sampler is ALWAYS bound (never sample an
// unbound sampler). Module-shared, app-lifetime, never disposed. When
// uHasTintMask == 0 the shader ignores its value anyway.
let WHITE_FALLBACK: THREE.DataTexture | null = null;
function whiteFallback(): THREE.DataTexture {
  if (!WHITE_FALLBACK) {
    WHITE_FALLBACK = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    WHITE_FALLBACK.colorSpace = THREE.NoColorSpace;
    WHITE_FALLBACK.needsUpdate = true;
  }
  return WHITE_FALLBACK;
}

// Read a param that may be a scalar or a single-element array, with a default.
function scalar(v: number | number[] | undefined, d = 0): number {
  if (v === undefined) return d;
  if (Array.isArray(v)) return v[0] ?? d;
  return v;
}

function getMorphic(mat: THREE.Material): MorphicExtras | undefined {
  return (mat.userData as { morphic?: MorphicExtras }).morphic;
}

function flag(morphic: MorphicExtras, name: string): boolean {
  return scalar(morphic.ints?.[name], 0) !== 0;
}

function vectorColor(v: number[] | undefined, fallback: THREE.Color): THREE.Color {
  if (!v) return fallback.clone();
  return new THREE.Color(v[0] ?? fallback.r, v[1] ?? fallback.g, v[2] ?? fallback.b);
}

function firstNumber(morphic: MorphicExtras, names: string[], fallback: number): number {
  for (const name of names) {
    const f = scalar(morphic.floats?.[name], Number.NaN);
    if (Number.isFinite(f)) return f;
    const v = morphic.vectors?.[name]?.[0];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

function textureSize(tex: THREE.Texture | undefined): { width: number; height: number } | null {
  const image = tex?.image as { width?: number; height?: number } | undefined;
  if (!image || typeof image.width !== 'number' || typeof image.height !== 'number') return null;
  return { width: image.width, height: image.height };
}

function isMeaningfulMask(tex: THREE.Texture | undefined): tex is THREE.Texture {
  const size = textureSize(tex);
  return !!size && size.width > 4 && size.height > 4;
}

/**
 * Resolve the preview texture INDICES on every morphic material in the scene to
 * live THREE.Texture instances, stashed on userData.morphic.resolvedTextures.
 *
 * Called from loadGltfPreview while gltf.parser is still live: getDependency is
 * the only way to turn an extras-referenced glTF texture index into a Texture.
 * getDependency returns the parser's SHARED cached texture (not a per-call clone),
 * so we clone per material before mutating sampler params and before handing it to
 * the wrap: each material then owns its own clone (no shared mutation, no
 * double-dispose). Early-returns when no material carries mask indices, so the
 * non-NPR path adds only one scene traversal.
 */
export async function resolveMorphicTextures(gltf: GLTF): Promise<void> {
  const materials = new Set<THREE.Material>();
  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material;
    if (!mat) return;
    (Array.isArray(mat) ? mat : [mat]).forEach((m) => materials.add(m));
  });

  const targets = [...materials].filter((m) => getMorphic(m)?.textures);
  if (targets.length === 0) return;

  await Promise.all(
    targets.map(async (mat) => {
      const morphic = getMorphic(mat)!;
      const indices = morphic.textures!;
      const resolved: Record<string, THREE.Texture> = {};
      await Promise.all(
        SOURCE2_PREVIEW_TEXTURE_SLOTS.filter((slot) => typeof indices[slot] === 'number').map(async (slot) => {
          try {
            const shared = (await gltf.parser.getDependency(
              'texture',
              indices[slot]
            )) as THREE.Texture;
            // Clone so each material owns its mask: getDependency caches and may
            // hand the same Texture to several materials (shared atlases), and the
            // index may also be a normal PBR slot elsewhere. Mutating/disposing a
            // shared instance would corrupt or double-free it. The clone shares
            // the image but has its own sampler params and dispose.
            const tex = shared.clone();
            // Masks are LINEAR data (vpkmerge embeds them raw, no color-space
            // conversion). Reading them as sRGB would warp the rim/tint constants.
            tex.colorSpace = THREE.NoColorSpace;
            // Authored masks are full-size spatial textures, so filter them
            // smoothly to avoid shimmer on the turntable.
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.needsUpdate = true;
            resolved[slot] = tex;
          } catch {
            // Missing / undecodable slot stays absent; the shader degrades to
            // ramp + rim only for this material.
          }
        })
      );
      morphic.resolvedTextures = resolved;
    })
  );
}

/**
 * Per-material eligibility gate. Enforces graceful fallback: anything without
 * morphic data, or without F_USE_NPR_LIGHTING === 1, is never wrapped and renders
 * exactly as today. ShaderMaterial / RawShaderMaterial are refused because CSM
 * throws on them (GLTFLoader never produces these, but the guard is cheap).
 */
export function isNprMaterial(mat: THREE.Material): boolean {
  const morphic = getMorphic(mat);
  if (!morphic) return false;
  if (mat.type === 'ShaderMaterial' || mat.type === 'RawShaderMaterial') return false;
  return scalar(morphic.ints?.F_USE_NPR_LIGHTING, 0) === 1;
}

/**
 * Cheap runtime smoke summary for dev builds. This answers the first question
 * before touching shader output: did this GLB actually arrive with morphic
 * material extras and the preview texture indices resolved?
 */
export function summarizeNprScene(scene: THREE.Object3D): NprSceneSummary {
  const materials = new Set<THREE.Material>();
  let meshes = 0;
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((mat) => {
      if (mat) materials.add(mat);
    });
  });

  const shaders: Record<string, number> = {};
  let morphicMaterials = 0;
  let nprMaterials = 0;
  let glassMaterials = 0;
  let translucentMaterials = 0;
  let additiveMaterials = 0;
  let selfIllumMaterials = 0;
  let jitterMaterials = 0;
  let sheenMaterials = 0;
  let unlitMaterials = 0;
  let backfaceMaterials = 0;
  let tintRimMasks = 0;
  let outlineTintMaterials = 0;
  let glassMasks = 0;
  let altTranslucencyMasks = 0;
  let jitterMasks = 0;
  let selfIllumMasks = 0;
  const resolvedTextureSlots: Record<string, number> = {};
  materials.forEach((mat) => {
    const morphic = getMorphic(mat);
    if (!morphic) return;
    morphicMaterials += 1;
    shaders[morphic.shader || 'unknown'] = (shaders[morphic.shader || 'unknown'] ?? 0) + 1;
    if (isNprMaterial(mat)) nprMaterials += 1;
    if (flag(morphic, 'F_GLASS')) glassMaterials += 1;
    if (flag(morphic, 'F_TRANSLUCENT') || flag(morphic, 'F_ADVANCED_TRANSLUCENCY')) {
      translucentMaterials += 1;
    }
    if (flag(morphic, 'F_ADDITIVE_BLEND')) additiveMaterials += 1;
    if (flag(morphic, 'F_SELF_ILLUM') || morphic.floats?.g_flSelfIllumScale1) {
      selfIllumMaterials += 1;
    }
    if (flag(morphic, 'F_JITTER_VERTICES') || morphic.resolvedTextures?.g_tJitterMask) {
      jitterMaterials += 1;
    }
    if (flag(morphic, 'F_SHEEN')) sheenMaterials += 1;
    if (flag(morphic, 'F_UNLIT')) unlitMaterials += 1;
    if (flag(morphic, 'F_RENDER_BACKFACES')) backfaceMaterials += 1;
    if (morphic.resolvedTextures?.g_tTintMaskRimLightMask) tintRimMasks += 1;
    if (morphic.vectors?.g_vSolidOutlineTint) outlineTintMaterials += 1;
    if (morphic.resolvedTextures?.g_tGlass) glassMasks += 1;
    if (morphic.resolvedTextures?.g_tAltTranslucency) altTranslucencyMasks += 1;
    if (morphic.resolvedTextures?.g_tJitterMask) jitterMasks += 1;
    if (morphic.resolvedTextures?.g_tSelfIllumMask) selfIllumMasks += 1;
    Object.keys(morphic.resolvedTextures ?? {}).forEach((slot) => {
      resolvedTextureSlots[slot] = (resolvedTextureSlots[slot] ?? 0) + 1;
    });
  });

  return {
    meshes,
    materials: materials.size,
    morphicMaterials,
    nprMaterials,
    glassMaterials,
    translucentMaterials,
    additiveMaterials,
    selfIllumMaterials,
    jitterMaterials,
    sheenMaterials,
    unlitMaterials,
    backfaceMaterials,
    tintRimMasks,
    outlineTintMaterials,
    glassMasks,
    altTranslucencyMasks,
    jitterMasks,
    selfIllumMasks,
    resolvedTextureSlots,
    shaders,
  };
}

/**
 * Cheap Source 2 material hints for shader families GLTFLoader cannot represent
 * fully. This deliberately mutates only standard/physical material properties
 * and returns a restore handle so it can be gated independently from the NPR CSM.
 */
export function applySource2MaterialHints(
  scene: THREE.Object3D,
  debug = false
): Source2MaterialHintsResult {
  const restore: Array<() => void> = [];
  const seen = new Set<THREE.Material>();
  const stats: Source2MaterialHintStats = {
    materials: 0,
    glass: 0,
    translucent: 0,
    additive: 0,
    selfIllum: 0,
    unlit: 0,
    sheen: 0,
    backfaces: 0,
    alphaMaps: 0,
    emissiveMaps: 0,
    jitterDisplacements: 0,
  };

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((mat) => {
      if (!mat || seen.has(mat)) return;
      seen.add(mat);
      const morphic = getMorphic(mat);
      if (!morphic) return;
      const standard = mat as THREE.MeshStandardMaterial;
      if (!standard.isMeshStandardMaterial && !(standard as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
        return;
      }
      stats.materials += 1;

      const physical = standard as THREE.MeshPhysicalMaterial;
      const before = {
        side: mat.side,
        transparent: mat.transparent,
        opacity: mat.opacity,
        alphaMap: standard.alphaMap,
        alphaTest: standard.alphaTest,
        depthWrite: mat.depthWrite,
        blending: mat.blending,
        toneMapped: mat.toneMapped,
        roughness: standard.roughness,
        metalness: standard.metalness,
        emissive: standard.emissive?.clone(),
        emissiveMap: standard.emissiveMap,
        emissiveIntensity: standard.emissiveIntensity,
        envMapIntensity: standard.envMapIntensity,
        displacementMap: standard.displacementMap,
        displacementScale: standard.displacementScale,
        displacementBias: standard.displacementBias,
        transmission: physical.transmission,
        thickness: physical.thickness,
        ior: physical.ior,
        clearcoat: physical.clearcoat,
        clearcoatRoughness: physical.clearcoatRoughness,
        sheen: physical.sheen,
        sheenRoughness: physical.sheenRoughness,
        sheenColor: physical.sheenColor?.clone(),
      };

      const glass = flag(morphic, 'F_GLASS');
      const translucent = flag(morphic, 'F_TRANSLUCENT') || flag(morphic, 'F_ADVANCED_TRANSLUCENCY');
      const additive = flag(morphic, 'F_ADDITIVE_BLEND');
      const selfIllum = flag(morphic, 'F_SELF_ILLUM') || morphic.floats?.g_flSelfIllumScale1 !== undefined;
      const unlit = flag(morphic, 'F_UNLIT');
      const sheen = flag(morphic, 'F_SHEEN');
      const backfaces = flag(morphic, 'F_RENDER_BACKFACES');
      const selfIllumMap = morphic.resolvedTextures?.g_tSelfIllumMask;
      const hasSelfIllumMap = isMeaningfulMask(selfIllumMap);
      const selfIllumScale = firstNumber(
        morphic,
        ['g_flSelfIllumScale1', 'g_flSelfIllumScale'],
        Number.NaN
      );
      const selfIllumTintVec = morphic.vectors?.g_vSelfIllumTint1 ?? morphic.vectors?.g_vSelfIllumTint;

      if (glass) stats.glass += 1;
      if (translucent) stats.translucent += 1;
      if (additive) stats.additive += 1;
      if (selfIllum) stats.selfIllum += 1;
      if (unlit) stats.unlit += 1;
      if (sheen) stats.sheen += 1;
      if (backfaces) {
        stats.backfaces += 1;
        mat.side = THREE.DoubleSide;
      }

      if (glass) {
        standard.roughness = Math.min(standard.roughness ?? 1, 0.18);
        standard.metalness = Math.min(standard.metalness ?? 0, 0.05);
        standard.envMapIntensity = Math.max(standard.envMapIntensity ?? 1, 1.35);
        physical.transmission = Math.max(physical.transmission ?? 0, 0.85);
        physical.thickness = Math.max(physical.thickness ?? 0, 0.12);
        physical.ior = firstNumber(morphic, ['g_flIOR'], physical.ior ?? 1.5);
        physical.clearcoat = Math.max(physical.clearcoat ?? 0, 0.45);
        physical.clearcoatRoughness = Math.min(physical.clearcoatRoughness ?? 0.25, 0.18);
      }

      if (translucent || additive) {
        const alphaMask =
          morphic.resolvedTextures?.g_tAltTranslucency ?? morphic.resolvedTextures?.g_tGlass;
        mat.transparent = true;
        // Translucent goo skin keeps depthWrite ON so it occludes the opaque
        // interior (Viscous's black gear/"bones"). depthWrite=false x-rayed every
        // interior layer at once, making the bones read as see-through. Additive
        // glow (below) still needs it off.
        mat.depthWrite = true;
        mat.opacity = Math.min(
          mat.opacity,
          firstNumber(morphic, ['g_flOpacityScale1', 'TextureOpacity1'], glass ? 0.72 : 0.62)
        );
        if (isMeaningfulMask(alphaMask)) {
          standard.alphaMap = alphaMask;
          standard.alphaTest = Math.max(standard.alphaTest ?? 0, 0.01);
          stats.alphaMaps += 1;
        }
      }

      if (additive) {
        mat.blending = THREE.AdditiveBlending;
        mat.depthWrite = false;
      }

      // Self-illum fires ONLY on a real mask (matches the GLB exporter, which skips
      // placeholder 4x4 default masks). Deadlock emissive = mask * scale * tint:
      // viscous_body/ball carry F_SELF_ILLUM with a placeholder mask, default white
      // tint, and 0.02 scale, which the old gate (tint/scale "present" -> emit,
      // intensity floored to 1) turned into a full white glow -- the milky-white
      // body. viscous_head has the real liquid mask + green tint + 0.629 scale and
      // still glows green. Use the real scale as intensity, not a forced floor of 1.
      if (selfIllum && standard.emissive && hasSelfIllumMap) {
        standard.emissive.copy(vectorColor(selfIllumTintVec, new THREE.Color(1, 1, 1)));
        standard.emissiveIntensity = Number.isFinite(selfIllumScale)
          ? Math.max(selfIllumScale, 0)
          : 1;
        if (!standard.emissiveMap) {
          standard.emissiveMap = selfIllumMap;
          stats.emissiveMaps += 1;
        }
      }

      if (unlit && standard.emissive) {
        standard.emissive.copy(standard.color ?? new THREE.Color(1, 1, 1));
        standard.emissiveIntensity = Math.max(standard.emissiveIntensity ?? 1, 1.2);
        mat.toneMapped = false;
      }

      if (sheen && physical.isMeshPhysicalMaterial) {
        physical.sheen = Math.max(physical.sheen ?? 0, 0.65);
        physical.sheenRoughness = firstNumber(morphic, ['TextureSheenRoughness1', 'g_flSheenRoughness'], physical.sheenRoughness ?? 0.45);
        physical.sheenColor.copy(
          vectorColor(morphic.vectors?.TextureSheenColor1 ?? morphic.vectors?.g_vSheenColorTint1, physical.sheenColor)
        );
      }

      const jitterMask = morphic.resolvedTextures?.g_tJitterMask;
      if (flag(morphic, 'F_JITTER_VERTICES') && isMeaningfulMask(jitterMask)) {
        standard.displacementMap = jitterMask;
        standard.displacementScale = Math.max(standard.displacementScale ?? 0, 0.01);
        standard.displacementBias = standard.displacementBias ?? 0;
        stats.jitterDisplacements += 1;
      }

      mat.needsUpdate = true;
      if (debug) {
        console.info('[source2hints]', mat.name || '(unnamed)', {
          shader: morphic.shader,
          glass,
          translucent,
          additive,
          selfIllum: selfIllum && hasSelfIllumMap,
          unlit,
          sheen,
          backfaces,
          emissiveIntensity: standard.emissiveIntensity,
          opacity: mat.opacity,
          transparent: mat.transparent,
        });
      }
      restore.push(() => {
        mat.side = before.side;
        mat.transparent = before.transparent;
        mat.opacity = before.opacity;
        standard.alphaMap = before.alphaMap;
        standard.alphaTest = before.alphaTest;
        mat.depthWrite = before.depthWrite;
        mat.blending = before.blending;
        mat.toneMapped = before.toneMapped;
        standard.roughness = before.roughness;
        standard.metalness = before.metalness;
        if (before.emissive) standard.emissive.copy(before.emissive);
        standard.emissiveMap = before.emissiveMap;
        standard.emissiveIntensity = before.emissiveIntensity;
        standard.envMapIntensity = before.envMapIntensity;
        standard.displacementMap = before.displacementMap;
        standard.displacementScale = before.displacementScale;
        standard.displacementBias = before.displacementBias;
        physical.transmission = before.transmission;
        physical.thickness = before.thickness;
        physical.ior = before.ior;
        physical.clearcoat = before.clearcoat;
        physical.clearcoatRoughness = before.clearcoatRoughness;
        physical.sheen = before.sheen;
        physical.sheenRoughness = before.sheenRoughness;
        if (before.sheenColor) physical.sheenColor.copy(before.sheenColor);
        mat.needsUpdate = true;
      });
    });
  });

  return {
    restore: () => {
      restore.forEach((fn) => fn());
    },
    stats,
  };
}

// Shared GLSL (module constants so every hero reuses one compiled program).
//
// The vertex shader does NOT write csm_Position / csm_Normal. Writing csm_Position
// re-routes <begin_vertex> (transformed = csm_Position) and would reorder relative
// to <skinning_vertex> / <morphtarget_vertex>, risking the rigged spine. Keep this
// to varying passthrough only.
const NPR_VERTEX = /* glsl */ `
varying vec2 vNprUv;
void main() {
  #ifdef USE_UV
    vNprUv = uv;
  #else
    vNprUv = vec2(0.0);
  #endif
}
`;

// The user fragment body runs at the TOP of the compiled main(), BEFORE lighting.
// So here we only do the PRE-light tint multiply on csm_DiffuseColor (which CSM
// feeds into diffuseColor for the BRDF) and sample the mask once into a local that
// the post-light patch (NPR_PATCH_MAP, injected after <opaque_fragment>, same
// main() scope) reads for the rim. The cel + rim math itself MUST live in the
// patch, because the lit color does not exist yet at this point.
const NPR_FRAGMENT = /* glsl */ `
uniform vec3  uKeyDir;
uniform float uBands;
uniform float uStepSharpness;
uniform float uWrap;
uniform float uRimStrength;
uniform float uRimPower;
uniform vec3  uRimColor;
uniform float uRimMaskDefault;
uniform float uNprStrength;
uniform vec3  uTintColor;
uniform sampler2D uTintRimMask;
uniform float uHasTintMask;
uniform float uTime;
uniform sampler2D uSelfIllumMap;
uniform float uHasSelfIllum;
uniform vec2  uSelfIllumScroll;
uniform vec3  uSelfIllumTint;
uniform float uSelfIllumScale;
varying vec2 vNprUv;

// Soft-quantize a 0..1 value into uBands steps, softening only the riser so band
// terminators do not alias at preview resolution.
float celQuantize(float x, float bands, float sharp) {
  float scaled = x * bands;
  float lower = floor(scaled);
  float f = scaled - lower;
  float soft = smoothstep(0.5 - sharp, 0.5 + sharp, f);
  return (lower + soft) / bands;
}

void main() {
  // nprMask is declared in main() scope, so it is also visible at the post-light
  // patch site (same main() block, later in the chunk chain).
  vec4 nprMask = uHasTintMask > 0.5 ? texture2D(uTintRimMask, vNprUv) : vec4(1.0);
  float tintEnable = uHasTintMask > 0.5 ? nprMask.r : 0.0;
  // uTintColor defaults to white (identity); it is driven only by an external
  // recolor override. The authoring tint g_vColorTint1 is already baked into the
  // base color factor by vpkmerge, so it must NOT be re-applied here.
  csm_DiffuseColor.rgb = mix(csm_DiffuseColor.rgb, csm_DiffuseColor.rgb * uTintColor, tintEnable);
}
`;

// The post-light pass: injected right after <opaque_fragment>, where gl_FragColor
// holds the IBL + direct lit LINEAR color and tonemapping has not run yet. We do
// the cel posterize + rim here and write gl_FragColor directly. We never reference
// csm_FragColor, so CSM does not inject its own opaque_fragment mix (it only does
// so when the user fragment uses csm_FragColor), and csm_UnlitFac stays 0. ACES
// tonemaps our result downstream exactly like the PBR path.
const NPR_PATCH_MAP: CSMPatchMap = {
  '*': {
    '#include <opaque_fragment>': /* glsl */ `
      #include <opaque_fragment>
      {
        vec3 nprLit = gl_FragColor.rgb;
        #ifdef FLAT_SHADED
          vec3 nprN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
        #else
          vec3 nprN = normalize(vNormal);
        #endif
        vec3 nprV = normalize(vViewPosition);
        vec3 nprL = normalize(uKeyDir);

        // Posterize luminance while preserving hue so the IBL color shaping
        // survives. Clamp the rescale so near-black pixels do not amplify noise.
        float nprLum = dot(nprLit, vec3(0.2126, 0.7152, 0.0722));
        float nprQ = celQuantize(clamp(nprLum, 0.0, 1.0), uBands, uStepSharpness);
        vec3 nprCel = nprLit * (nprLum > 1e-4 ? clamp(nprQ / nprLum, 0.0, 4.0) : 1.0);

        // Rim: fresnel edge, gated to the lit hemisphere, modulated by mask G (or
        // the default when no mask).
        float nprRimMaskG = uHasTintMask > 0.5 ? nprMask.g : uRimMaskDefault;
        float nprFres = pow(clamp(1.0 - abs(dot(nprN, nprV)), 0.0, 1.0), uRimPower);
        float nprGate = smoothstep(-uWrap, 1.0, dot(nprN, nprL));
        float nprRim = nprFres * nprGate * nprRimMaskG * uRimStrength;

        vec3 nprOut = nprCel + uRimColor * nprRim;

        // Self-illum: scrolling emissive on materials with a REAL mask (viscous_head's
        // liquid mask scrolls up at g_vSelfIllumScrollSpeed and glows green). Gated by
        // uHasSelfIllum so placeholder-4x4 masks (ball/body) contribute nothing. The
        // GLB-baked base emissive is zeroed in applySource2MaterialHints so this is the
        // sole owner of the glow (no double-green).
        if (uHasSelfIllum > 0.5) {
          vec2 siUv = fract(vNprUv + uSelfIllumScroll * uTime);
          float siMask = texture2D(uSelfIllumMap, siUv).r;
          nprOut += uSelfIllumTint * (siMask * uSelfIllumScale);
        }

        gl_FragColor.rgb = mix(gl_FragColor.rgb, nprOut, uNprStrength);
      }
    `,
  },
};

/**
 * Wrap an NPR-eligible material with a CSM that layers the Deadlock cel ramp,
 * rim, and tint mask on the lit PBR output. Returns null when the material is not
 * NPR-eligible (caller skips it, leaving it untouched).
 *
 * The base instance is passed through to CSM v6, which copies the base's own
 * props (including the `isMeshStandardMaterial` / `isMeshPhysicalMaterial` flags
 * the renderer keys IBL/PMREM on) and proxies `type`. The result is NOT
 * instanceof MeshPhysicalMaterial, but IBL and skinning still work (skinning is
 * mesh-driven). Emissive (g_flSelfIllumScale1 / g_vSelfIllumTint1) is NOT
 * re-applied: it is already baked into KHR_materials_emissive_strength on the base.
 */
export function wrapMaterialWithNpr(
  base: THREE.Material,
  tuning: NprTuning = DEFAULT_NPR_TUNING,
  tintOverride: THREE.Color | null = null
): NprWrapResult | null {
  if (!isNprMaterial(base)) return null;
  const morphic = getMorphic(base)!;

  const tintMask = morphic.resolvedTextures?.g_tTintMaskRimLightMask ?? null;
  // Default to white (identity). g_vColorTint1 is already baked into the base
  // color factor by vpkmerge; re-reading it here would double-apply the tint.
  const tintColor = tintOverride ?? new THREE.Color(1, 1, 1);

  // Self-illum: only a REAL mask animates (placeholder 4x4 gate, same as the hints
  // path). g_tSelfIllumMask scrolls at g_vSelfIllumScrollSpeed, tinted+scaled.
  const selfIllumMap = morphic.resolvedTextures?.g_tSelfIllumMask;
  const hasSelfIllum = isMeaningfulMask(selfIllumMap);
  if (selfIllumMap) {
    // Scroll wraps via fract(), so the sampler must repeat or the seam smears.
    selfIllumMap.wrapS = THREE.RepeatWrapping;
    selfIllumMap.wrapT = THREE.RepeatWrapping;
    selfIllumMap.needsUpdate = true;
  }
  const siScroll = morphic.vectors?.g_vSelfIllumScrollSpeed1 ?? morphic.vectors?.g_vSelfIllumScrollSpeed;
  const siTint = vectorColor(
    morphic.vectors?.g_vSelfIllumTint1 ?? morphic.vectors?.g_vSelfIllumTint,
    new THREE.Color(0, 0, 0)
  );
  // Use the real scale (viscous_head = 0.629); never floor to 1 (milky-white guard).
  const siScale = firstNumber(morphic, ['g_flSelfIllumScale1', 'g_flSelfIllumScale'], 0);

  // The GLB exporter bakes viscous_head's emissive (texture + green factor) into the
  // base; the lit pass would emit it before our patch runs -> double-green. When the
  // NPR path owns the (scrolling) glow, zero the base emissive BEFORE the CSM copies
  // base props. unwrapNprBase restores it on teardown. Stamped on the base instance.
  if (hasSelfIllum) {
    const std = base as THREE.MeshStandardMaterial & { __nprPrevEmissiveIntensity?: number };
    std.__nprPrevEmissiveIntensity = std.emissiveIntensity;
    std.emissiveIntensity = 0;
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uKeyDir: { value: tuning.keyDir.clone() },
    uBands: { value: tuning.bands },
    uStepSharpness: { value: tuning.stepSharpness },
    uWrap: { value: tuning.wrap },
    uRimStrength: { value: tuning.rimStrength },
    uRimPower: { value: tuning.rimPower },
    uRimColor: { value: tuning.rimColor.clone() },
    uRimMaskDefault: { value: 1.0 },
    uNprStrength: { value: tuning.nprStrength },
    uTintColor: { value: tintColor },
    uTintRimMask: { value: tintMask ?? whiteFallback() },
    uHasTintMask: { value: tintMask ? 1.0 : 0.0 },
    uTime: { value: 0 },
    uSelfIllumMap: { value: hasSelfIllum ? selfIllumMap : whiteFallback() },
    uHasSelfIllum: { value: hasSelfIllum ? 1.0 : 0.0 },
    uSelfIllumScroll: { value: new THREE.Vector2(siScroll?.[0] ?? 0, siScroll?.[1] ?? 0) },
    uSelfIllumTint: { value: siTint },
    uSelfIllumScale: { value: siScale },
  };

  const csm = new CustomShaderMaterial({
    baseMaterial: base as THREE.MeshPhysicalMaterial,
    vertexShader: NPR_VERTEX,
    fragmentShader: NPR_FRAGMENT,
    uniforms,
    patchMap: NPR_PATCH_MAP,
  });

  // The mask clone is the only GPU resource this wrap created (the base material
  // and its standard maps are owned by disposeScene). When no mask resolved, the
  // sampler points at the shared white fallback, which must NOT be disposed.
  const ownedTextures = tintMask ? [tintMask] : [];
  return { material: csm as unknown as THREE.Material, uniforms, ownedTextures };
}

/**
 * Reverse CSM's in-place mutation of a base material. three-custom-shader-material,
 * when handed a material INSTANCE (not a class), patches that instance's
 * onBeforeCompile + customProgramCacheKey rather than a copy, stashing the
 * originals on `__csm`. So restoring mesh.material to the base is NOT enough to
 * toggle the cel shader off -- the base still compiles the NPR program. This puts
 * the original compile hooks back and forces a recompile.
 */
export function unwrapNprBase(mat: THREE.Material): void {
  const m = mat as THREE.Material & {
    __csm?: { prevOnBeforeCompile?: THREE.Material['onBeforeCompile'] };
    __nprPrevEmissiveIntensity?: number;
  };
  // Restore the baked emissive the NPR self-illum path zeroed (see wrapMaterialWithNpr).
  if (m.__nprPrevEmissiveIntensity !== undefined) {
    (mat as THREE.MeshStandardMaterial).emissiveIntensity = m.__nprPrevEmissiveIntensity;
    delete m.__nprPrevEmissiveIntensity;
  }
  if (!m.__csm) return;
  mat.onBeforeCompile = m.__csm.prevOnBeforeCompile ?? (() => {});
  delete m.__csm;
  // CSM set customProgramCacheKey as an own property; drop it to fall back to the
  // prototype default (it is non-optional on Material, hence the record cast).
  delete (mat as unknown as Record<string, unknown>).customProgramCacheKey;
  mat.needsUpdate = true;
}

/**
 * Build the inverted-hull solid-color outline shell for a mesh, or null when the
 * mesh is not outline-eligible. Faithful to Source 2's method (vpkmerge strips
 * the engine shells from the export, so they are regenerated here). The shell is
 * added as a child of `mesh` so it inherits the mesh transform; for a SkinnedMesh
 * it binds the SAME skeleton + bindMatrix so it deforms with the body. Returns a
 * teardown that removes the shell and disposes ONLY the outline material
 * (geometry + skeleton are shared with the real mesh).
 *
 * Gated behind USE_NPR_OUTLINE in the viewer (default off): the skinned-shell
 * binding is the highest-risk piece, so it ships independently of ramp/rim/tint.
 * Eligibility keys on the PRESENCE of g_vSolidOutlineTint (the real outline data
 * confirmed in vpkmerge fixtures); F_DISABLE_NPR_OUTLINE, when present, opts out.
 */
export function buildOutlineShell(mesh: THREE.Mesh): (() => void) | null {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const base = mats[0];
  const morphic = base ? getMorphic(base) : undefined;
  if (!morphic) return null;
  const tintVec = morphic.vectors?.g_vSolidOutlineTint;
  if (!tintVec) return null;
  if (scalar(morphic.ints?.F_DISABLE_NPR_OUTLINE, 0) === 1) return null;

  const addVec = morphic.vectors?.g_vSolidOutlineAdditive;
  const tint = new THREE.Color(
    (tintVec[0] ?? 0) + (addVec?.[0] ?? 0),
    (tintVec[1] ?? 0) + (addVec?.[1] ?? 0),
    (tintVec[2] ?? 0) + (addVec?.[2] ?? 0)
  );
  const thickness = scalar(morphic.floats?.g_flOverrideNprOutlineThickness, 0.02) || 0.02;

  const outlineMat = new CustomShaderMaterial({
    baseMaterial: new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
    vertexShader: /* glsl */ `
      uniform float uThickness;
      void main() { csm_Position = position + normal * uThickness; }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uOutlineTint;
      void main() { csm_FragColor = vec4(uOutlineTint, 1.0); }
    `,
    uniforms: {
      uThickness: { value: thickness },
      uOutlineTint: { value: tint },
    },
  });

  const skinned = mesh as THREE.SkinnedMesh;
  let shell: THREE.Mesh;
  if (skinned.isSkinnedMesh) {
    const s = new THREE.SkinnedMesh(mesh.geometry, outlineMat as unknown as THREE.Material);
    // Same skeleton + bindMatrix so the shell deforms with the body. The hull is
    // expanded in object space before skinning, so it follows the bones.
    s.bind(skinned.skeleton, skinned.bindMatrix);
    shell = s;
  } else {
    shell = new THREE.Mesh(mesh.geometry, outlineMat as unknown as THREE.Material);
  }
  shell.frustumCulled = false;
  mesh.add(shell);

  return () => {
    mesh.remove(shell);
    // Geometry + skeleton are SHARED with the real mesh; dispose only the material.
    outlineMat.dispose();
  };
}
