# Source 2 preview physics

The preview now uses compiled raw/goal-damped attraction, Kelager bends, directed
twist/swing links, and rope bone reconstruction. The first rendered validation
cases include Seven, Vindicta and Yamato's current base models with three animations each.
Physics remains behind
the existing developer toggle and is disabled by default. This is a tested
preview implementation, not a claim of full Source 2 simulation parity.

## Reproduce the comparison

Run `pnpm dev:cloth` with Deadlock installed and its path saved in Grimoire, or
`pnpm dev:cloth --game "C:\Program Files (x86)\Steam\steamapps\common\Deadlock"`.
The script uses the bundled vpkmerge, exports fresh assets from the base VPK, and
serves `http://127.0.0.1:5176/cloth-preview.html`. `VPKMERGE_PATH` can select another
exporter. Linux/macOS users can provide `--game` explicitly.

For all three cases and the S2V reference, build S2V's CLI in Release, then run:

```powershell
pnpm dev:cloth --case "seven,vindicta,yamato" --s2v "C:\path\to\ValveResourceFormat\CLI\bin\Release\Source2Viewer-CLI.dll"
```

`S2V_CLI` also accepts the CLI path. The script resolves each current model through
the game's hero data, then exports identical clips through both tools. The case
selector lists the exported subset; `necro` is also available for further
investigation. Missing requested clips stop export with an error. Yamato uses
`primary_run275_n/e`, rather than the other cases' `primary_run_n/e` names.
Without S2V, the reference pane uses the vpkmerge animation.

Choose a clip, use Play or Step 1 second, and compare Physics on/off after Reset.
Freeze animation keeps physics advancing against a fixed animated pose. Settle
10 seconds performs that comparison immediately. Run checks compares the real
skinned skeleton at 30, 60, 144 and 360 render FPS; expand Check results or use
Save report to write its measurements, export identity and detached solver
snapshot under `.codex-run/source2-physics/reports`. It shows the saved path.
Step 1 tick advances exactly 1/120 second. Replay to time resets and simulates
from the start, so scrubbing does not reuse stale cloth history. Bind pose lets
the solver run without an animation, separating rest-shape and posed-target errors.

The reference uses the same camera, clip clock and lighting. Neutral material
removes material differences. Align reference motion removes the shared rigid
motion at an animation-owned body control: S2V bakes locomotion into its root
tracks, whereas vpkmerge exports an in-place animation. The report records this
correction and its anchor. It does not deform or rescale the reference rig.
Particle, rod, target, body-shape and bone overlays expose constraint errors;
body penetration and rod limit residuals are reported in Source units.
This page uses the production simulation harness
with a simple Three.js renderer, not Grimoire's complete material pipeline.

Generated GLBs, clips and metadata stay in ignored `.codex-run/source2-physics`.
No game installation files are changed. The page deliberately tests the base VPK,
not the user's effective mod stack. The complete text FeModel replaces the older,
incomplete numerical fixture in `src/lib/__fixtures__/cloth/gigawatt_fe.json`.

## What S2V supplied

Inspected on 2026-09-22:

- Grimoire baseline: `Slush97/grimoire` main
  `c70c89b394394ef24c7763c485e1fa291c0979fe`. Fork main was synchronized first.
- Current S2V master `67da658c2` was pulled and its GUI and CLI built in Release
  with .NET 10.0.303, with zero warnings/errors. The reference pane loads its
  exported animation, not a recording of S2V's renderer or a live cloth solver.
- [S2V PR #1317](https://github.com/ValveResourceFormat/ValveResourceFormat/pull/1317),
  head `c22f897342e53f999bd7c466d648f5bbbe85bafa`, is a draft decompiler, not a
  finished runtime simulator.
- Its [FeModel reader](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/Resource/ResourceTypes/RubikonPhysics/Softbody/FeModel.cs)
  explains compiled integrator selection, animated SIMD rods, signed Kelager
  weights, and the packed rope header. Its authoring-paint reconstruction must
  not be used as a per-frame integration equation.
- Its [jiggle exporter](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/IO/Extract/ModelExtract.JiggleBones.cs)
  preserves the separate jiggle spring/limit model. That runtime remains pending.
- Its FeModel reader identifies the per-node collision radii and the separate
  additional world radius. Runtime tracing corrected an earlier interpretation
  of the reader's world-collision label: local body contacts also use the
  per-node radius. The additional world margin remains separate.
- Its [box reconstruction](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/IO/Extract/ModelExtract.Cloth.Physics.cs)
  identifies compiled `vSize` as half-extents. The preview previously halved
  these again. `ClothBox.halfSize` now preserves the compiled dimensions.
- Current master's [animation exporter](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/67da658c2/ValveResourceFormat/IO/Gltf/GltfModelExporter.Anim.cs)
  documents both cloth-root following and baked locomotion. Vindicta's run clips
  exposed the latter difference directly in the comparison.
- The FeModel reader distinguishes `m_FreeNodes` from simulated particles. It is
  an orientation path for nodes without an explicit reconstructed basis, not an
  allowlist for position integration. Mass and driven-node flags now decide which
  particles simulate. The previous allowlist froze 408 of Yamato's 434 simulated
  particles because they had node bases.
- Its [skin-weight reconstruction](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/Resource/ResourceTypes/RubikonPhysics/Softbody/FeModel.SkinWeights.cs)
  expands soft offsets in serialized order. Each alpha retains the accumulated
  result, with `1 - alpha` assigned to that parent's target. The runtime now
  applies those nested blends after the primary offset, including controls that
  have rendered bones. Static generated controls also receive these positions;
  animation-owned body anchors remain untouched.

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
| Local contact data | `0x131b9b`, `0x229f70` | The compiled per-node radii feed local body contacts as well as world collision. The additional world margin is not added here. |
| Tapered capsule contact | `0x2d8770`, `0x22c500`, `0x235920` | Shift the sampled sphere along the axis by radius slope times radial distance, including the short-capsule endpoint case. |
| Moving-body friction | `0x229ec0`, `0x22a060` | Transform the previous particle through the collider's relative motion, then limit the tangential correction to friction times penetration. Contact changes the current position only. |
| Contact scheduling | `0x244f0b`, `0x24538f`, `0x234dd0` | Compiled flag `0x2000` selects contact after relaxation; otherwise it runs before. Each collider type is visited in reverse serialized order. |
| Fixed rod batches | `0x111bc0` | Visit `m_SimdRods` in compiled order, gathering all four lanes before scattering endpoints. Padding copies within a batch do not add stiffness; repeated constraints in subsequent batches remain. |

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

Fixed rods use the compiled SIMD batches when available. Seven has 40 batches
for 157 scalar rods, Vindicta has 9 for 31, and Yamato has 684 for 2,712. The
extra lanes are preserved as packed, rather than flattened into extra sequential
passes. A malformed packed record reports a decode issue and retains the whole
scalar fallback. Scalar rods also remain available for residual diagnostics.

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
  `0.00000473` meters during the next second. The full rig moves by at most
  `0.0000574` meters, with `0.000733` radians maximum orientation change.
  Authored contact friction substantially reduces the leg-chain motion.
- Front, back and side inspection confirms attached cables/garment bones and no
  exploding mesh in these poses. The physics-off comparison uses the same clip
  time. No matched in-game reference capture has been completed.

The leg-chain integrators have vertex attraction and point damping both zero,
with force attraction approximately `1e-6`. Numerical tests therefore check
bounded motion for those nodes and settling for the damped nodes separately.
`maxFrameMotion` measures successive solved positions, not the damping-modified
Verlet history. A low history-buffer difference is not proof of settling.

The contact corrections and S2V comparison were checked again at 00:46 UTC on
2026-09-22. Seven's 12 cases pass input, anchor and frame-rate checks. Its largest
sampled rod residual is 2.915 Source units, and local body contact depth reaches
0.495 Source units. The checks do not treat these residuals as a collision pass.
Overlapping contacts and continuous collision behavior still need validation.

Vindicta uses `models/heroes_staging/hornet_v3/hornet.vmdl_c`, 20 matched controls,
8 static/12 dynamic nodes, 31 rods, 10 bends and 2 rope chains. All dynamic nodes
are goal-damped. Its same three clips pass all 12 frame-rate/anchor cases, with
zero endpoint body penetration and a maximum rod residual of 1.351 Source units.
After freezing idle for ten seconds, the next second changes positions by less
than `5e-14` meters. Front, back and side inspection shows the attached braid;
the simulated tip differs from the animation-only reference as expected.

With the shared rigid motion aligned, maximum control-position differences
between the two exporters are `6.73e-7` meters for Seven and `2.81e-7` meters for
Vindicta at the tested clip times. The export check allows `1e-5` meters for
float32 coordinate/interpolation error. No in-game visual match is claimed.

## Verification and remaining work

Yamato uses `models/heroes_staging/yamato_v2/yamato.vmdl_c`: 490 controls, 43 static,
434 simulated and 13 back-solved nodes, with 421 node bases and 2,712 rods. Both
exporters omit the same 71 generated controls; all have compiled target drivers.
All 32 required animation inputs are present. Comparing every generated root as
an animation input produced a false failure: S2V pins those roots to one cloth
anchor, whereas vpkmerge follows per-node anchors. Their raw difference remains
in the report, separately from the input check.

At 00:47 UTC, all 12 Yamato cases pass frame-rate, input and anchor checks. The
largest input-position difference is `2.50e-7` meters. The sampled endpoints have
zero measured body penetration and a maximum rod residual of 5.104 Source units.
Correcting the target blends reduced the saved one-second idle rod residual from
14.08 to 4.85 Source units. Some conflicting posed rods join particles whose
force attraction is exactly one; residual alone is not a tuning objective.
After freezing the run pose, the next second after ten seconds changes the full
rig by up to 8.85 mm and the vertex-damped subset by 0.334 mm. Side inspection
still shows excessive forward skirt folds. These results are not sufficient to
enable physics by default. The earlier target-only bind-pose check remained
close to the exported rest shape after eleven seconds, with 0.198 Source units
maximum rod residual; that measurement predates the contact changes.

A separate diagnostic fed both exported rigs through the solver, removing S2V's
shared root motion before each input sample. Their reconstructed target positions
agreed within `9e-7` meters at ticks 1, 120 and 600 across all three clips. Running
cloth positions still diverged over five seconds; neither deterministic FPS
results nor matching inputs establish contact fidelity or in-game parity.

The packed rod update preserves the 12/12 input, anchor and frame-rate checks
on all three cases. Yamato's maximum sampled rod residual remains 5.104 Source
units, but its frozen full-rig motion drops to 2.41 mm and the damped subset to
0.109 mm. Its forward skirt folds remain visible; rod ordering alone does not
explain that shape.

On Windows, 161 focused physics tests, ESLint, TypeScript, i18n key/manifest
checks, and the production build passed. The build uses the public CI value for
`GRIMOIRE_SOCIAL_BASE_URL`. Tests cover coefficient roles, bends, twist/rope
orientation, malformed data, locked anchors, descendant compensation, cleanup,
fixed-step animation, render-FPS equivalence, moving-body friction, contact
scheduling, particle radii, and the complete real-data fixture. The numerical
rest-pose check allows twenty seconds to settle before measuring late motion;
its original 0.005 Source-unit per-tick bound is unchanged.

The preceding foundation stage also ran the full suite: four files failed on
Unix executable/symlink fixtures and CRLF handling (12 tests and one suite setup).
Those failures reproduced in an unchanged baseline checkout. This stage runs the
focused regressions and build; it does not claim the full suite is green.

Next validation units:

1. Isolate generated target shape and node-basis reconstruction against Yamato's
   larger garment. Capture matching Deadlock animation poses to compare
   garment fit, cable curvature, contact and settling.
2. Continue validating overlapping contacts, priority groups, inverted and
   vertex-scoped shapes, and engine instance overrides. A scan of the current VPK's
   40 selectable hero entries found 35 with FeModel data; all examined dynamic
   nodes selected goal-damped integration and had zero authored point damping.
   Raw integration and nonzero damping still need a different reference asset.
3. Add animated rod lengths and a separate jiggle-bone runtime, then validate
   garments using fit matrices/node bases and the effective mod stack.
4. Gate supported model families and define an unsupported-data fallback before
   considering physics enabled by default.

Coverage counts describe the listed constraint families only. Zero pending
counts for Seven do not mean that every FeModel field or engine behavior has
been implemented.
