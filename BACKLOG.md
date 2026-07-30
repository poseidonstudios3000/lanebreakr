# BACKLOG

PRD §13: never add a feature not in the PRD — append here instead.
Seeded from PRD §16 so a second competing list never gets created.

## Out of MVP, ranked (PRD §16)

1. Ranked + MMR
2. Heroes 5–8
3. Two-lane map variant
4. 5v5 mode
5. Custom lobbies / tournament mode
6. WebRTC transport for sub-50ms
7. Native wrapper (Tauri) for Steam
8. Cosmetics + monetization
9. Replay sharing **site** — the feed, browse and discovery layer. *The basic
   share link is no longer here: it moved into M6 as §9.1's `GET /r/<id>`,
   because success criterion 4 was otherwise gated on a backlogged system.*
10. Mobile spectator app

## Moved out of MVP during the v1.1 review

11. Spectator auto-director mode — *was M6, which bundled eleven separable
    subsystems at a 2-session estimate*
12. 60s delayed spectator stream — *was M6; a second server-side stream path
    with its own memory cost*
13. Announcer rare variants at 5% roll — *was §9.3; half the VO line count for
    5% of the plays, against a milestone that already hard-blocks on ~80
    unsourced audio clips*

## Direction items (2026-07-31) — see `docs/DIRECTION.md` for rationale

Owner intent captured beyond PRD v1.1. Several deliberately reverse §1.4.
Ordered by when they can be built, not by how much they matter.

**Pull forward — build with pings, not after:**
- **D1. Emote + comms wheel.** Teammate comms always; enemy-facing opt-in and
  per-player mutable, default off. §1.4 already makes pings the fog-of-war
  replacement so a wheel must exist anyway; emotes ride the same input bits,
  the same wire budget and the same UI. Highest clip-per-byte feature available.

**Blocked on a server (M4+):**
- **D2. Accounts, guest-first.** Play instantly as a guest; progression accrues
  to a local identity that can be *claimed* later. Account-first would put a
  signup between a shared clip and a match, which is the exact friction the
  browser-first thesis exists to remove.
- **D3. Meta-currency, separate from souls.** Souls are a per-match resource
  tuned to a 12-minute arc; if they carry value out of the match, every number
  in `balance.ts` becomes a real-money number and stops being tunable.
- **D4. Marketplace** — buy/sell items between players.
- **D5. Cash-out.** *Legal scoping before architecture.* Engages money
  transmission / e-money rules and, if any item is chance-acquired and then
  sellable, gambling law in several jurisdictions. Also collides head-on with
  D-RISK-1 below.
- **D6. Skill rating, levels, leaderboards.** Reverses §1.4's ranked/MMR cut.
  Note M8 already found per-hero win rate near-unmeasurable at a 4-hero roster;
  a player-facing rating has the same shape of problem at low population.
- **D7. UGC — "players create their own experiences in our world."** Custom
  rooms, rule modifiers, possibly map variants. This is a platform, not a mode,
  and it is the highest-leverage retention item on the list because it turns
  players into content supply. Scope separately.

**Cross-cutting:**
- **D8. Art direction pass.** The bar is "good, and not low-effort AI slop."
  §11 specifies the right *system* (flat-shaded, desaturated, emissive accents)
  but not what separates deliberate stylisation from default materials:
  silhouette language, authored lighting, cheap non-uniform surface detail. Needs
  references, not constants.

**Open risks created by the above:**
- **D-RISK-1. Real value + invisible bot backfill is a farming exploit by
  construction.** §10.5/§14 make bot backfill the answer to empty lobbies. If
  anything earned in a match converts to money, a bot match is a money printer,
  and the feature keeping the game alive at low population is the one draining
  it. Must be resolved before D5, not during.
- **D-RISK-2. Enemy-facing comms is a harassment surface.** "Optional" has to
  mean default-off and per-player mutable, not a settings toggle nobody finds.

**Naming:** the GitHub repo is `lanebreakr` — one of §0's alt names. The code
still says OVRRUN throughout. Rename is a mechanical pass; awaiting the call.

## Deferred implementation, already specified

Not features — specified work whose milestone has not arrived.

- **Ability constants for all 12 abilities.** Derived and cross-verified, held
  in `docs/derived/abilities.ts` rather than `balance.ts` so M2 does not carry
  ~470 lines it cannot exercise. Fold into `balance.ts` at M3.
  Carries two resolved conflicts: Overcharge is +25% (DECISIONS 10) and the
  damage pipeline must state the shotgun headshot exception (DECISIONS 14).
- **`tools/netsim`** — M4 is unverifiable without it (§12/M4).
- **`tools/perf-harness`** — Playwright; a headless Node process can observe
  only one of §10.6's six budgets.
- **`packages/telemetry`** — Q1's 15% toggle threshold and Q5's requeue test
  are opinions without it. M3 deliverable.
- **Audio source decision** — ~60–80 clips hard-block M7's sole criterion.
  M0 ships 22 procedurally synthesised sounds with no assets, which is the
  cheapest resolution of the §14 risk row; the open question is whether that
  approach scales to hero-distinct ability and VO signatures.

## Ideas raised and not taken

- **Per-player skill rating for room assignment.** Rejected: it is MMR under
  another name and §1.4 cuts it deliberately. At MVP population there are never
  enough concurrent players to form two buckets, so the field would be inert.
- **Suppressing auto-clips when bots are present.** Rejected: would disable the
  clip system in essentially every MVP match, sabotaging success criterion 4
  rather than protecting it.
- **Backfilling bots only above 4 humans in queue.** Rejected: contradicts
  §14's mitigation for "empty lobbies kill it" and would produce zero matches
  at MVP population.
