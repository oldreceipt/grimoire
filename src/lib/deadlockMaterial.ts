import * as THREE from 'three';
import CustomShaderMaterial from 'three-custom-shader-material/vanilla';
import {
  type MorphicExtras,
  type NprTuning,
  DEFAULT_NPR_TUNING,
  NPR_VERTEX,
  NPR_FRAGMENT,
  NPR_PATCH_MAP,
  getMorphic,
  flag,
  firstNumber,
  vectorColor,
  isMeaningfulMask,
  whiteFallback,
} from './source2NprMaterial';

type Source2BlendMode = NonNullable<MorphicExtras['blend_mode']>;

/**
 * Unified Deadlock NPR material builder (the Phase 0/1 single build pass).
 *
 * This is the one-build-pass replacement for the old two-pass
 * applySource2MaterialHints + wrapMaterialWithNpr pipeline. It collapses both
 * into a single call that:
 *   1. clones the GLTF base material into a material WE OWN (the base is NEVER
 *      mutated, so teardown is just dispose + restore the original reference),
 *   2. decides ALL Source 2 material state once on that owned clone (glass /
 *      translucent / additive / self-illum / sheen / backfaces / unlit / jitter),
 *   3. wraps the owned clone in the CSM carrying the cel + rim + tint + self-illum
 *      scroll GLSL (reused verbatim from source2NprMaterial.ts).
 *
 * Because the CSM is handed the throwaway owned clone (never the live GLTF base),
 * CSM's in-place onBeforeCompile / __csm mutation lands on the clone we own and
 * dispose, so unwrapNprBase is NOT needed on this path.
 *
 * Clone-up safety (load-bearing, learned from the spike): a fresh material is
 * created and the base is copied into it via
 * THREE.MeshStandardMaterial.prototype.copy.call(clone, base). Two crashes are
 * dodged this way:
 *   (a) MeshPhysicalMaterial.copy(standardSource) reads physical-only fields
 *       (clearcoatNormalScale, attenuationColor, ...) off the standard source and
 *       throws "Cannot read properties of undefined (reading 'x')". Routing
 *       through MeshStandardMaterial.prototype.copy only copies the standard
 *       fields both share.
 *   (b) Material.copy does JSON.parse(JSON.stringify(userData)), which throws on
 *       the THREE.Texture objects in userData.morphic.resolvedTextures. So the
 *       base's userData is cleared across the copy, then the ORIGINAL userData
 *       object is assigned to the clone BY REFERENCE (shared morphic extras,
 *       treated as immutable -- we only write material properties, never through
 *       userData.morphic).
 *
 * We clone up to MeshPhysicalMaterial only when physical features are needed
 * (F_GLASS, or F_SHEEN on a physical source); otherwise a MeshStandardMaterial
 * clone is sufficient. The choice is made once, up front, from the morphic flags.
 */

export interface DeadlockMaterialResult {
  /**
   * The CSM wrapping the owned clone. NOT instanceof MeshPhysicalMaterial (CSM
   * extends THREE.Material); it carries the clone's copied
   * isMeshStandardMaterial / isMeshPhysicalMaterial flags + proxied `type`, which
   * is what the renderer keys IBL/PMREM/transmission on. Do NOT feed this to code
   * that does `instanceof MeshPhysicalMaterial`.
   */
  material: THREE.Material;
  /** Per-material uniforms; mutate uTintColor.value for live recolor without a rebuild. */
  uniforms: Record<string, THREE.IUniform>;
  /** Mask clones THIS build created and is responsible for disposing on teardown. */
  ownedTextures: THREE.Texture[];
  /**
   * Tears down everything THIS build owns: the CSM, the owned base clone (CSM's
   * inherited dispose() does NOT free its base material -- failing to dispose the
   * clone leaks one material + its env program per hero load), and the owned mask
   * clones. The GLTF base is never mutated, so the caller only needs to restore
   * the original mesh.material reference after calling this.
   */
  dispose: () => void;
}

/**
 * Decide whether the owned clone must be a MeshPhysicalMaterial. Glass needs the
 * built-in transmission render pass; sheen needs the physical sheen lobe. A
 * MeshStandardMaterial clone is enough for everything else (translucent goo is an
 * alpha-blend, NOT a transmission material -- spike finding).
 */
function needsPhysical(morphic: MorphicExtras, base: THREE.Material): boolean {
  if (flag(morphic, 'F_GLASS')) return true;
  // Sheen is only meaningful when the source already exposes the physical lobe;
  // upgrading a plain standard material just for sheen is out of scope for v1.
  if (flag(morphic, 'F_SHEEN') && (base as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    return true;
  }
  return false;
}

function fallbackBlendMode(morphic: MorphicExtras): Source2BlendMode {
  if (flag(morphic, 'F_ADDITIVE_BLEND')) return 'additive';
  if (flag(morphic, 'F_TRANSLUCENT') || flag(morphic, 'F_ADVANCED_TRANSLUCENCY')) {
    return 'blend_zwrite';
  }
  return 'opaque';
}

function hasValidSelfIllum(morphic: MorphicExtras, tex: THREE.Texture | undefined): boolean {
  if (typeof morphic.self_illum_valid === 'boolean') {
    return morphic.self_illum_valid && tex !== undefined;
  }
  return isMeaningfulMask(tex);
}

/**
 * Clone the GLTF base into an OWNED material, dodging both clone-up crashes (see
 * the module doc). The morphic extras object is shared by reference (immutable).
 */
function cloneOwned(base: THREE.Material, physical: boolean): THREE.MeshStandardMaterial {
  const clone = physical
    ? new THREE.MeshPhysicalMaterial()
    : new THREE.MeshStandardMaterial();

  // (b) Material.copy serializes userData via JSON; the resolvedTextures hold
  // THREE.Texture objects that throw on JSON.stringify. Clear it across the copy,
  // restore the base's reference after, and share the SAME object onto the clone.
  const baseUserData = base.userData;
  base.userData = {};
  try {
    if (physical && (base as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      // Physical source: keep the source's physical fields (ior, transmission,
      // sheen, clearcoat, physical maps). This path is safe because the source
      // actually has the physical-only fields MeshPhysicalMaterial.copy reads.
      THREE.MeshPhysicalMaterial.prototype.copy.call(clone, base);
    } else {
      // Standard source: route through MeshStandardMaterial.prototype.copy so a
      // physical clone does not read physical-only fields off the source and crash.
      THREE.MeshStandardMaterial.prototype.copy.call(clone, base);
    }
  } finally {
    base.userData = baseUserData;
  }
  if (physical) {
    // MeshStandardMaterial.copy resets defines to STANDARD only. Restore PHYSICAL
    // so three compiles the IOR/transmission path on the physical clone.
    clone.defines = { ...(clone.defines ?? {}), STANDARD: '', PHYSICAL: '' };
  }
  // Share the morphic extras BY REFERENCE (immutable; only material props are
  // written, never through userData.morphic). This also lets isNprMaterial /
  // getMorphic resolve off the clone if ever needed.
  clone.userData = baseUserData;
  return clone;
}

/**
 * Build the unified Deadlock NPR material for an NPR-eligible base material. The
 * caller is responsible for the isNprMaterial gate; this assumes morphic exists.
 *
 * NEVER mutates `base`. Returns the CSM + uniforms + owned textures + dispose.
 */
export function buildDeadlockMaterial(
  base: THREE.Material,
  tuning: NprTuning = DEFAULT_NPR_TUNING,
  tintOverride: THREE.Color | null = null
): DeadlockMaterialResult {
  const morphic = getMorphic(base)!;

  // --- Decide the clone class once, then clone. -----------------------------
  const physical = needsPhysical(morphic, base);
  const clone = cloneOwned(base, physical);
  const phys = clone as THREE.MeshPhysicalMaterial;

  // Mask clones THIS build owns and disposes (the tint/rim mask handed to the
  // CSM, plus any mask assigned as alphaMap / emissiveMap / displacementMap on
  // the owned clone). The shared white fallback is NEVER disposed.
  const ownedTextures: THREE.Texture[] = [];
  function ownClone(tex: THREE.Texture): THREE.Texture {
    const c = tex.clone();
    c.needsUpdate = true;
    ownedTextures.push(c);
    return c;
  }

  // --- Material-state flags (ported from applySource2MaterialHints). --------
  const glass = flag(morphic, 'F_GLASS');
  const blendMode = morphic.blend_mode ?? fallbackBlendMode(morphic);
  const alphaBlend = blendMode === 'blend_zwrite' || blendMode === 'blend' || blendMode === 'additive';
  const additive = blendMode === 'additive';
  const unlit = flag(morphic, 'F_UNLIT');
  const sheen = flag(morphic, 'F_SHEEN');
  const backfaces = flag(morphic, 'F_RENDER_BACKFACES');

  if (backfaces) clone.side = THREE.DoubleSide;

  if (glass) {
    // F_GLASS keeps the current treatment: transmission is for GLASS ONLY.
    clone.roughness = Math.min(clone.roughness ?? 1, 0.18);
    clone.metalness = Math.min(clone.metalness ?? 0, 0.05);
    clone.envMapIntensity = Math.max(clone.envMapIntensity ?? 1, 1.35);
    phys.transmission = Math.max(phys.transmission ?? 0, 0.85);
    phys.thickness = Math.max(phys.thickness ?? 0, 0.12);
    phys.ior = firstNumber(morphic, ['g_flIOR'], phys.ior ?? 1.5);
    phys.clearcoat = Math.max(phys.clearcoat ?? 0, 0.45);
    phys.clearcoatRoughness = Math.min(phys.clearcoatRoughness ?? 0.25, 0.18);
  }

  if (alphaBlend) {
    // The goo: transparent alpha path, NEVER transmission (spike finding:
    // transmission makes the goo invisible; the green goo look comes from alpha).
    const alphaMask =
      morphic.resolvedTextures?.g_tAltTranslucency ?? morphic.resolvedTextures?.g_tGlass;
    clone.transparent = true;
    // Translucent goo keeps depthWrite ON so it occludes the opaque interior
    // (Viscous's black gear / "bones"). depthWrite=false x-rays every interior
    // layer at once. Additive glow (below) still needs it off.
    clone.depthWrite = blendMode === 'blend_zwrite';
    clone.opacity = Math.min(
      clone.opacity,
      firstNumber(morphic, ['g_flOpacityScale1', 'TextureOpacity1'], glass ? 0.72 : 0.62)
    );
    if (isMeaningfulMask(alphaMask)) {
      clone.alphaMap = ownClone(alphaMask);
      clone.alphaTest = Math.max(clone.alphaTest ?? 0, 0.01);
    }
  }

  if (additive) {
    clone.blending = THREE.AdditiveBlending;
    clone.depthWrite = false;
  }

  // --- Self-illum: real mask + real scale ONLY (milky-white guard). ----------
  // viscous_body/ball carry F_SELF_ILLUM with a placeholder 4x4 mask, default
  // white tint, and 0.02 scale; the old gate turned that into a full white glow
  // (the milky-white body). Fire only on a meaningful mask, and the CSM owns the
  // scrolling glow. Zero the CLONE's baked emissive so there is no double-green
  // (no __nprPrevEmissiveIntensity stamp needed: the clone is owned, not the base).
  const selfIllumMap = morphic.resolvedTextures?.g_tSelfIllumMask;
  const hasSelfIllum = hasValidSelfIllum(morphic, selfIllumMap);
  if (unlit && clone.emissive) {
    clone.emissive.copy(clone.color ?? new THREE.Color(1, 1, 1));
    clone.emissiveIntensity = Math.max(clone.emissiveIntensity ?? 1, 1.2);
    clone.toneMapped = false;
  }

  // The CSM patch reads the GLB-baked emissive before its patch runs -> double
  // glow. Zero it last whenever the NPR path owns self-illum, even if F_UNLIT
  // also tried to populate emissive above.
  if (hasSelfIllum) clone.emissiveIntensity = 0;

  if (sheen && phys.isMeshPhysicalMaterial) {
    phys.sheen = Math.max(phys.sheen ?? 0, 0.65);
    phys.sheenRoughness = firstNumber(
      morphic,
      ['TextureSheenRoughness1', 'g_flSheenRoughness'],
      phys.sheenRoughness ?? 0.45
    );
    phys.sheenColor.copy(
      vectorColor(morphic.vectors?.TextureSheenColor1 ?? morphic.vectors?.g_vSheenColorTint1, phys.sheenColor)
    );
  }

  const jitterMask = morphic.resolvedTextures?.g_tJitterMask;
  if (flag(morphic, 'F_JITTER_VERTICES') && isMeaningfulMask(jitterMask)) {
    // Jitter is approximated by a displacement map for v1 (harmless on low-poly).
    clone.displacementMap = ownClone(jitterMask);
    clone.displacementScale = Math.max(clone.displacementScale ?? 0, 0.01);
    clone.displacementBias = clone.displacementBias ?? 0;
  }

  clone.needsUpdate = true;

  // --- CSM uniforms (cel + rim + tint + self-illum scroll). ------------------
  // Default tint is white (identity); g_vColorTint1 is already baked into the
  // base color factor by vpkmerge, so it must NOT be re-applied here.
  const sharedTint = morphic.resolvedTextures?.g_tTintMaskRimLightMask;
  const tintMask = sharedTint ? ownClone(sharedTint) : null;
  const tintColor = tintOverride ?? new THREE.Color(1, 1, 1);

  let illumMap: THREE.Texture | null = null;
  if (hasSelfIllum && selfIllumMap) {
    // Scroll wraps via fract(), so the sampler must repeat or the seam smears.
    illumMap = ownClone(selfIllumMap);
    illumMap.wrapS = THREE.RepeatWrapping;
    illumMap.wrapT = THREE.RepeatWrapping;
    illumMap.needsUpdate = true;
  }
  const siScroll =
    morphic.vectors?.g_vSelfIllumScrollSpeed1 ?? morphic.vectors?.g_vSelfIllumScrollSpeed;
  const siTint = vectorColor(
    morphic.vectors?.g_vSelfIllumTint1 ?? morphic.vectors?.g_vSelfIllumTint,
    new THREE.Color(0, 0, 0)
  );
  // Use the real scale (viscous_head = 0.629); never floor to 1 (milky-white guard).
  const siScale = firstNumber(morphic, ['g_flSelfIllumScale1', 'g_flSelfIllumScale'], 0);

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
    uCelV2: { value: 0.0 },
    uTintColor: { value: tintColor },
    uTintRimMask: { value: tintMask ?? whiteFallback() },
    uHasTintMask: { value: tintMask ? 1.0 : 0.0 },
    uTime: { value: 0 },
    uSelfIllumMap: { value: illumMap ?? whiteFallback() },
    uHasSelfIllum: { value: hasSelfIllum ? 1.0 : 0.0 },
    uSelfIllumScroll: { value: new THREE.Vector2(siScroll?.[0] ?? 0, siScroll?.[1] ?? 0) },
    uSelfIllumTint: { value: siTint },
    uSelfIllumScale: { value: siScale },
  };

  // Wrap the OWNED clone (never the live base) so CSM's in-place mutation lands
  // on the throwaway clone we dispose. No unwrapNprBase needed on this path.
  const csm = new CustomShaderMaterial({
    baseMaterial: clone as THREE.MeshPhysicalMaterial,
    vertexShader: NPR_VERTEX,
    fragmentShader: NPR_FRAGMENT,
    uniforms,
    patchMap: NPR_PATCH_MAP,
  });

  const dispose = () => {
    // CSM.dispose does NOT free its base material, so dispose the owned clone
    // separately, plus every mask clone this build created.
    csm.dispose();
    clone.dispose();
    ownedTextures.forEach((t) => t.dispose());
  };

  return {
    material: csm as unknown as THREE.Material,
    uniforms,
    ownedTextures,
    dispose,
  };
}
