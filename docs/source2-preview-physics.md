# Source 2 preview physics

The preview now uses compiled raw/goal-damped attraction, Kelager bends, directed
twist/swing links, and rope bone reconstruction. The first rendered validation
case is Seven's current base model with three animations. Physics remains behind
the existing developer toggle and is disabled by default. This is a tested
preview implementation, not a claim of full Source 2 simulation parity.

## Reproduce the comparison

Run `pnpm dev:cloth` with Deadlock installed and its path saved in Grimoire, or
`pnpm dev:cloth --game "C:\Program Files (x86)\Steam\steamapps\common\Deadlock"`.
The script uses the bundled vpkmerge, exports fresh assets from the base VPK, and
serves `http://127.0.0.1:5176/cloth-preview.html`. `VPKMERGE_PATH` can select another
exporter. Linux/macOS users can provide `--game` explicitly.

Choose a clip, use Play or Step 1 second, and compare Physics on/off after Reset.
Freeze animation keeps physics advancing against a fixed animated pose. Settle
10 seconds performs that comparison immediately. Run checks compares the real
skinned skeleton at 30, 60, 144 and 360 render FPS; expand Check results or use
Save report for its measurements and export identity. Camera controls and Show
bones help inspect attachments. This page uses the production simulation harness
with a simple Three.js renderer, not Grimoire's complete material pipeline.

Generated GLBs, clips and metadata stay in ignored `.codex-run/source2-physics`.
No game installation files are changed. The page deliberately tests the base VPK,
not the user's effective mod stack. The complete text FeModel replaces the older,
incomplete numerical fixture in `src/lib/__fixtures__/cloth/gigawatt_fe.json`.

## What S2V supplied

Inspected on 2026-09-22:

- Grimoire baseline: `Slush97/grimoire` main
  `c70c89b394394ef24c7763c485e1fa291c0979fe`. Fork main was synchronized first.
- [S2V PR #1317](https://github.com/ValveResourceFormat/ValveResourceFormat/pull/1317),
  head `c22f897342e53f999bd7c466d648f5bbbe85bafa`, is a draft decompiler, not a
  finished runtime simulator.
- Its [FeModel reader](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/Resource/ResourceTypes/RubikonPhysics/Softbody/FeModel.cs)
  explains compiled integrator selection, animated SIMD rods, signed Kelager
  weights, and the packed rope header. Its authoring-paint reconstruction must
  not be used as a per-frame integration equation.
- Its [jiggle exporter](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/IO/Extract/ModelExtract.JiggleBones.cs)
  preserves the separate jiggle spring/limit model. That runtime remains pending.

Grimoire calls `vpkmerge model femodel`, which already serializes the raw KV3
subtree. This path does not consume morphic's typed Rust FeModel, so the missing
decoding and runtime behavior belong in Grimoire. No exporter rewrite was needed.

## Runtime evidence and implemented behavior

Runtime equations were independently traced in the installed Windows x64
`game/bin/win64/vphysics2.dll`, SHA-256
`66b65fd571d8b301ed55fef5ced8ad2ed1206c67dedbd44782cd7c70bdb17ebe`.
Addresses below are RVAs for that exact binary, not stable API entry points.

| Runtime path | RVA | Preview behavior |
| --- | --- | --- |
| Goal-damped attraction | `0x2dd100` | Force attraction blends position toward the goal; vertex attraction blends history toward the new position. Near-unit force resets both buffers. |
| Raw attraction | `0x244411` | With `p = clamp(VA * dt)` and `f = 2 * FA * dt`, position receives `(goal - position) * (p + f)` and history receives `(goal - position) * p * (1 - p)`. |
| Relaxation schedule | `0x2448ef`, `0x244fa0` | One base pass plus extra iterations, capped at 256. Goal passes run at the end of relaxation, with their own extra count. |
| Kelager bends | `0x10d870` | Project the middle node's centroid-height excess using the three compiled signed weights directly. Do not clamp them to inverse masses. |
| Twist/swing reconstruction | `0x105f70` | Reconstruct the directed segment from its rest axis and the end node's relative rotation, then relax twist and swing separately. |
| Rope reconstruction | `0x105bf0` | Align each animated X axis with its solved segment. Two-node tips keep their own animated twist; longer chains copy the penultimate rotation to the tip. |

The rope direction sign is recovered from the first rest segment and its bone X
axis, since the runtime flip bitset is not exported. All 23 Seven chains use the
positive sign. Degenerate links retain the animated orientation. These are
translations of the inspected operations, not a bit-identical engine port;
global engine modifiers and contact behavior still need separate validation.

`feModel.ts` validates rope offsets/node runs, twist indices/weights, signed bend
records, and integrator selectors. Malformed records produce decode diagnostics
instead of fabricated node-zero links. Animated rod connections remain separate
from fixed-length scalar rods. Unknown integrator selectors retain the earlier
preview approximation; coefficient magnitudes are not used to guess a mode.

The shared 1/120-second clock advances animation before targets/colliders and
simulation. Physics-written local transforms are restored before each clean
animation sample. Rotation-free static cloth bases can rotate, while the body's
rotation-locked prefix stays animation-owned. Descendant attachment positions and
orientations are compensated when a simulated ancestor moves. Disposal restores
the clean pose. Known integrators no longer receive the old artificial damping
floor; Seven's authored point damping is zero. Nonzero point damping on other
models is still a preview approximation requiring a separate reference case.

## Exact rendered case

Exported with vpkmerge 0.19.0 at `2026-09-21T22:16:39.957Z`:

- Entry: `models/heroes_staging/gigawatt_prisoner/gigawatt_prisoner.vmdl_c`.
- Clips: `primary_stand_idle`, `primary_run_n`, `primary_run_e`.
- VPK directory SHA-256:
  `922c1145ea203bf48c4987653139b94f301fbaf0ffbd92d3596c5549ebdebbca`.
- GLB SHA-256:
  `ad8b666a2a85067ad50b3432a65de734a6f5d196d84dc7a6b7536257a9114078`.
- Raw FeModel SHA-256:
  `d6d60358acd5717ec9fc238dd43e30d68e9c65d156fe45a5532cbfc13a62de7c`.

The GLB has 231 skeleton joints and seven skinned primitives. All 131 FeModel
controls match bones. Bind-fit RMSE is `0.00001424` Source units. Its 57 static
and 74 dynamic nodes use 157 rods, 18 bends, 42 directed twists and 23 rope chains.
The complete selector fields identify all 74 dynamic nodes as goal-damped. This
case has no animated rods, jiggle bones, fit matrices, or node bases.

Five seconds per clip at each of the four frame rates gives 600 simulation ticks:

- All 12 cases stay finite. Solved world positions are identical across FPS;
  quaternion angle differences are below `6e-8` radians (roundoff).
- Body anchor positions are unchanged from physics-off animation; all 57 static
  positions differ by less than `7.1e-16` meters. This caught and fixed a real
  attachment drift that solver-space anchor metrics alone missed.
- After freezing `primary_run_e` for ten seconds, damped cloth moves at most
  `0.00000741` meters during the next second. Its largest orientation change is
  `0.01856` radians. The undamped leg chain still moves by up to `0.02923` meters;
  the full model is not claimed to have settled.
- Front, back and side inspection confirms attached cables/garment bones and no
  exploding mesh in these poses. The physics-off comparison uses the same clip
  time. No matched in-game reference capture has been completed.

The leg-chain integrators have vertex attraction and point damping both zero,
with force attraction approximately `1e-6`. Numerical tests therefore check
bounded motion for those nodes and settling for the damped nodes separately.
`maxFrameMotion` measures successive solved positions, not the damping-modified
Verlet history. A low history-buffer difference is not proof of settling.

## Verification and remaining work

On Windows, 141 focused physics tests, ESLint, TypeScript, i18n key/manifest
checks, and the production build passed. The build uses the public CI value for
`GRIMOIRE_SOCIAL_BASE_URL`. Tests cover coefficient roles, bends, twist/rope
orientation, malformed data, locked anchors, descendant compensation, cleanup,
fixed-step animation, render-FPS equivalence, and the complete real-data fixture.

The preceding foundation stage also ran the full suite: four files failed on
Unix executable/symlink fixtures and CRLF handling (12 tests and one suite setup).
Those failures reproduced in an unchanged baseline checkout. This stage runs the
focused regressions and build; it does not claim the full suite is green.

Next validation units:

1. Capture matching Deadlock animation poses and compare garment fit, cable
   curvature, contact and settling. Audit the inherited body-contact radius
   policy, collision scheduling and friction against that reference. Positional
   contact projection is still an approximation and can alter inferred velocity.
2. Validate a raw-integrator asset and nonzero point damping in a rendered rig.
   The raw path currently has isolated equation tests, not Seven coverage.
3. Add animated rod lengths and a separate jiggle-bone runtime, then validate
   garments using fit matrices/node bases and the effective mod stack.
4. Gate supported model families and define an unsupported-data fallback before
   considering physics enabled by default.

Coverage counts describe the listed constraint families only. Zero pending
counts for Seven do not mean that every FeModel field or engine behavior has
been implemented.
