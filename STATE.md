# STATE

Machine-maintained. The RALPH loop (PRD §13) reads this first and writes it last.
One row per PRD acceptance criterion. **Never advance a milestone until every
row in it reads PASS.**

```
CURRENT MILESTONE : M3 — Combat & Bots (in progress)
LAST UPDATED      : 2026-07-31 (overnight session)
TESTS             : 145 passing, 7 files
REPO              : github.com/poseidonstudios3000/lanebreakr
PLAY              : pnpm dev → localhost:5173
                    /?map=strip           THE STRIP, 3v3 vs bots
                    /?map=strip&bots=hard difficulty: easy | normal | hard
                    /                     M0 grey box range
```

## Gate iteration counters

§13's kill criteria count iterations, and nothing persisted a counter across a
context reset. These are that counter. **Increment on every iteration that
targets the gate.**

| Gate | Iterations | Kill at | Status |
|---|---|---|---|
| M0 fun gate | 2 | 3 | **PASSED** — human verdict 2026-07-31: "feel like fun already" |
| M3 addictive-solo gate | 0 | — | not yet run (needs 10 human matches) |
| M4 p95 correction trend | 0 | no improvement across 3 sessions | not started |
| M8 match-length variance | 0 | ±3 min | not started |

---

## M0 — Feel Prototype ✅ COMPLETE (gate passed)

| Criterion | Status |
|---|---|
| 60fps stable, p99 over 600 frames, at a named tier | **PARTIAL** — HUD reports it live; `tools/perf-harness` not built, tier not pinned |
| Camera transition ≤0.15s, no clipping | PASS |
| Mantle 1.2m and 2.4m ledges | PASS |
| Zipline traverses full length | PASS |
| Slide preserves ≥80% of entry speed | PASS |
| `tools/peek-test` green against a stub bot | **FAIL** — `canSee()` now exists, the harness does not |
| **Gate: is moving and shooting fun with zero content?** | **PASS** (human) |

## M1 — Sim Core (mostly complete)

| Criterion | Status |
|---|---|
| `tick()` zero THREE/DOM imports, CI-enforced | PASS — purity guard in `eslint.config.js` |
| Identical 10,000-tick hash in Node | PASS |
| Identical hash in **Chrome and Firefox** via Playwright | **FAIL** — CI job not built |
| `mathd.ts` + `Math.*` ban green | PASS |
| Physics gate: 10k sweeps, zero tunneling/stuck | **FAIL** — swept collision exists, the gate does not |
| `.ovr` as `{seed, build_hash, balance_hash, input_log}` | **FAIL** — not built |
| Sim runs headless in Node | PASS |

## M2 — Lane ✅ COMPLETE

| Criterion | Status |
|---|---|
| Wave every 25s, walks, engages | PASS — clashes over MID PIT at 0:54, asserted |
| Orbs drop, claim/deny, expire, ownership resolves | PASS |
| Towers target nearest trooper, switch on hero-damages-allied-**hero** | PASS |
| Roofs reachable from ground | PASS (cover → one mantle → deck) |
| Match ends when a core dies | PASS |

## M3 — Combat & Bots ◀ CURRENT

| Criterion | Status |
|---|---|
| Bots exist, three tiers, behaviour tree | **PASS** |
| Bot target acquisition gated on `canSee()` | **PASS** — asserted directly |
| A complete match is winnable and loseable vs bots | **PARTIAL** — playable and it terminates; see the limitation below |
| TTK inside band as an analytic unit test | PASS (`balance.test.ts`) |
| All 4 heroes with full kits | **FAIL** — one weapon (SMG) and one ability (GLITCH BOMB) so far |
| All 12 upgrades functional with visible model changes | **FAIL** — specified in `balance.ts`, not implemented |
| `packages/telemetry` emits Q1 camera-toggle events | **FAIL** |
| **Gate: play 10 matches. Is it addictive solo?** | not run |

### Beyond the PRD — built from `docs/DIRECTION.md`

| Item | Status |
|---|---|
| **GLITCH BOMB** (D0a) | **DONE** — Q, 1.8s scramble, 11 tests, 6 of them asserting the design bar rather than the behaviour |
| **Emote + ping wheel** (D1) | **DONE** — Z pings, X emotes, shared budget, pings team-only |
| Reduced-effects accessibility toggle | **DONE** — G |
| Tone decision (D0) | **RECORDED** — art pass not started |

---

## ⚠ KNOWN LIMITATION — bot-vs-bot lane stalemate

Two symmetric behaviour-tree bot teams hold the wave equilibrium at mid
indefinitely. Neither side gains the trooper advantage a siege needs, so a
bot-vs-bot match resolves by **sudden-death decay** rather than by a core dying.

A human breaks the symmetry immediately, which is what M3's gate actually
tests — so this does not block M3. It **does** block M8: the bench's
match-length distribution is meaningless until bots have a "push" macro state
(group up, commit to a tower when the wave is ahead, back off when it is not).

Diagnostic evidence: hard-vs-easy over 12 minutes produced 68 deaths and left
every structure above 96%.

## ⚠ Balance signal for M8

A hard-vs-hard bench produces **~68 deaths per 12 minutes**. The economy model
in `balance.ts` assumes roughly 24. Either the model or the bot aggression is
wrong; do not tune `balance.ts` against bench numbers until the push behaviour
above is fixed, because both symptoms may share a cause.

---

## Next task

`tools/replay-diff` + the `.ovr` input-log format. It is the cheapest remaining
M1 row, it unblocks half of M6 (§9.1), and it makes every bug from here on
reproducible from a seed rather than from a description.

After that, in order: the four hero kits and weapons (M3), then upgrades, then
`tools/peek-test` and the cross-engine determinism CI job to close M1.

## Last failures — all resolved this session

Found by running the game and reading the output, not by the tests passing:

1. **`stepCombat` never traced against structures.** They live in the collision
   box list, so every shot at a tower resolved as a wall hit for zero damage.
2. **§6.2 health regen was never implemented.** A bot below its retreat
   threshold never recovered, walked backwards into its own core, and stayed.
3. **Heroes spawned 6m behind their own core** — a solid 8m collider — with no
   pathfinder to route around it.
4. **Two of three spawn slots were inside a cover block.**
5. **Bots never shot troopers**, so symmetric waves annihilated forever.
6. **A hero with no input was skipped entirely, including gravity** — exactly
   §10.4's "never freeze the entity", which would have surfaced at M4 as lag.
7. **The STRIP floor filled its own pit back in** (same class as the grey box);
   rewritten as rectangle subtraction over a boundary grid.
