import * as THREE from 'three';
import CustomShaderMaterial, { type CSMPatchMap } from 'three-custom-shader-material/vanilla';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Source 2 NPR (cel / rim / tint) restyle for the Locker hero preview.
 *
 * React-free. Owns reading the `morphic` extras vpkmerge emits, resolving the
 * NPR mask texture indices, and building the CSM that layers the Deadlock toon
 * look ON TOP of the existing PMREM IBL + ACES tonemap output (it is additive on
 * the lit result, never a replacement pass).
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
 * The three NPR mask slots vpkmerge emits (mirror of NPR_TEXTURE_SLOTS in
 * vpkmerge morphic/src/model/glb.rs). Only these ever appear in morphic.textures.
 *   g_tTintMaskRimLightMask  R = tint enable, G = rim-light constant
 *   g_tNprOutlineMask        where outlines appear
 *   g_tNprTransmissiveColor  NPR transmissive color (deferred in v1)
 */
export const NPR_TEXTURE_SLOTS = [
  'g_tTintMaskRimLightMask',
  'g_tNprOutlineMask',
  'g_tNprTransmissiveColor',
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

/**
 * Resolve the NPR mask texture INDICES on every morphic material in the scene to
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
        NPR_TEXTURE_SLOTS.filter((slot) => typeof indices[slot] === 'number').map(async (slot) => {
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
