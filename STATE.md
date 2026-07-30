# STATE

Machine-maintained. The RALPH loop (PRD §13) reads this first and writes it last.
One row per PRD acceptance criterion. **Never advance a milestone until every
row in it reads PASS.**

```
CURRENT MILESTONE : M1 — Sim Core
LAST UPDATED      : 2026-07-31
BUILD             : 9867f20 + balance reconciliation
```

## Gate iteration counters

§13's kill criteria count iterations, and nothing persisted a counter across a
context reset — so a fresh session had no way to know whether it was on
iteration 2 or 7, and both escape hatches were unenforceable. These are that
counter. **Increment on every iteration that targets the gate.**

| Gate | Iterations | Kill at | Status |
|---|---|---|---|
| M0 fun gate | 2 | 3 | **PASSED** — human verdict 2026-07-31: "feel like fun already" |
| M4 p95 correction trend | 0 | no improvement across 3 consecutive sessions | not started |
| M8 match-length variance | 0 | ±3 min | not started |

---

## M0 — Feel Prototype ✅ COMPLETE

| Criterion | Status | Verified by |
|---|---|---|
| 60fps stable on the named scene at the Iris Xe tier, p99 over 600 frames | **PARTIAL** | HUD reports fps/p99 live; `tools/perf-harness` not built, so the tier is not pinned |
| Camera transition ≤0.15s with no clipping | PASS | `m0.test.ts` "toggles, and the transition is ≤0.15s" |
| Mantle a 1.2m and a 2.4m ledge | PASS | `m0.test.ts` "mantles the 1.2m ledge" |
| Zipline traverses the full length | PASS | `m0.test.ts` "zipline attaches and traverses" |
| Slide preserves ≥80% of entry speed for 0.6s | PASS | `m0.test.ts` — caught `SLIDE_FRICTION_MPS2` at 6.0, now 3.0 |
| `tools/peek-test` green against a stub bot | **FAIL** | not built |
| **Gate: is moving and shooting fun with zero content?** | **PASS** | human, 2026-07-31 |

## M1 — Sim Core ◀ CURRENT

| Criterion | Status | Verified by |
|---|---|---|
| `tick()` has zero imports from THREE/DOM, CI-enforced | PASS | `eslint.config.js` purity guard, `pnpm lint` |
| Identical 10,000-tick state hash in Node 22 | PASS | `determinism.test.ts` |
| Identical 10,000-tick state hash in **Chrome and Firefox** via Playwright | **FAIL** | CI job not built |
| `mathd.ts` lands and the `Math.*` ban is green | PASS | `mathd.ts`, purity guard |
| Physics gate: 10k capsule + 10k projectile sweeps, zero tunneling, zero stuck | **FAIL** | swept collision exists; the gate test does not |
| `.ovr` written and read as `{seed, build_hash, balance_hash, input_log}` | **FAIL** | not built |
| Sim runs headless in Node | PASS | vitest runs it |

**Next task:** `tools/replay-diff` + the `.ovr` input-log format. It is the
cheapest remaining M1 row and it unblocks half of M6 (see §9.1).

## M2 — Lane — NOT STARTED

Blocked on nothing. `balance.ts` now carries every number M2 needs: trooper
stats, tower/core HP, aggro rules, orb ownership and claim resolution.

| Criterion | Status |
|---|---|
| Wave spawns every 25s, walks to enemy tower, engages | not started |
| Orbs drop, claim and deny function, expire, ownership resolves | not started |
| Towers target nearest trooper, switch on hero-damages-allied-**hero** | not started |
| Every roof reachable from ground within 8s from three named spawns | not started |
| Match ends when a core dies | not started |

## M3–M8 — NOT STARTED

---

## Last failure

None outstanding. Most recent resolved:

- **Balance reconciliation (2026-07-31).** Two cross-verifiers found 11 blocking
  contradictions across the five derived domains. All resolved; see
  `DECISIONS.md` entries 7–17. Guarded by `balance.test.ts` (34 invariants).
- The invariant tests immediately caught two of my own errors: a structure pool
  that double-counted the reload-uptime correction (predicted 9.6 min, band is
  10–14), and a buffed-TTK floor asserted at 1.0s that the numbers could not
  meet.
