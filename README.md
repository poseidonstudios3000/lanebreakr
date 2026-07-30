# OVRRUN

A 3v3, single-lane, 12-minute MOBA played as a shooter, with a free FPS/TPS
camera toggle. Browser-first, TypeScript, Three.js.

```bash
pnpm install
pnpm dev          # → http://localhost:5173
```

`WASD` move · `Space` jump/vault/mantle · `Shift` dash · `C` slide · `F` zipline
`V` camera · `RMB` hold to ADS · `R` reload · `MMB` melee · `M` mute

## The one rule

**`packages/sim` never imports Three.js, never touches `window`, never reads
wall-clock time, and never calls an unportable `Math.*`.**

Everything else is replaceable. Follow this and the project goes from
single-player prototype to netcoded multiplayer without a rewrite; break it and
it dies at M4. It is enforced in CI by the purity guard in `eslint.config.js`,
not by convention — an acceptance criterion nothing checks is a comment.

## Layout

```
packages/sim      ⚠️ PURE. tick(world, inputs) -> void, 60Hz, byte-reproducible
  balance.ts      ⭐ every tunable number in the game, single file
  mathd.ts        portable sin/cos/atan2 from + - * / and sqrt only
  rng.ts          stateless rngFor(tick, entityId, salt)
packages/client   THREE renderer, input, camera, procedural audio, HUD
docs/derived      cross-verified constants awaiting their milestone
```

## Verify

```bash
pnpm typecheck
pnpm lint          # includes the sim purity guard
pnpm test          # determinism, M0 acceptance, balance invariants
pnpm determinism   # the 10,000-tick hash on its own
```

## Working on it

Read `PRD.md` and `STATE.md`, in that order. `STATE.md` carries one row per
acceptance criterion and the per-gate iteration counters that make §13's kill
criteria enforceable. Record every decision in `DECISIONS.md`; anything not in
the PRD goes to `BACKLOG.md` rather than into the code.
