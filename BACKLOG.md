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
