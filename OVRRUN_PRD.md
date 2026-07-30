# OVRRUN — Product Requirements Document

**v1.0 · Build spec for agentic development (Claude Code / Opus 5, RALPH loop)**
*Working title. Alt names: LANEBREAKR, SIEGR, PUSHR.*

---

## 0. TL;DR for the build agent

Build a **3v3, single-lane, 12-minute MOBA played as a shooter**, with a free FPS/TPS camera toggle. Browser-first, TypeScript, Three.js render layer, **deterministic headless simulation core** that runs identically in a Web Worker (offline vs bots), in Node (CI + bot benchmarks), and on an authoritative server (online).

The #1 architectural rule: **`packages/sim` never imports Three.js, never touches `window`, never reads wall-clock time.** Everything else is replaceable. If you follow this one rule the project can go from single-player prototype to netcoded multiplayer without a rewrite. If you break it, the project dies at milestone M4.

The #1 design rule: **every system must be evaluated by "does this generate a clip?"** Mechanical depth that produces no visible moment of triumph or humiliation is cut.

---

## 1. Vision

### 1.1 One-line pitch
A MOBA where you *aim*. Lane, farm, and siege like Dota — but you're holding a gun, you can flip between first and third person mid-fight, and every last hit is a contested shot.

### 1.2 Why this exists
The MOBA genre is locked in top-down camera. The hero shooter genre (Overwatch, Valorant) borrowed hero kits but threw away the macro layer — no creeps, no farming, no item economy, no base to destroy. Deadlock proved shooter+MOBA works but is a 6v6, 40-minute, high-complexity commitment.

**OVRRUN is the 12-minute, 3v3, instantly-legible version of that.** Low skill floor, obscene skill ceiling, built around clip generation.

### 1.3 Design pillars

| # | Pillar | What it means in practice |
|---|--------|---------------------------|
| **P1** | **Every death is a story** | Killcam, announcer, bounty glow. You always know exactly who killed you and why you lost that fight. No "I dunno what happened." |
| **P2** | **Contested economy** | Souls are never passive. Every unit of income is a physical object someone can shoot away from you. **This pillar is enforced numerically:** `headless-bench` asserts passive trickle ≤25% of median per-player income, so it cannot silently erode during balance tuning. |
| **P3** | **Movement is the flex** | Dash, slide, zipline, mantle. Positioning outplays are as valuable as aim. Movement tech is the primary clip source. |
| **P4** | **Legible in 5 seconds** | A stream viewer with zero context understands who's winning by looking at the screen for five seconds. |
| **P5** | **Comebacks are always live** | No game is decided before the last 90 seconds. Steals, bounties, and catch-up mechanics guarantee it. |

### 1.4 Non-goals (do not build these)
- ❌ Ranked ladder / MMR / seasons (M9+, out of MVP scope)
- ❌ Accounts, progression, cosmetics, monetization
- ❌ Mobile or console support
- ❌ More than 4 heroes at MVP
- ❌ Jungle camps, wards, fog of war (replaced by line-of-sight + minimap pings)
- ❌ Voice chat
- ❌ Photorealistic art. Stylized low-poly is the target and it is a *feature*, not a compromise.
- ❌ Anti-cheat beyond server authority

---

## 2. Reference targets

| Reference | What we take | What we reject |
|---|---|---|
| **Deadlock** | Soul orbs as contested last-hitting, ziplines, lane-shooter fusion | 6v6, 40min matches, 20+ heroes, item complexity |
| **ARC Raiders** | Weight of movement, tension of an open engagement, audio design | Extraction loop, PvE |
| **CoD (Warzone/MW)** | Gunfeel, slide-cancel snappiness, killcam pacing | TTK that's too short for a MOBA |
| **Apex Legends** | Movement tech as the identity, ping system | BR loop, 60 players |
| **Dota 2 / LoL** | Lane push math, gold curve, tower aggro, Roshan-style steal | Top-down camera, 45min matches, 100+ heroes |
| **Rocket League** | 5-second legibility, endless clip generation from simple rules | — |

**Feel target:** "CoD gunplay wearing a Dota economy, in a match shorter than a Rocket League overtime."

---

## 3. Core loop

```
SPAWN → PUSH LANE → CONTEST SOULS → BUY UPGRADE →
  ↳ fight for MID PIT objective (every 4 min)
  ↳ break TOWER → break TOWER 2 → break CORE
    ↳ WIN
```

**Nested loops:**
- **5s loop** — aim, shoot, dash, take cover
- **25s loop** — creep wave arrives, contest souls, win/lose the wave
- **2min loop** — accumulate souls → buy an upgrade → feel measurably stronger
- **4min loop** — MID PIT objective spawns → team fight → snowball or reset
- **12min loop** — match

---

## 4. Match structure

| Parameter | Value | Note |
|---|---|---|
| Team size | 3v3 | Smallest size where lane/flank/rotate decisions exist |
| Target match length | 10–14 min | Hard sudden-death escalation at 15:00 |
| Respawn timer | `8s + 2s × minutes_elapsed`, cap 25s | Deaths matter more late |
| Creep wave interval | 25s | 4 troopers per wave, first at 0:30 |
| Structures per side | 2 towers + 1 core | Tower 1 at 30% lane, Tower 2 at 15%, Core at base |
| Objective | MID PIT boss | Spawns 4:00, respawns 4 min after each kill |

### 4.1 Map — "THE STRIP"

Single lane, mirrored, roughly **220m end to end**, ~35m wide.

```
      [ROOFS / ZIPLINE — high risk, high vision, no cover]
 ══════════════════════════════════════════════════════════
 BASE  T2   T1        ▓▓ MID ▓▓         T1   T2  BASE
 (A)                   ▓ PIT ▓                      (B)
 ══════════════════════════════════════════════════════════
      [FLANK TUNNELS — dark, no LOS to lane, 2 exits/side]
```

**Three vertical layers:**
1. **Lane (ground)** — where creeps walk. Cover blocks, sightline breakers every ~15m. This is where farming happens.
2. **Roofs** — reachable via 4 mantle points + 2 ziplines running the length of the map. Full sightlines, zero cover. High-ground advantage but you're visible to everyone. Classic clip location.
3. **Flank tunnels** — two per side, sub-lane routes that pop out behind enemy T1. Enables ganks and backdoor plays. Footstep audio is loud in tunnels.

**MID PIT** — a sunken arena at map center. Once you drop in, exits require a mantle or dash (~1.2s of vulnerability). Fighting in the pit is committal. The objective boss lives here.

**Design constraint:** the whole map must be understandable from a single top-down minimap image. If a new player needs a tutorial to know where they are, redesign it.

---

## 5. The FPS/TPS system (signature mechanic)

This is the thing that makes the game *ours*. It must be flawless.

### 5.1 The two modes

| | **TPS (default)** | **FPS** |
|---|---|---|
| Camera | Over-shoulder, 3.5m back, 0.6m right | Eye position |
| FOV | 95° (wider peripheral) | 80°, 65° when ADS |
| Hipfire spread | **×1.0 baseline** | ×1.0 baseline |
| ADS available | No | Yes |
| Movement speed | ×1.0 | ×1.0 (**×0.6 while ADS**) |
| Ability aiming | Full 3D arc preview, ground-target reticle | Crosshair only, no arc preview |
| Best for | Fighting **while moving** — dash/grapple/slide duels, ability combos, melee | Standing precision, long lane pokes, orb sniping |

**The axis is mobility versus precision, not "good camera versus bad camera."** The original spec gave TPS a ×1.4 hipfire penalty *and* no ADS, while §5.3's anti-peek fix deliberately strips TPS of its one informational advantage — leaving it with nothing but downsides in a fight. Combined with hold-RMB auto-switching, the dominant macro was 100% TPS traversal plus RMB for every engagement: zero `V` presses, and the signature mechanic reduced to a traversal camera with a decorative keybind. Q1's "<15% of players toggle" instrument would then have read near zero for a reason that has nothing to do with player preference.

With the penalty removed, the trade is real in both directions: TPS keeps full move speed, 95° peripheral vision and ability arcs, so it is the mode you fight in while dashing, grappling and sliding — which is Pillar P3, and the clip mode. FPS buys accuracy with ×0.6 speed and 80/65° tunnel vision. `BAL.TPS_HIPFIRE_SPREAD_MULT` is a single constant; if M0 shows TPS still dominates, raise it and re-run `peek-test`.

### 5.2 Switching rules

- **`V`** — hard toggle. 0.15s camera lerp. No cooldown, no penalty, spammable.
- **`Right Mouse` (hold)** — auto-enters FPS + ADS. Releasing returns to your prior mode.
- Switching is **never blocked** — not while dashing, not mid-air, not while stunned (camera still moves during stun for spectacle).

The hold-to-ADS path means players who never learn `V` still get the full FPS experience automatically. The toggle is for advanced players who want TPS *awareness* while strafing and FPS *precision* on the shot.

### 5.3 Solving third-person peek abuse — CRITICAL

TPS lets you see around corners your character can't. Unsolved, this makes TPS strictly dominant and kills FPS as a choice. Three layered fixes, all required:

1. **Camera occlusion pull-in.** Standard spring-arm: camera collides with geometry and pulls toward the head. Already limits extreme peeking.
2. **Enemy visibility gating (the important one).** An enemy is only *rendered* if they are visible from the **player's head position**, not the camera position. Ray-test head→enemy **every 4 ticks (15Hz)**, tick-locked — not per frame, and not free-running, or it is not deterministic and bots cannot share it. Three rays per target (head/chest/feet); a single ray is unusable against a map with sightline breakers every ~15m. Hysteresis: two consecutive occluded samples before hiding, 0.2s minimum visible dwell, **fail closed** on a stale sample. If occluded from the head but visible from the camera: render a **faint red silhouette outline only** (no model, no hitbox highlight, no nameplate) for 0.4s, then hide.
3. **Hitreg is head-authoritative.** Bullets originate from the muzzle in world space, never from the camera. If your reticle is on a wall from the character's perspective, you shoot the wall. Reticle turns dim red when the muzzle→target ray is blocked. **The gate never rejects a shot server-side** — see §10.4 rule 4.

**Where this lives, and why it is not a rendering detail.** `canSee()` is a pure query in `packages/sim/src/systems/visibility.ts`, consumed by three callers that must get the identical answer: the renderer, the bot AI, and `tools/peek-test` running headless. Put it in the renderer and bots become omniscient, which silently invalidates every number `headless-bench` produces.

**The information-leak tradeoff, stated honestly.** Drawing the 0.4s silhouette requires the client to hold the exact transform of an enemy it is not allowed to fully see, and §1.4 rules out anti-cheat beyond server authority. Area-of-interest culling does not help here — a single 220×35m lane with an open roof layer puts nearly every hero inside nearly every AOI. So move the gate into the **snapshot encoder**: for heroes failing the head-LOS test, send a 0.5m-quantized coarse position plus a silhouette flag instead of the precise record. That is exactly the fidelity the outline needs, it costs *fewer* bits than the full record, and it keeps the client gate as a rendering nicety rather than the mechanism. Residual risk after that is accepted.

**Acceptance test.** Two bots on opposite sides of a corner. Requirement: `|hit_rate_TPS − hit_rate_FPS| ≤ 5 percentage points` over **≥2,000 seeded duels per arm**, with the seed sweep pinned in the test file and `TPS_HIPFIRE_SPREAD_MULT` forced to 1.0 on both arms.

Three things were wrong with the original statement of this test and all three mattered: it ran with the ×1.4 spread penalty active, so TPS scored lower by construction and the test passed without measuring peeking at all; it was one-sided (`>5% higher`), so TPS landing 10 points *below* FPS — the dead-mode failure — also passed; and it specified no sample size, when resolving 5 points between two ~50% proportions needs roughly 1,560 duels per arm for 80% power. Lives in `tools/peek-test/`. **Needs a stub bot at M0** — "stand at a mark, strafe out at a fixed rate, fire on first sight" is ~50 lines and needs no behaviour tree — because the system it guards ships at M0 and the real bots do not arrive until M3.

---

## 6. Combat model

### 6.1 Time-to-kill
**TTK target: 1.2s–2.0s** against an equal-level opponent at 50% of the match.

Too fast (CoD's 0.3s) and there's no fight, no counterplay, no clip. Too slow (Overwatch tank) and it's mushy. 1.5s is enough time to dash out, pop an ability, get a heal, and turn the fight around — which is exactly where clips come from.

### 6.2 Health & damage
- Base HP: 550 → up to ~1600 fully itemized
- Regen: 2%/s after 5s out of combat
- **No healers.** Sustain comes from items and soul pickups. Avoids the support-role misery problem at 3v3.
- Headshot multiplier: **×1.5** for hitscan, **×1.0** for projectiles/abilities

### 6.3 Weapons
Each hero has **one weapon**, no swapping. Weapon identity = hero identity.

| Archetype | Fire | Reload | Range falloff |
|---|---|---|---|
| SMG | Hitscan, 720 RPM | 1.4s | 100% ≤18m → 45% at 40m |
| Rifle | Hitscan, 240 RPM | 1.8s | 100% ≤45m → 70% at 70m |
| Shotgun | 8 pellets hitscan, 90 RPM | 2.4s | 100% ≤8m → 20% at 20m |
| Launcher | Projectile 45m/s, 60 RPM | 2.6s | Flat, splash 3m |

Ammo is finite per magazine; reserve ammo is infinite. Reloading in a fight is a real decision.

### 6.4 Abilities
Every hero: **2 actives + 1 ultimate + 1 universal dash.**

- **Dash** (universal, `Shift`) — 2 charges, 8s recharge each, 6m directional burst, 0.25s i-frames at start. This is the get-out-of-jail and the primary movement-tech enabler.
- **Actives** — `Q` / `E`, 8–16s cooldowns
- **Ultimate** — `R`, 90–110s cooldown, charges reduced by 8s per takedown participation

Keeping the kit this small is deliberate: a new player is competent in one match, and a streamer's audience can follow every button press.

---

## 7. Economy — SOULS

The single most important system in the game. It converts MOBA last-hitting into a shooter mechanic and generates constant micro-drama.

### 7.1 How it works
1. A trooper dies → drops a floating **SOUL ORB** at its position
2. The orb hovers for **2.5s** then vanishes
3. **Shoot the orb** (or melee it) to claim: **+30 souls to you**
4. **Enemy shoots it first:** they **deny** it — you get nothing, they get **+15**
5. Uncontested orbs are trivial to grab. Contested orbs are a mini-duel every 25 seconds.

*(Mechanic directly inspired by Deadlock's soul system — it is the correct solution and we should not pretend otherwise.)*

### 7.2 Why this is the core of the design
- Turns passive farming into **continuous aim practice with stakes**
- Creates a **denial** interaction — the most reliably enraging/hype moment in MOBAs
- Every 25 seconds there is a **guaranteed micro-conflict** with no downtime
- It is **visually legible**: viewers see glowing orbs and immediately understand "get orb = good"

### 7.3 Full income table

| Source | Souls | Notes |
|---|---|---|
| Soul orb claimed | 30 | |
| Soul orb denied | 15 | To the denier |
| Passive trickle | 12/s per team | Split, guarantees a floor |
| Hero takedown | 100 + bounty | Split among participants within 5s |
| Assist | 60 | |
| Tower destroyed | 200 team-wide | |
| MID PIT boss | 500 team-wide + buff | |
| Death penalty | −10% of unspent souls, cap 200 | Discourages hoarding |

### 7.4 Bounty (streak escalation)
Every 2 consecutive kills without dying adds **+75** to your head, capped at +450. A bountied player has a **visible colored aura** and appears permanently on the enemy minimap above +225.

This is Pillar P5 in mechanical form: the person snowballing is also the person worth the most, and everyone can see them.

### 7.5 Upgrades (items)
**12 total at MVP. 3 equipped slots. No inventory management.**

Bought instantly from anywhere via `B` (0.5s cast, cancels on damage) — no walking back to base to shop. Removes dead time.

| Tier | Cost | Examples |
|---|---|---|
| **T1** | 500 | +150 HP · +12% fire rate · +1 dash charge · +18% reload speed |
| **T2** | 1200 | Bullet lifesteal 12% · +25% ability damage · Slow immunity 3s after dash · +30% magazine |
| **T3** | 2600 | Ultimate refunds 40% on takedown · 1.5s revive-in-place once per life · +35% damage vs structures |

Upgrades replace lower tiers in the same slot; sell for 60%. Every upgrade must produce a **visible change on the character model** so viewers can read power level visually (Pillar P4).

---

## 8. Heroes (MVP: 4)

Design constraint: each must be describable in one sentence and identifiable by silhouette alone.

### VOLT — Duelist (SMG)
*"Zips in, deletes someone, zips out."*
- **Q — Hook Line:** Fires a grapple at a surface, yanks you to it (max 25m). Extends the movement ceiling higher than anything else in the kit.
- **E — Overcharge:** 4s, +40% fire rate, shots chain 25% damage to a second target within 6m.
- **R — Blackout:** 3s AoE that disables enemy dashes in a 12m radius.
- **Clip potential:** highest. Grapple + dash chains are the core clip-farming tool.

### BULWARK — Frontliner (Shotgun)
*"Walks at you and there is nothing you can do about it."*
- **Q — Slab:** Deployable 4m×3m cover wall, 8s duration, 800 HP, blocks bullets both ways.
- **E — Concuss:** Ground slam, 4m radius, 1s stun + 40% slow.
- **R — Siege Form:** 6s, +80% max HP, −25% move speed, immune to displacement.
- **Clip potential:** blocking an ultimate with a Slab at the exact frame.

### HALO — Marksman (Rifle)
*"Punishes anyone standing still anywhere on the map."*
- **Q — Tag:** Marks an enemy for 6s; you and allies see them through walls and deal +12% to them.
- **E — Vault:** Long backward hop with 0.4s of aim-slow — the disengage/repositioning tool.
- **R — Line Shot:** 1.2s charge, then a hitscan beam through all terrain across the full map length. 320 damage.
- **Clip potential:** cross-map Line Shot snipes. This is the "how did that even hit" highlight generator.

### RIFT — Zoner (Launcher)
*"Makes 30 square meters of the map illegal."*
- **Q — Mine Field:** 3 proximity mines, 60 dmg + 50% slow each.
- **E — Displace:** Projectile that pulls all enemies within 5m toward its impact point.
- **R — Collapse:** 15m dome, 5s duration; enemies inside take 8%-max-HP/s and cannot dash out.
- **Clip potential:** Displace-pulling three people into the MID PIT.

**Balance target:** each hero's win rate in bot-vs-bot benchmark within **48–52%**. Tune only via `packages/sim/src/balance.ts`.

---

## 9. Viral / streamer systems

**This section is not polish. It is the product.** These ship in M6, not "later."

### 9.1 CLIP BUFFER (highest priority)
**`.ovr` is an input log, not a snapshot buffer, and it is defined at M1 — not M6.**

```
.ovr = { seed, build_hash, balance_hash, input_log }
```

Because §10.3 guarantees `tick()` is pure, the entire match replays from its inputs. At 8 bytes/tick × 60Hz × 6 players that is ~2.9 KB/s — **~2 MB for a whole 12-minute match**, seekable by re-simulating, and produced *for free* by `tools/replay-diff`, which M1 already requires. The original spec — snapshot deltas at ~200KB per 20 seconds — is the design you would need only if the sim were non-deterministic, and it buys 3% of the match for 3× the bytes per second. It also forces a server ring buffer the server does not need, since the server is authoritative over the input stream and already has it. Accept the one real cost honestly: input-log replays break across sim or balance changes, so the build and balance hashes are pinned in the file and stale links expire.

- Auto-triggers on: triple takedown, objective steal, sub-10%-HP survival that leads to a kill, tower backdoor, cross-map ult kill. A trigger marks in/out points on an artifact that already exists.
- `F9` marks the last 20 seconds manually.
- Replays are viewable in a **free director camera** with slow-mo, orbit, and per-player POV switching.

**The delivery chain — this is the part that was missing, and it is the part success criterion 4 depends on.** As originally specified the clip was born server-side and died there: no route, no transport, no host, no URL, no retention policy, and — since §1.4 bans accounts — no owner. The document then filed the missing piece as backlog item 9. **The clip artifact is a URL, not a file:**

1. Server writes the replay under an 8-character id.
2. `GET /r/<id>` opens the existing client in replay mode. No account, no install, 7-day TTL.
3. The short URL is burned into the corner of the render. A video is a dead end; a link is a funnel.
4. MP4 export via `MediaRecorder` stays, as the *secondary* path — drive it with `captureStream(0)` + `requestFrame()`, or it records in real time.

**Firefox has no MP4 muxer in `MediaRecorder`** (`isTypeSupported('video/mp4')` is false; it emits WebM), so M6's criterion as originally written was unachievable through the specified API. Ship "MP4 in Chrome, WebM in Firefox," or add a ~30KB WASM muxer. Never `ffmpeg.wasm` — it does not fit the <9 MB budget.

### 9.2 KILLCAM
1.2s, killer's POV, from 0.8s before the fatal shot. Non-skippable for the first 0.6s (this is deliberate — the sting is the point, and it teaches players what killed them). Displays the killer's equipped upgrades and remaining HP.

### 9.3 ANNOUNCER
Escalating tiers with rare variants (5% roll) so clips don't feel repetitive:

| Trigger | Line tier |
|---|---|
| 2 kills / 5s | "DOUBLE" |
| 3 kills / 8s | "TRIPLE" |
| 3 kills solo, no deaths, 12s | "OVRRUN" (title drop — spelled like the game) |
| Soul denial streak ×5 | "STARVED" |
| Objective stolen at <5% HP | "**ROBBED**" — loudest sound in the game |
| Killing a max bounty | "BOUNTY CLAIMED" |
| Team wipe | "WIPED" |

**Priority rule.** One announcer channel, highest tier wins, 2.5s lockout. Without it a solo triple currently fires TRIPLE, OVRRUN and WIPED simultaneously.

### 9.4 THE STEAL
The MID PIT boss can be last-hit by *anyone*. Whoever deals the killing blow takes the full 500 souls + buff for their team. No exceptions, no protection mechanic, no smite-equivalent that removes the tension.

**This is the single biggest clip generator in the game and it must never be balanced away.** If it feels unfair, that is the correct feeling.

### 9.5 SURGE (comeback mechanic)
If a team is >2500 souls behind at any point after 6:00, their core emits **SURGE**: +15% soul income and −25% respawn timers until the gap closes below 1200. Visible to both teams as a pulsing red aura on the losing core — the winning team *knows* the comeback is armed, which creates tension rather than resentment.

### 9.6 PLAY OF THE MATCH
Post-match, score every 6-second window across all players by a weighted heuristic (damage dealt × takedowns × improbability-of-survival × objective value). Play the top window as a replay. Winner gets a nameplate flourish. ~30 lines of code, enormous perceived value.

### 9.7 THE LINK (invite / party)

**The unit that adopts a 3v3 game is a group, not an individual.** The browser-first thesis in Q4 rests entirely on a pasted link, and as originally specified the only thing a link could do was drop you into a solo queue — the closest thing to an invite flow, "custom lobbies," was explicitly backlogged. Two friends who click the same clip could not end up in the same match, which converts every shared clip into zero retained players.

- `?r=<6-char>` creates or joins a private room. The lobby shows a copy-link button.
- Empty slots backfill with bots after 45s. The game is never unplayable.
- "Rematch" preserves the room — which means the room object already has to persist, so exposing it as a code is roughly 50 lines against a room manager M4 must build anyway.
- **Disconnects:** a client that closes its tab is replaced by a bot within 3s at the same position, souls and equipped upgrades, and can reclaim its slot for 120s by reopening the link. 3v3 is the most leaver-fragile team size in the reference table — one leaver is 33% of a team, versus 17% at Deadlock's 6v6 — and §1.4's no-accounts rule makes a leaver penalty unconstructible, so bot takeover is the only available answer. Nothing in the original document handled a client that vanished.

### 9.8 Spectator / stream mode
- Observer slot with free-cam, player-lock, and auto-director mode
- **Stream overlay export**: a `/overlay` route rendering live soul-differential, tower state, and ult timers as a transparent OBS browser source
- Spectator delay toggle (default 60s) to prevent stream sniping

---

## 10. Technical architecture

### 10.1 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict | One language across sim/client/server |
| Sim | Pure TS, zero deps | Runs in Node, Worker, and browser identically |
| Renderer | Three.js (r16x) | Known quantity, fast iteration |
| Physics | Custom capsule-vs-AABB + raycast + **swept tests**, ~1200 LOC | A full physics engine is overkill and non-deterministic. We need: capsule collide-and-slide, raycasts, sphere overlaps, **swept sphere-vs-AABB and swept sphere-vs-capsule**. Swept is not optional: a 45 m/s projectile advances 0.75m per tick at 60Hz against a ~0.8m hero capsule, so discrete per-tick tests let RIFT's rockets pass through people. The honest breakdown — collide-and-slide with slope limit and step-up (~200), broadphase (~130), ray primitives (~100), CCD (~120), mantle probes (~120), zipline constraint (~80), lag-comp history (~80), epsilon policy (~50) — lands at ~1200 minimum. This gets its own gate; it is what silently eats M1. |
| Client shell | Vite + vanilla TS (**not** Next.js) | This is a game, not a site. No SSR, no React reconciler in the frame loop. |
| Server | Node 22 + `uWebSockets.js` | Fastest WS implementation in Node |
| Transport | Binary WebSocket, custom bitpacked protocol | WebRTC/UDP is a later optimization, not an MVP requirement at 3v3 — **but see the caveat below** |
| Matchmaking | In-memory room manager, single process, **join-by-URL room codes** | 500 CCU on one Hetzner box is plenty for validation |

**Transport caveat.** M4's criterion "playable at 150ms with 2% packet loss" is not reachable over ordered-reliable TCP: at 20 snapshots/sec, 2% loss is one loss every 2.5 seconds, and TCP delivers nothing behind a lost segment until retransmission completes — ≥1 RTT, plus congestion-window reduction on a stream of small packets. A 150ms freeze every 2.5s is not "no visible rubber-banding." Two options, both acceptable, neither silent: promote WebRTC unreliable DataChannel into M4 with a WS fallback, or amend the criterion to state the expected hitch. **Either way, encode deltas against the last acked baseline from day one** — that is the only part that is expensive to change later, and it makes a future transport swap a swap rather than a protocol rewrite.
| Deploy | Hetzner CX32 + Caddy | Already in your stack |
| Build/test | Vitest, headless bot harness | |

### 10.2 Repo structure

```
ovrrun/
├── packages/
│   ├── sim/                    # ⚠️ PURE. No DOM, no THREE, no Date.now(), no Math.sin
│   │   ├── src/
│   │   │   ├── world.ts        # tick(state, inputs[]) -> state
│   │   │   ├── entities/       # hero, trooper, orb, tower, projectile, boss
│   │   │   ├── systems/        # movement, combat, economy, ai, objectives,
│   │   │   │                   #   visibility  ← MUST be here, not in render
│   │   │   ├── collision.ts    # capsule/AABB, raycast, sphere overlap, swept
│   │   │   ├── balance.ts      # ⭐ ALL tunable numbers, single file
│   │   │   ├── mathd.ts        # ⭐ portable sin/cos/atan2/pow — no Math.* trig
│   │   │   └── rng.ts          # stateless rngFor(tick, entityId, salt)
│   │   └── test/
│   ├── protocol/               # bitpack encode/decode, shared enums
│   ├── client/
│   │   ├── render/             # THREE scene, materials, VFX
│   │   ├── net/                # prediction, reconciliation, interpolation
│   │   ├── input/              # keybinds, mouse, camera controller
│   │   ├── ui/                 # HUD (plain DOM overlay, no framework)
│   │   └── replay/             # .ovr playback, director cam, MP4 export
│   ├── server/                 # room manager, authority loop, replay store
│   ├── bots/                   # AI controllers, shared client/server
│   └── telemetry/              # anon id + event log — Q1 and Q5 need this at M3
├── tools/
│   ├── headless-bench/         # ⭐ run N matches bot-vs-bot, emit CSV
│   ├── peek-test/              # TPS abuse regression test
│   ├── replay-diff/            # determinism verifier
│   ├── netsim/                 # delay/jitter/loss/reorder — M4 is unverifiable without it
│   └── perf-harness/           # Playwright: frame time, draw calls, tris, bundle size
└── assets/                     # .glb models, audio
```

**`systems/visibility.ts` is the one that gets misplaced.** §5.3 describes the head-LOS gate as a *rendering* rule. If it lives in the renderer, then bots — which read `WorldState` directly and have no perception model — see through walls, which means `headless-bench` measures TTK and hero win rates in a different game than humans play, and `peek-test` compares two omniscient agents and passes forever. It must be a pure `canSee(state, viewerId, targetId)` query in `sim`, consumed identically by the renderer, the bot AI, and the headless peek test. Run it tick-locked (every 4 ticks) with hysteresis — 2 consecutive occluded samples before hiding, 0.2s minimum visible dwell — and fail *closed* on a stale sample.

### 10.3 The simulation contract

```ts
// The entire game is this function. Everything else is I/O.
// dt is NOT a parameter — it is a module constant. A caller that can pass a
// different dt during catch-up is a caller that can break determinism.
function tick(state: WorldState, inputs: PlayerInput[]): WorldState
```

**Non-negotiable rules:**
- Fixed timestep **60Hz**. Never variable. Never `dt` from `requestAnimationFrame`.
- No `Math.random()` — only seeded `rng.ts`
- No `Date.now()` — only `state.tick`
- No floating-point accumulation across ticks without explicit quantization
- `tick()` must be **pure**: same state + same inputs = byte-identical output, verified by `tools/replay-diff`

**Why 60Hz and not 30Hz.** At 30Hz the two hitscan weapons land on half-ticks — 720 RPM is 2.5 ticks per shot and 240 RPM is 7.5 — so both fire on a jittering 2/3-tick cadence, and a `+12% fire rate` upgrade rounds to either −17% or +25%. The 20Hz snapshot rate is also 1.5 ticks, so entity interpolation spacing alternates. At 60Hz every one of these divides evenly (SMG 5 ticks, Rifle 15, Shotgun 30, Launcher 45, snapshot every 3, visibility gate every 4), aim sampling latency halves, and projectile travel per tick drops enough to make swept collision tractable. At 3v3 the CPU cost is irrelevant against the §10.6 budget.

**The numeric contract — decide this at M1, not M4.** "Byte-identical across Node, Worker and browser" is *not* achievable if sim code calls `Math.sin/cos/tan/atan2/pow/exp`: ECMAScript leaves those implementation-approximated, and V8, SpiderMonkey and JSC do not agree bit-for-bit — nor do V8 versions with each other. `+ - * / %` are spec-mandated round-to-nearest-even and FMA contraction is spec-illegal, so basic arithmetic **is** portable; `Math.sqrt` lowers to the hardware instruction and is correctly rounded, so it is safe in practice. Therefore:

- `packages/sim/src/mathd.ts` provides portable `sin/cos/atan2/pow/exp` built from `+ - * /` and `sqrt` only.
- An ESLint rule bans `Math.*` inside `packages/sim` except `abs/min/max/floor/ceil/trunc/round/sign/sqrt`, and bans the `**` operator. **CI-enforced, not eyeballed.**
- Positions and velocities integrate in integer millimetres (a 220m map fits in 18 bits). Floats survive only inside collision queries.

This matters more than it looks: the sim runs capsule collide-and-slide, which is dense in `if (t < eps)` branch tests. A 1-ULP difference flips which face you slide along, and the divergence is macroscopic **within one tick** — not a slow drift you can quantize away later.

This contract is what makes the whole plan work. It gives you: offline play, online play, replays, bot testing, and automated balance benchmarking — from one code path.

### 10.4 Netcode

| Concern | Approach |
|---|---|
| Sim rate | 60Hz server authoritative |
| Snapshot rate | 20Hz (every 3 ticks), delta-compressed, area-of-interest culled |
| Snapshot encoding | Delta **from the last client-acked baseline**, not from the previous snapshot |
| Client prediction | Client runs identical `tick()` on local input immediately |
| Reconciliation | Server acks input seq; on mismatch >`RECONCILE_THRESHOLD`, rewind to acked state and replay buffered inputs |
| Error correction | Below `HARD_SNAP_THRESHOLD`, correct the sim instantly but hold the residual in a **render-only offset that decays over ~120ms**. Above it, teleport. Yaw and pitch are client-authoritative and are **never** reconciled. |
| Entity interpolation | Remote players rendered 100ms in the past, smooth-lerped |
| Lag compensation | Server rewinds **the world**, not just hitboxes, to the shooter's rendered time, clamped at 200ms |
| Bandwidth budget | **<12 KB/s down, <3 KB/s up** per client |
| Input | **8 bytes/tick** bitpacked (seq 8, movement 4, buttons 13, yaw 13, pitch 12, sub-tick fire phase 5) |
| Input redundancy | Each uplink packet carries the last 3 unacked inputs. Missing input ⇒ repeat last for ≤3 ticks, then zero movement axes while holding view angles. Never freeze the entity. |

**Four rules that are easy to get wrong and expensive to retrofit:**

1. **Input is 8 bytes, not 4.** Count the mandatory fields — a sequence number (required, since the server acks input seq), two movement axes, and the ~13 buttons this design actually needs (fire, ADS, `V`, dash, Q, E, R, reload, melee, jump/mantle, slide, zipline, buy) — and 4 bytes leaves ≤7 bits for yaw *and* pitch combined. That is ~0.7°/step, roughly 3.4× a head's angular size at the Rifle's falloff limit, which deletes the ×1.5 headshot multiplier and HALO's entire identity. 8 bytes at 60Hz is ~1.6 KB/s including packet overhead, comfortably inside the <3 KB/s budget. **The client must quantize yaw/pitch *before* feeding them to its own prediction**, or client and server predict from different angles on every shot.

2. **RNG is stateless and derived, never a global stream.** `rngFor(tick, entityId, salt)` seeded from `hash(matchSeed, tick, entityId, salt)`. A single stateful stream cannot be predicted client-side — the client does not know how many draws other players consumed — so the Shotgun's 8 pellets would draw from different stream positions on client and server, and it would never trip reconciliation because spread does not move anyone. It would simply feel broken, for exactly one hero. Every simultaneous-resolution order must also be fixed (VOLT's chain target, RIFT's Displace victim order): nearest, then lowest entity id.

3. **Dynamic colliders live in the rewind history.** BULWARK's Slab is a runtime-spawned, destructible, expiring collider that blocks bullets both ways — and blocking a shot at the exact frame is its advertised clip. Storing rewound hero capsules but tracing bullets against present-time geometry means a clean shot is eaten by a wall that did not exist when the trigger was pulled. The history ring buffer holds hero capsules, head spheres, **and** the AABB/HP/alive-state of every Slab, mine and Collapse dome. Slab placement snaps to 90° yaw so it stays an AABB.

4. **Visibility gating is presentation, never authority.** §5.3's head-LOS test must never reject a shot server-side — high-ping players would get shots nullified for a reason no HUD can explain.

### 10.5 Bots
Bots are **first-class, not a testing afterthought.** They:
- Fill matches during low population (invisible backfill, generic names) **and take over on disconnect** (§9.7)
- Enable the entire M0–M3 development phase without networking — including a **stub bot at M0** for `peek-test`
- Power `headless-bench` for automated balance tuning
- Provide the practice mode

Three difficulty tiers via a single reaction-time + aim-error parameter pair. Behavior tree, not ML.

**Bots have a perception model.** Target acquisition is gated on `canSee()` from `systems/visibility.ts`, plus an audio channel for footsteps within a threshold radius (§4.1 makes tunnel footsteps a deliberate information source). Bots that read `WorldState` directly are omniscient, and since M3's TTK, §8's win rates and the whole M8 tuning loop are measured bot-vs-bot, an omniscient bench measures a *different game* than humans play — one where all six participants see through walls. This is the single cheapest way to make every balance number in the project wrong.

### 10.6 Performance budget

| Metric | Target |
|---|---|
| Frame time | ≤8ms @ 1080p on Intel Iris Xe |
| Draw calls | <120 |
| Triangles | <400k |
| Initial download | <9 MB gzipped |
| Time to first match | <6s from cold load |
| Server CPU | <5% of one core per active match |

Enforced by **`tools/perf-harness`** (frame time, draw calls, triangles, download size, time to first match) and **`tools/headless-bench`** (server CPU). Any milestone that regresses these fails its acceptance criteria.

`headless-bench` is a Node bot-match CSV runner with no GPU and no browser, so it can observe exactly one of these six budgets — which made §13's "if `headless-bench` regresses any perf budget, revert" inert for the other five. `perf-harness` is Playwright driving a fixed replay: draw calls and triangles from `renderer.info`, frame time as p99 over 600 frames, GPU string via `WEBGL_debug_renderer_info`, bundle size from the Vite manifest, time-to-first-match from a cold navigation.

---

## 11. Art direction

**Style: flat-shaded low-poly with hard emissive accents.** Cheap to produce, cheap to render, ages well, and reads instantly on stream at 720p — which is the actual constraint that matters.

| Element | Direction |
|---|---|
| Palette | Desaturated concrete/slate environment. **Only** teams, souls, and objectives are saturated. |
| Team A | Cyan `#00E5FF` |
| Team B | Orange `#FF6B1F` |
| Souls | White-gold `#FFD966`, heavy bloom, audible hum |
| Danger/ults | Magenta `#FF2E88` |
| Lighting | Single baked directional + emissive materials. No realtime shadows except a blob under each character. |
| Characters | ~4k tris, no facial detail, extreme silhouette differentiation (Bulwark is 1.4× wide, Halo is tall and thin) |
| VFX | Additive quads and simple GPU particles. Muzzle flashes and hit sparks are more important than model detail. |
| Audio | **Higher priority than visuals.** Distinct footstep/ability/reload signatures per hero. Soul pickup = the most satisfying sound in the game. Directional audio must be reliable — it's a competitive information channel. |

**Rule:** if an art task takes more than 2 hours, use a primitive-composed placeholder and move on. Gunfeel and netcode determine whether this game is fun. Nothing else does.

---

## 12. Milestones

Each milestone is a **vertical slice that is playable and testable**. Never build a system that can't be exercised in the same session.

**On the estimates.** The original figures totalled 13–17 sessions for a deterministic netcoded shooter with 12 abilities, bots, replays, spectator and video export. The honest number for the same scope at the same discipline is **34–50**, concentrated in M3, M4 and M6. The estimates gate nothing — §13 advances on ✅ criteria passing programmatically, not on elapsed time — so this is a scheduling correction, not a structural one. It matters for exactly one reason: §13's kill criterion *"M4 can't hit 80ms after 6 iterations"* is a 6-iteration budget on a ~10-session milestone, so it fires during normal progress. See §13.

### M0 — Feel Prototype *(1–2 sessions)*
Grey box arena. One capsule character. WASD + mouse look. TPS/FPS toggle. One hitscan weapon. **Dash, slide, mantle, zipline.** Shoot static targets.
- ✅ 60fps stable **on the named scene at the Iris Xe tier**, p99 over 600 frames, measured by `tools/perf-harness` — not on the dev machine, and not on an empty box
- ✅ Camera transition ≤0.15s with no clipping through geometry
- ✅ Mantle onto a 1.2m and a 2.4m ledge; zipline traverses the full 220m; slide preserves ≥80% of entry speed for 0.6s
- ✅ `tools/peek-test` runs green against a stub bot (§5.3)
- ✅ **Gate: is moving and shooting fun with zero content?** If no, iterate here. Do not proceed.

> **Why movement tech moved into M0.** P3 calls it "the primary clip source" and §4.1 makes both the roof layer and the MID PIT exit depend on it — yet no milestone criterion anywhere mentioned mantle, zipline or slide, so §13's "pick the task that advances the current milestone's criteria" would never have selected them. They are the same capsule controller as dash and cost a fraction here of what they cost retrofitted after prediction exists (a zipline is attached remote-player movement, which is precisely the M4 problem).

### M1 — Sim Core *(3–4 sessions)*
Extract everything into `packages/sim`. Fixed 60Hz tick. Stateless derived RNG. Client becomes a pure renderer of sim state. **The determinism harness is the real work here, not the extraction.**
- ✅ `tick()` has zero imports from THREE/DOM — **enforced by the CI purity lint**, not by inspection
- ✅ Same seed + same input log → **identical 10,000-tick state hash in Node 22, Chrome and Firefox**, run in CI via Playwright
- ✅ `mathd.ts` lands and the `Math.*` ban is green
- ✅ Physics gate: 10,000 randomized capsule sweeps and 10,000 randomized projectile sweeps through THE STRIP with zero tunneling and zero stuck states
- ✅ `.ovr` written and read as `{seed, build_hash, balance_hash, input_log}`
- ✅ Sim runs headless in Node

> **Why the determinism criterion changed.** The original ran in Node only — one engine — so it passed while the property it guards went untested until M6 needs Firefox. Deferring the numeric decision to M4 means re-deriving every constant in `balance.ts` against a new numeric type after 12 abilities are already written against the old one.

### M2 — Lane *(3–4 sessions)*
Load THE STRIP. Trooper waves, pathing, tower aggro, structure damage. Soul orbs with claim/deny.
- ✅ Wave spawns every 25s, walks to enemy tower, engages
- ✅ Orbs drop, claim and deny both function, expire correctly, **ownership resolves per §7.1**
- ✅ Towers target nearest trooper, switch to hero on hero-damages-allied-**hero** in tower range
- ✅ Every roof is reachable from ground within 8s from three named spawn positions
- ✅ Match ends when a core dies

### M3 — Combat & Bots *(6–9 sessions)*
All 4 heroes with full kits. Bots. Full economy including upgrades and bounties. **Playable 3v3 vs bots, start to finish.**
- ✅ A complete match is winnable and loseable against bots
- ✅ TTK inside band as an **analytic unit test over `balance.ts`** (HP ÷ DPS at a defined item tier), with `headless-bench` as the secondary empirical distribution
- ✅ Bot target acquisition is gated on `canSee()` plus an audio channel — **not** on raw `WorldState`
- ✅ All 12 upgrades functional with visible model changes
- ✅ `packages/telemetry` emits the Q1 camera-toggle events
- ✅ **Gate: play 10 matches. Is it addictive solo? If no, fix the design before networking.**

> **Why TTK moved to an analytic test.** Measured TTK in a bot bench is dominated by bot aim error, which is a single tunable parameter — so a RALPH loop asked to hit a measured TTK number will hit it the cheap way, by tuning the bots, and the weapons will never be checked.

### M4 — Netcode *(8–12 sessions — the hard one)*
Authoritative server. Prediction + reconciliation. Lag compensation. Room manager. **Build `tools/netsim` first.**
- ✅ Reconciliation corrections >0.25m occur <2/min at 80ms/0% loss, and <6/min at 150ms/2% loss
- ✅ p95 correction magnitude <0.4m
- ✅ Replaying a scripted input log through the offline sim and the online client at 0/80/150ms produces **hit-registration counts matching within 1%** — this is "shooting feels identical," made automatable, which §10.3's purity contract is exactly what buys you
- ✅ Bandwidth within budget
- ✅ Two browsers on different networks land in the same match from a single pasted URL, no account, no install
- ✅ A client that closes its tab is replaced by a bot within 3s and can reclaim its slot for 120s

> Three of the four original criteria needed a WAN emulator and a human, and no such tool existed in the §10.2 tree — so an agent would have validated over localhost, where RTT is ~0, and reported success.

### M5 — Objective & Match Flow *(2–3 sessions)*
MID PIT boss + steal. SURGE. Sudden death. Minimap pings. Full match lifecycle: lobby → hero select → match → scoreboard → rematch.
- ✅ Boss last-hit awards the full reward to the last-hitting team in 100/100 seeded headless trials, **including cross-team steals**
- ✅ SURGE arms and disarms exactly at its thresholds, and **reaches its own exit condition** in ≥80% of seeded comeback scenarios
- ✅ Sudden death resolves every match by 15:00 + 90s, including the draw case
- ✅ 100 lobby → match → rematch cycles complete headless with no leaked rooms

> M5 was the only milestone with **zero** ✅ lines, which meant §13's "never advance until every criterion passes programmatically" passed it by construction.

### M6 — Viral Layer *(5–6 sessions, having taken `.ovr` at M1)*
Killcam, announcer, Play of the Match, replay links, director cam, OBS overlay.
- ✅ Auto-clip fires correctly on all trigger conditions
- ✅ **A playtester produces a link a stranger opens and watches in under 6 seconds, with no install**
- ✅ MP4 in Chrome, WebM in Firefox
- ✅ **Gate: watch a recorded match with someone who has never seen the game. Can they follow it?**

> The original M6 bundled eleven separable subsystems at 2 sessions. Defining `.ovr` as an input log at M1 removes the ring buffer, the format work and most of the player from this milestone. Spectator auto-director and the 60s delayed stream move to `BACKLOG.md`.

### M7 — Feel Pass *(3–4 sessions)*
Screenshake, hitmarkers, hit sounds, recoil curves, audio mix, particle polish, UI juice. Nothing new — everything existing made 30% better.
- ✅ Every single player action has audio + visual feedback within 50ms

> **This milestone hard-blocks on ~60–80 audio assets that nothing in the plan produces**, and §11's "use a placeholder after 2 hours" escape hatch is scoped to *art* only. Name the source before M7 starts: procedural synthesis committed into the repo, a licensed pack, or a named human. §9.3's 5%-roll announcer variants are half the VO line count for 5% of the plays — they are already in `BACKLOG.md`.

### M8 — Playtest & Balance *(ongoing)*
15,000 headless bot matches → CSV → tune `balance.ts` → repeat. Then 20 humans.
- ✅ Per-comp win rate 45–55%, and per-hero **in-team soul share and damage share** 30–37% each
- ✅ Median match length 10–14 min
- ✅ <8% of matches decided before 6:00
- ✅ **Passive trickle ≤25% of median per-player income** (P2, enforced)

> **Why the balance gate changed shape.** With 4 heroes filling 3 of 6 slots, a given hero is on *both* teams in 9/16 of random comps — those matches are 50% by construction — so only ~375 of 1,000 matches are informative per hero, giving SE 2.58pp and failing a perfectly balanced hero 44% of the time. Per-hero win rate is close to unmeasurable at this roster size; in-team share is not.

---

## 13. RALPH loop instructions

For each iteration:

1. **Read** `PRD.md` + `STATE.md` (current milestone, per-criterion status, per-gate iteration counter, last failure, next task)
2. **Pick** the single smallest task that advances the current milestone's acceptance criteria
3. **Implement** in the smallest number of files possible
4. **Verify** — run `pnpm test`, `pnpm bench`, `pnpm determinism`, `pnpm lint` (the lint includes the sim purity guard)
5. **Record** result in `STATE.md` — **including incrementing the gate's iteration counter** — and append learnings to `DECISIONS.md`
6. **Never** advance a milestone until every ✅ criterion passes programmatically

**Hard constraints for the agent:**
- Never add a dependency without recording the justification in `DECISIONS.md`
- Never modify `packages/sim` in a way that breaks the determinism test
- Never tune balance outside `balance.ts`
- Never add a feature not in this PRD — append to `BACKLOG.md` instead
- If `perf-harness` or `headless-bench` regresses any perf budget, revert and reconsider

**Kill criteria — stop and escalate to a human if:**
- M0's fun gate fails after 3 iterations → the core is wrong
- M4 shows **no improvement in p95 correction magnitude across 3 consecutive sessions** → transport needs rethinking
- Match length variance exceeds ±3 min at M8 → the economy is broken

> Two of these were unenforceable or miscalibrated as written. Nothing persisted an iteration counter across a context reset, so a fresh session had no way to know whether it was on iteration 2 or 7 — hence the counter in `STATE.md`. And "M4 can't hit 80ms after 6 iterations" was a 6-iteration budget on a milestone that is realistically 8–12 sessions, so it fired during normal progress; a trend test is the right shape. The M8 tolerance tightened from ±6 min because ±6 admits an 18-minute match, which the 15:00 sudden-death escalation is supposed to make impossible.

**Before iteration 1 can run at all**, these must exist — the loop reads or invokes every one of them and none were specified: `pnpm-workspace.yaml` + root `package.json` with the four scripts actually wired; `STATE.md` with its fixed schema; `DECISIONS.md`; `BACKLOG.md` seeded from §16 so a second competing list never appears; `balance.ts` populated from this document; the CI purity lint; `tools/replay-diff` with a canonical state serializer and a golden hash file; and the `headless-bench` CSV schema, since M3, M8 and §10.6 all read it.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Netcode eats the whole timeline | **High** | Sim-first architecture means M0–M3 are fully playable with zero networking. If M4 stalls, you still have a shippable single-player-vs-bots game. |
| **Cross-engine float determinism fails** | **High** | *This was the highest-risk unknown the original table omitted — and it invalidates the mitigation for the row above.* `mathd.ts` + the `Math.*` ban + a tri-engine M1 gate. Decided at M1, not discovered at M4. |
| **~80 audio assets have no source** | **High** | M7's sole criterion hard-blocks on them and §11's placeholder escape hatch covers art only. Name the source (procedural / licensed pack / human) before M7 opens. |
| **Human-gate scheduling** | Medium | M0, M3 and M6 gates plus 20 testers on a game that needs 6 simultaneous humans. M3's 10-match gate is deliberate and stays; everything else gets a bot-measurable proxy from `headless-bench`. |
| TPS peek advantage makes FPS dead | High | Head-authoritative visibility gating (§5.3) + automated regression test **with the spread penalty forced equal on both arms**, ≥2,000 duels/arm |
| **Client holds occluded enemy positions** | Medium | The fix for the row above is also a wallhack surface: drawing the 0.4s silhouette needs the transform, and §1.4 forbids client anti-cheat. Gate in the snapshot encoder (§5.3), send 0.5m-quantized ghosts. Residual risk accepted. |
| **One leaver ends a 3v3** | Medium | Bot takeover within 3s inheriting position/souls/upgrades, slot reclaimable for 120s (§9.7). No accounts means no leaver penalty is constructible. |
| MOBA complexity creeps back in | High | Hard caps: 4 heroes, 12 upgrades, 3 slots, 1 lane. Everything else → `BACKLOG.md`. |
| Empty lobbies kill it | High | Bot backfill is invisible and always available. The game is never unplayable. |
| Browser perf ceiling | Medium | Low-poly is a design pillar, not a fallback. Budgets enforced in CI. |
| Sounds like a Deadlock clone | Medium | 3v3 / 12 min / single lane / camera toggle / clip-first is a materially different product. Lean into "the short one." |
| Web audio latency | Medium | Preload and pool all AudioBuffers; never construct sources at fire time |

---

## 15. Success criteria

**MVP is done when:**
1. **Six** humans can play a full 3v3 online match with sub-100ms feel *(the original said three, which is one team — a 3v3 needs six)*
2. Median match length lands 10–14 min
3. 10 external playtesters average ≥3 matches in one sitting without being asked
4. At least one playtester clips something and shares it unprompted — **this is the real bar**
5. Someone who has never played can follow a match as a spectator

---

## 16. Backlog (explicitly out of MVP)

Ranked, evaluate only after MVP validates:
1. Ranked + MMR
2. Heroes 5–8
3. Two-lane map variant
4. 5v5 mode
5. Custom lobbies / tournament mode
6. WebRTC transport for sub-50ms
7. Native wrapper (Tauri) for Steam
8. Cosmetics + monetization
9. Replay sharing **site** (clip feed — potentially the real growth engine). *Note: the basic share link is no longer here — it moved into M6 as §9.1's `GET /r/<id>`, because success criterion 4 was otherwise gated on a backlogged system. What remains backlogged is the feed, browse and discovery layer.*
10. Mobile spectator app
11. Spectator auto-director mode *(moved out of M6)*
12. 60s delayed spectator stream *(moved out of M6 — a second server-side stream path with its own memory cost)*
13. Announcer rare variants at 5% roll *(moved out of M6 — half the VO line count for 5% of plays)*

---

## 17. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does the FPS/TPS toggle survive contact with real players, or does everyone just pick one and never switch? | Instrument it from M3 via `packages/telemetry` — **the mechanism has to exist for the question to be answerable**, and it did not appear in any milestone. If <15% of players toggle mid-fight, reduce it to hold-ADS only and stop calling it a pillar. Note this reading was confounded until §5.1's ×1.4 TPS penalty was removed: with it, nobody toggled for reasons unrelated to preference. |
| Q2 | Is 3v3 too few for teamfight spectacle? | Ship 3v3. It's the fastest path to a fun match. Test 4v4 at M8 by changing one constant. |
| Q3 | Should souls persist on death? | Currently −10% capped at 200. Test 0% and −25% in headless bench; pick by comeback frequency. |
| Q4 | Browser-only, or Steam? | Browser for viral distribution and zero-friction playtesting. Tauri wrapper later if it takes. |
| Q5 | Is 12 min actually the right length? | Instrument at M8. If players immediately requeue, it's right. If they stop after one, it's too long. |

---

*End of PRD v1.0*
