# DECISIONS

Append-only. PRD §13: never add a dependency without recording the
justification here, and record every deviation from the PRD.

Format: `## N. <decision>` / **Date** / **Alternatives rejected** / **Why**.

---

## 1. Sim rate 60Hz, not the PRD's 30Hz
**2026-07-30**
**Rejected:** 30Hz as written; 128-tick.
At 30Hz the two hitscan weapons land on half-ticks — 720 RPM is 2.5 ticks per
shot, 240 RPM is 7.5 — so both fire on a jittering 2/3-tick cadence and a
`+12% fire rate` upgrade rounds to either −17% or +25%. The 20Hz snapshot rate
is also 1.5 ticks, so entity interpolation spacing alternates and the flat
100ms buffer runs dry. At 60Hz all four weapons, the snapshot rate and the
visibility gate divide evenly (SMG 5, Rifle 15, Shotgun 40, Launcher 36,
snapshot 3, gate 4), aim latency halves, and projectile travel per tick drops
from 1.5m to 0.75m. At 3v3 the CPU cost is irrelevant against §10.6.

## 2. `dt` removed from the `tick()` signature
**2026-07-30**
A signature that accepts `dt` is one a caller can pass a different `dt` to
during catch-up. It is a module constant now.

## 3. Deterministic math policy decided at M1, not M4
**2026-07-30**
**Rejected:** doubles with no restrictions; full Q16.16 fixed point.
ECMAScript leaves `Math.sin/cos/tan/atan2/pow/exp/log` implementation-
approximated; V8, SpiderMonkey and JSC disagree, and V8 versions disagree with
each other. `+ − × ÷` are spec-mandated round-to-nearest-even and FMA
contraction is spec-illegal, so basic arithmetic *is* portable; `Math.sqrt`
lowers to the hardware instruction everywhere that ships. So: `mathd.ts`
provides portable trig from fdlibm kernels, an ESLint rule bans the rest inside
`packages/sim`, and state is stored as integers with floats confined to
intra-tick collision queries. Full fixed point was rejected as needlessly
painful for collision math given the rounding boundary already prevents
accumulation.

## 4. Input widened from 4 to 8 bytes/tick
**2026-07-30**
Counting the mandatory fields — an 8-bit sequence number (the server acks input
seq), two movement axes, and the ~13 buttons this design needs — leaves ≤7 bits
for yaw *and* pitch, about 0.7°/step, roughly 3.4× a head's angular size at the
Rifle's falloff limit. That deletes the ×1.5 headshot multiplier and HALO's
identity. 8 bytes at 60Hz is ~1.6 KB/s including packet overhead, against a
<3 KB/s budget.

## 5. RNG is stateless and derived, not a seeded stream
**2026-07-30**
**Rejected:** the PRD's "seeded xorshift128".
A predicting client cannot know how many draws remote shooters consumed, so the
shotgun's 8 pellets resolve at different stream positions client- and
server-side — and because spread moves nobody it never trips the position-based
reconciliation threshold. It would simply feel broken, for exactly one hero.
`rngFor(tick, entityId, salt)` is reproducible by any participant in any order.

## 6. TPS hipfire penalty removed; the axis is mobility vs precision
**2026-07-30**
**Rejected:** keeping ×1.4.
§5.1 gave TPS a ×1.4 spread penalty *and* no ADS, while §5.3's anti-peek fix
strips its awareness edge by construction and hold-RMB auto-switches for you.
The dominant macro was 100% TPS traversal + RMB for every engagement: zero `V`
presses, and the signature mechanic reduced to a traversal camera. Reverting is
one constant, `CAMERA.TPS_HIPFIRE_SPREAD_MULT`.

---
*Entries 7–17: resolutions of the eleven blocking contradictions found by two
independent cross-verifiers over the five parallel-derived balance domains.
Each domain was internally competent and marked its own answers SETTLED; the
contradictions only existed in the union.*

## 7. Orb claim resolves against an HP pool of 120, with economy's damage table
**2026-07-31**
**Rejected:** ORB_HP 100 + weapons' table (the other verifier's recommendation);
one-hit-claims (the PRD's implied rule).
The two verifiers split on this one. One-hit-claims is the load-bearing error:
a 720 RPM hitscan gets 12 claim attempts/sec against the Launcher's 1/sec, so
the plurality income source becomes a function of hero pick and §8's 48–52%
win-rate target is unreachable. Given a pool, 120 + economy's table is exact
against weapons' *real* tick intervals and yields a wider spread of committed
time (SMG 0.333s, Rifle 0.500s, Shotgun/Launcher/melee one hit), which is what
makes the contest a decision rather than a reflex.

## 8. Orb falloff and item bonuses split into two flags
**2026-07-31**
Economy said orb damage ignores the pipeline entirely; weapons said falloff
applies. Both SETTLED, directly opposite — but protecting different things.
Economy's concern is an itemization→faster-farm spiral; weapons' is BULWARK's
range gate. `ORB_DAMAGE_IGNORES_ITEM_BONUSES` + `ORB_DAMAGE_APPLIES_FALLOFF`.
Consequence: BULWARK's orb wall is at 11.75m, not the 8m its rationale claimed.

## 9. Splash cannot claim orbs
**2026-07-31**
Both verifiers agreed. 3m splash from 40m with zero aim deletes §7.1's
mini-duel; the orb budget does not depend on it and Pillar P2 does.

## 10. The TTK band is a base-kit reference, with a separate buffed floor
**2026-07-31**
**Rejected:** Overcharge at +30% and at +20%; retuning the SMG.
§6.1 never said what item and buff state the 1.2–2.0s band is measured at,
which is what produced the Overcharge conflict: abilities cut VOLT's E from
+40% to +30% to protect the floor and constrained SMG DPS as the price, weapons
then shipped a faster SMG, and *every* variant breaks the floor once items are
added. Resolution: the band is asserted against base kit, no items, no buffs
(§6.1's own intent). A separate `BUFFED_ITEMIZED_FLOOR_S = 0.85` guards the
fully-stacked case. Overcharge is +25% — the only value in range that keeps the
SMG interval an integer tick (5 → 4). Worst legal stack is ~0.91s, which is
3× CoD's 0.3s and still leaves room to dash out.

## 11. Structure damage has exactly one source: the per-weapon multipliers
**2026-07-31**
World shipped a global ×0.55 and weapons shipped four per-weapon values. If
they composed, mean hero siege DPS fell to 97.9 and the median match ran 19:07
— past sudden death's own ceiling, so every game would resolve by decay timer
and M8's 10–14 min criterion fails outright. Per-weapon wins because
RIFT-as-sieger is real archetype identity. Falloff no longer applies to
structures (it would double-punish the shotgun).

## 12. Siege reload uptime 0.669, not 0.78; structure pool 49,600
**2026-07-31**
Recomputed from the shipped magazines and reloads, 0.78 overstated hero
throughput by 16.6% and every row of the siege table inherited the error. My
first correction then over-rescaled the HP pool and predicted a 9.6 min median
— caught by `balance.test.ts`, not by inspection.

## 13. Millidamage wins over floor-once-at-end
**2026-07-31**
The pipeline was specified twice, incompatibly: 19.494 vs 19 damage on one SMG
shot, 799 vs 779 over a kill, a different shot count. Millidamage is the
byte-identical determinism contract and is what already shipped.

## 14. Shotgun headshots: ×1.25, capped to one pellet
**2026-07-31**
At the blanket ×1.5 a full head blast is 384, two-shotting both 550 and 700 HP
for a 0.667s TTK — precisely the CoD-class TTK §6.1 rejects. Any per-shot head
bonus above +36.7% two-shots the 700 reference. The abilities pipeline must
carry this as an explicit exception.

## 15. Head sphere stays at r=0.14 @ 1.62m
**2026-07-31**
**Rejected:** world's r=0.19 @ 1.66 (the verifier's recommendation).
The verifier was right that weapons solved every spread value against the
smaller head, but adopting the larger one inverts HALO's identity: at r=0.19
the Rifle's 0.12° ADS cone becomes a *guaranteed* headshot at 70m rather than
"the skill check". 0.14m is a 28cm head, already generous. Keeping it also
means no spread value needs re-solving and preserves the M0 feel that passed
its gate.

## 16. Sudden death is owned by WORLD
**2026-07-31**
Two files carried the same concept at 45s and 30s+6/death. World owns match
flow; economy's constant is deleted.

## 17. REFERENCE_DPS replaced by a per-archetype vector; the shotgun is not retuned
**2026-07-31**
Three domains derived everything from a single 437.5 DPS figure that none of the
four shipped weapons matches. A verifier called the shotgun "+20% out of band"
and proposed retuning it — but that measures *burst* DPS, the wrong metric for
a 1.5 shots/sec weapon: its TTK is 1.333s (in band) and its sustained DPS
including reload is 268, the lowest of the four. Publishing both vectors is the
fix.

---

## 18. Movement tech moved into M0; vault/mantle made geometric
**2026-07-31**
**Rejected:** the PRD's "4 mantle points".
No milestone criterion mentioned mantle, zipline or slide, so §13's "pick the
task that advances the current milestone's criteria" would never have selected
them — despite P3 calling movement tech the primary clip source. Scripted
mantle markers are also a level-design liability and the MID PIT already needed
a fifth the document never listed. Three geometric tiers: vault 0.35–1.2m
(weapon live), mantle 1.2–3.2m (weapon locked), above that needs a tool.

## 19. Dependencies added
**2026-07-30 / 31**
`three` (renderer, PRD §10.1 names it), `vite` (client shell, §10.1 names it),
`vitest` (§10.1 names it), `typescript`, `eslint` + `typescript-eslint` (the
purity guard is an acceptance criterion, so the linter is load-bearing rather
than hygiene). Nothing else. No physics engine, no state library, no UI
framework — §10.1 is explicit that the HUD is a plain DOM overlay.
