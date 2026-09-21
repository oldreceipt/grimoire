# Source 2 preview physics

The first implementation stage preserves compiled physics data and establishes an
animation boundary that can support comparisons of different solver behaviors.
The existing cloth feature flag remains disabled by default. This stage does not
claim Source 2 simulation parity.

## Reference and scope

Inspected on 2026-09-22:

- Grimoire baseline: `Slush97/grimoire` main `c70c89b394394ef24c7763c485e1fa291c0979fe`.
  The `oldreceipt/grimoire` fork main matched that commit before work began.
- [S2V PR #1317](https://github.com/ValveResourceFormat/ValveResourceFormat/pull/1317),
  head `c22f897342e53f999bd7c466d648f5bbbe85bafa`. This is a draft decompiler.
- [FeModel reader](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/Resource/ResourceTypes/RubikonPhysics/Softbody/FeModel.cs):
  `BuildAnimRods`, `UsesGoalDampedIntegrator`, and the `m_KelagerBends` constructor path.
- [Jiggle-bone exporter](https://github.com/w1tcherrr/ValveResourceFormat/blob/c22f897342e53f999bd7c466d648f5bbbe85bafa/ValveResourceFormat/IO/Extract/ModelExtract.JiggleBones.cs).

Grimoire invokes `vpkmerge model femodel`, which serializes the raw KV3 subtree.
It does not consume morphic's typed Rust FeModel. Decoder work for the preview
therefore belongs in `src/lib/feModel.ts`.

## Implemented in this stage

- Kelager bends preserve their three `nNode` indices, signed `flWeight` values,
  and `flHeight0`. Invalid records produce decode diagnostics rather than
  fabricated node-zero references. The shipped Gigawatt fixture checks all 18
  records against its original JSON.
- Animated rod connections are retained from `m_SimdRodsAnim`, including flat and
  nested two-by-four SIMD layouts. Repeated padding lanes are deduplicated while
  retaining endpoint order and its corresponding weight. They stay separate from
  scalar rods because the file does not provide the same fixed length limits.
- Static/dynamic flags and the dynamic-node integrator bitset are preserved.
  Explicit selectors distinguish raw and goal-damped modes. Missing selectors,
  truncated bitsets, and mixed band flags without a node bitset remain unknown.
  We deliberately do not infer an update algorithm from coefficient magnitudes.
- Harness coverage reports distinguish existing rod support from decoded bends,
  twists, animated rods and jiggle bones that still need runtime implementations.
- Animation and physics share a 1/120-second clock with bounded catch-up and
  suspended-frame handling. Only bones written by physics are restored before
  the next animation update. Body anchors retain their animation-owned pose;
  unkeyed cloth channels recover the last clean animated pose.
- Disposal restores physics-written bones, including when cloth is disabled or
  the loaded model changes. Debug geometry is disposed when replaced.

The animation boundary builds on the earlier parked cloth work without importing
its garment surface projection or extra body proxies. The original stash is kept.

## Validation and limits

Regression checks exercise the real Gigawatt data, malformed records, SIMD lane
packing, integrator bit indices across word boundaries, moving/rotating anchors,
partially keyed animation channels, cleanup, pauses, and matching simulated poses
at 30, 60, 144 and 360 render FPS. R3F hook tests cover disabled/unmatched models,
toggling physics, nested bones, and unmount cleanup. The existing stability tests remain useful for
numerical regressions; they do not prove garment drape or animation fidelity.

Local verification on Windows:

- 124 focused physics/preview tests passed.
- ESLint, TypeScript, the i18n key/manifest checks, and the production build passed.
  The build used the repository's public CI value for `GRIMOIRE_SOCIAL_BASE_URL`.
- The full suite reached 101 passing test files. Four files had failures involving
  Unix executable/symlink fixtures and CRLF handling (12 failed tests and one suite
  setup failure). The same failures reproduced in an isolated, unchanged checkout
  of the baseline commit. No unrelated production code or tests were changed.

The actual force/attraction update is still the previous preview approximation.
Reported integrator modes classify data only. S2V's formulas for reconstructing
authoring paint must not be mistaken for per-frame solver equations. The existing
Gigawatt fixture omits integrator selector fields, so its 74 dynamic nodes are
reported as unknown until a complete current extraction is used.

## Next validation units

1. Extract a complete current FeModel alongside the exact rigged hero and animation
   from the same effective VPK stack. Record asset identity and selector fields.
2. Validate raw and goal-damped runtime updates separately against a controlled
   animated reference. Remove the preview damping floor only with evidence that
   the authored update supplies the expected settling behavior.
3. Implement one bend constraint and one twist/swing link, checking node motion and
   reconstructed bone rotation together. Extend to the Gigawatt chain after those
   isolated cases pass. Implement animated rod lengths from verified animation
   targets rather than inventing static limits.
4. Add a dedicated jiggle-bone runtime using its spring/limit parameters, then test
   a garment with fit matrices and node bases. Keep rendering and simulation
   ownership separate.
5. Compare real skinned animation with Deadlock for attachment, bending, clipping
   and settling. Enable physics by default only after supported model families
   pass rendered validation and unsupported behavior has a deliberate fallback.
