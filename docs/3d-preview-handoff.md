# 3D preview fidelity: handoff

Implementation-state handoff for the Locker 3D hero preview work (lighting,
materials, and animated rig). The deep research + phased roadmap live in
[`3d-preview-fidelity-plan.md`](./3d-preview-fidelity-plan.md); this doc is the
"where things actually are and how to continue" companion.

Last updated: 2026-06-16.

## PRs open

Both branches are pushed and have open PRs (cross-repo from the `oldreceipt`
forks into `Slush97:main`; `oldreceipt` has read-only access to the Slush97
repos, so contribution goes through forks). Merge vpkmerge first, then rebuild
its release binary so grimoire's dev build picks it up.

- vpkmerge: https://github.com/Slush97/vpkmerge/pull/23
- grimoire: https://github.com/Slush97/grimoire/pull/187

## TL;DR

The Locker 3D preview now renders the static menu pose lit like in-game: a real
Deadlock IBL probe (image-based lighting) + filmic tonemapping + corrected PBR
materials (roughness/metalness/sheen/glass), on a turntable that pauses while you
hold it. An animated skinned-rig path is fully built but **flagged off** pending
better idle animation. All work is committed on feature branches and now has open
PRs (see "PRs open" below).

## Repos, branches, commits

Two sibling repos under `C:\Users\USER\`:

- **grimoire** (this repo) - branch `feat/3d-preview-fidelity` (off `main`):
  - `693a141` IBL + filmic tonemap + vertex colors
  - `6902643` `.gitattributes` marking `*.hdr` binary (see gotchas)
  - `ed2735b` rigged-export spine (flagged off) + hold-to-pause turntable
- **vpkmerge** (`..\vpkmerge`, the Rust Source 2 toolchain) - branch
  `feat/material-export-fidelity` (off `main`):
  - `36b7492` correct PBR roughness/metalness + sheen/glass export fixes
  - Untracked throwaway audit examples left in `morphic/examples/`
    (`mat_audit.rs`, `param_census.rs`, `sheen_verify.rs`) - not committed.

grimoire's dev build invokes the vpkmerge binary from
`..\vpkmerge\target\release\vpkmerge.exe` (see `devVpkmergeBinaryPath` in
`electron/main/services/modMerger.ts`), so **rebuild vpkmerge after pulling its
branch**: `cargo build --release --manifest-path ..\vpkmerge\Cargo.toml -p vpkmerge-cli`.

## What's shipped (default-on)

1. **IBL + tonemap** (`src/components/locker/HeroPoseViewer.tsx`): a one-time
   PMREM environment from the baked overcast probe (`public/ibl/*.hdr`, 6 faces),
   `ACESFilmicToneMapping` at exposure 0.8, ambient dropped to a warm key + cool
   fill, and `vertexColors` on where a COLOR attribute exists.
2. **Material-export fixes** (vpkmerge `morphic/src/model/glb.rs`): roughness now
   read from the normal-roughness texture's BLUE channel (was the constant alpha,
   which made everything matte), normal-Z reconstructed, constant
   metalness/roughness/color-tint fallbacks, sheen reads `TextureSheenColor1 * tint`
   + binds `g_tSheen`, glass honors `g_flIOR`.
3. **Turntable** (`HeroPoseViewer.tsx` `useTurntable`): slow auto-spin that pauses
   while the user holds/orbits the model (OrbitControls `start`/`end` toggle a
   shared `interaction` ref). Rate is `SPIN_SPEED`.

## What's built but gated/deferred

- **Rigged animated preview** (committed, OFF): full export + cache + IPC +
  `SkinnedMesh`/`AnimationMixer` path, gated behind `USE_RIGGED_PREVIEW = false`
  in `HeroPoseViewer.tsx`. Flip to `true` to bring it back. It works, but the
  single `primary_stand_idle` clip looks rough and too many heroes fall back to a
  bind/A-pose (clipless WIP heroes + mesh skins that ship no clips). Re-enabling is
  task #11. No vpkmerge change is needed for the rig: the no-pose export already
  emits the full skinned + animated glTF.
- **NPR cel/rim/tint shader** (drafted, not applied): the biggest remaining visual
  leap (the actual cel-shaded look). Draft is in the materials-parity workflow
  output; needs `pnpm add three-custom-shader-material` + visual tuning. Task #7.
- **Mis-routed pure-normal materials** (task #8), **g_tRoughness wiring + toon
  outlines** (task #10): see the plan doc's round-2 section.

## Build / run / verify

```
pnpm install
pnpm exec electron-rebuild -f -w better-sqlite3   # native better-sqlite3
pnpm dev                                           # run the app
```

Verification (use these, NOT `pnpm build`):
- `pnpm typecheck` (`tsc -b`) - type-checks main + preload + renderer.
- `pnpm lint` (eslint).
- `pnpm build` is gated on `GRIMOIRE_SOCIAL_BASE_URL` (a production-only env var),
  so it fails locally without it; typecheck + lint are the local gates.

Prereqs that bit us this session:
- **`grimoire-social` sibling repo is required to build** (the
  `@grimoire/social-types` workspace alias resolves to
  `..\grimoire-social\packages\social-types\src\`). If it's missing, the build dies
  on `mods.ts` importing `heroes.ts`. Clone it next to grimoire.
- Deadlock must be installed (pak at
  `C:\Program Files (x86)\Steam\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk`).

Cache versions (in `electron/main/services/heroPoseModels.ts`): bump these to force
a re-export when the export pipeline changes. `POSE_CACHE_VERSION = '6'` (static),
`RIGGED_CACHE_VERSION = '1'` (rigged). Cached glbs live in
`userData/hero-poses/<key>/{model.glb, model-rigged.glb}`.

## Key files

Renderer:
- `src/components/locker/HeroPoseViewer.tsx` - the viewer. `USE_RIGGED_PREVIEW`
  flag, `useTurntable`, `Environment` (PMREM IBL), `PosedModel` (static),
  `RiggedModel` (SkinnedMesh + mixer), the rigged-first/static-fallback loader.

Main process / IPC (rigged spine):
- `electron/main/services/heroPoseModels.ts` - static + rigged export, cache,
  `grimoire-hero:` protocol (serves both `model.glb` and `model-rigged.glb`).
- `electron/main/ipc/portraits.ts`, `electron/preload/index.ts`, `src/lib/api.ts`,
  `src/types/electron.ts` - the `getRiggedHeroPose`/`exportRiggedHeroPose` IPC.
- `electron/main/services/modMerger.ts` - `runVpkmerge`, binary resolution.

vpkmerge (Rust, sibling repo):
- `morphic/src/model/glb.rs` - the glTF writer + all the material-export fixes.
- `morphic/src/model/{pose,animation,skeleton,nm}.rs` - pose bake, clip/skeleton
  decode. `vpkmerge-cli/src/main.rs` - the `model export` CLI (`--pose`,
  `--clip`, `--no-anim`).

Docs: `docs/3d-preview-fidelity-plan.md` (research + roadmap + per-thread
findings), this file.

## Gotchas / non-obvious decisions

- **Roughness lived in the wrong channel.** Deadlock `g_tNormalRoughness` textures
  store roughness in BLUE; alpha is a constant ~1.0 placeholder. The old exporter
  read alpha -> everything matte. Verified safe roster-wide (230+ textures, zero
  inversions).
- **Mis-routed normals (task #8):** some heroes bind a PURE normal map to the
  normal slot where blue is normal-Z, not roughness. Name/slot do NOT distinguish
  them from packed textures (both are `_normal_png`); the reliable discriminator is
  per-texel content (does blue match the normal-Z reconstructed from R,G). The
  drafted slot-name patch from the workflow is WRONG; don't use it.
- **`.hdr` is binary but git misdetects it as text** (no early NUL byte). With
  `core.autocrlf=true` a fresh checkout would CRLF-corrupt the probe faces. The
  `.gitattributes` `*.hdr binary` line prevents this. Keep it.
- **`--clip` is additive**, not first-match: passing a candidate list keeps every
  matching clip (two competing idle loops on some heroes). The rigged export passes
  exactly one (`primary_stand_idle`).
- **A bogus/absent `--clip` is not an error**: the export still emits a valid
  skinned bind-pose glb (anims=0). The viewer treats that as success and renders
  the bind pose without a mixer.
- **IBL probe choice:** `sky_overcast_01` (neutral daylight, mean luminance 0.93)
  beat the moody dusk probe and the misleadingly-named "neutral" probes. Re-bake any
  probe with `vpkmerge cubemap <skybox .vtex_c> --from-vpk <pak> --out-dir <dir>`.
- **Tonemap:** staying on ACES (exposure 0.8); the exact Hable pass is deferred
  until after NPR cel shading lands so exposure is tuned once.
- **Workflow agents can edit source.** The materials-parity workflow's agents
  applied the sheen/glass fixes directly to `glb.rs` (and added throwaway
  examples). They built + passed 99 tests, but it was unprompted; future workflows
  for codegen are run as design/draft (return code as text) and applied by hand.

## Open follow-ups (task list)

- **#7 NPR cel/rim/tint shader** - apply the drafted `three-custom-shader-material`
  module (`src/lib/source2NprMaterial.ts` + HeroPoseViewer edits), gated on
  `userData.morphic`. Needs the dep + visual tuning. Biggest visual leap left.
- **#8 mis-routed pure-normal materials** - content-discriminator fix in `glb.rs`
  (see gotcha above). Headless-verifiable.
- **#10 g_tRoughness wiring + toon outline pass** - recover ghost's authored
  roughness; renderer edge-pass outlines reading `F_SOLID_COLOR_OUTLINE` +
  `g_vSolidOutlineTint` from `userData.morphic`.
- **#11 idle anim quality -> re-enable rigged** - reduce A-pose fallbacks (mesh-skin
  donor-clip retarget, per-hero idle selection), improve the idle, then flip
  `USE_RIGGED_PREVIEW`.

Later roadmap phases (cloth jiggle, custom-anim retargeting, ambient + ability-cast
VFX) are scoped in the plan doc and depend on the rigged spine being on.

## Next sensible step

Either open PRs for the two branches, or pick up task #7 (NPR cel shading) for the
next visible jump. The NPR draft assumes the rigged spine's material identity is
preserved (it is: the SkinnedMesh swap keeps `MeshPhysicalMaterial` instances).
