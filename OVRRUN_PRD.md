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
| **P2** | **Contested economy** | Gold is never passive. Every unit of income is a physical object someone can shoot away from you. |
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
- **2min loop** — accumulate gold → buy an upgrade → feel measurably stronger
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
| Hipfire spread | ×1.4 penalty | ×1.0 baseline |
| ADS available | No | Yes |
| Movement speed | ×1.0 | ×1.0 (×0.6 while ADS) |
| Ability aiming | Full 3D arc preview, ground-target reticle | Crosshair only, no arc preview |
| Best for | Traversal, ability combos, awareness, melee | Ranged duels, precision, long lane pokes |

### 5.2 Switching rules

- **`V`** — hard toggle. 0.15s camera lerp. No cooldown, no penalty, spammable.
- **`Right Mouse` (hold)** — auto-enters FPS + ADS. Releasing returns to your prior mode.
- Switching is **never blocked** — not while dashing, not mid-air, not while stunned (camera still moves during stun for spectacle).

The hold-to-ADS path means players who never learn `V` still get the full FPS experience automatically. The toggle is for advanced players who want TPS *awareness* while strafing and FPS *precision* on the shot.

### 5.3 Solving third-person peek abuse — CRITICAL

TPS lets you see around corners your character can't. Unsolved, this makes TPS strictly dominant and kills FPS as a choice. Three layered fixes, all required:

1. **Camera occlusion pull-in.** Standard spring-arm: camera collides with geometry and pulls toward the head. Already limits extreme peeking.
2. **Enemy visibility gating (the important one).** In TPS, an enemy is only *rendered* if they are visible from the **player's head position**, not the camera position. Ray-test head→enemy each frame at 15Hz. If occluded from the head but visible from the camera: render the enemy as a **faint red silhouette outline only** (no model, no hitbox highlight, no nameplate) for 0.4s, then hide. This preserves "something is there" awareness without giving free information.
3. **Hitreg is head-authoritative.** Bullets originate from the muzzle in world space, never from the camera. If your reticle is on a wall from the character's perspective, you shoot the wall. Reticle turns dim red when the muzzle→target ray is blocked.

**Acceptance test:** two bots on opposite sides of a corner. In TPS the peeking bot must not achieve >5% higher first-shot hit rate than in FPS. Automate this in `tools/headless-bench/peek-test.ts`.

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
- Server keeps a rolling **20-second ring buffer** of compressed world snapshots per match
- Auto-triggers on: triple takedown, objective steal, sub-10%-HP survival that leads to a kill, tower backdoor, cross-map ult kill
- On trigger: writes a `.ovr` replay file (snapshot deltas only, ~200KB)
- `F9` at any time exports the last 20 seconds manually
- Replays are viewable in a **free director camera** with slow-mo, orbit, and per-player POV switching
- Client-side MP4 export via `MediaRecorder` on an offscreen canvas render

### 9.2 KILLCAM
1.2s, killer's POV, from 0.8s before the fatal shot. Non-skippable for the first 0.6s (this is deliberate — the sting is the point, and it teaches players what killed them). Displays the killer's equipped upgrades and remaining HP.

### 9.3 ANNOUNCER
Escalating tiers with rare variants (5% roll) so clips don't feel repetitive:

| Trigger | Line tier |
|---|---|
| 2 kills / 5s | "DOUBLE" |
| 3 kills / 8s | "TRIPLE" |
| 3 kills solo, no deaths, 12s | "OVERRUN" (title drop) |
| Soul denial streak ×5 | "STARVED" |
| Objective stolen at <5% HP | "**ROBBED**" — loudest sound in the game |
| Killing a +450 bounty | "BOUNTY CLAIMED" |
| Team wipe | "WIPED" |

### 9.4 THE STEAL
The MID PIT boss can be last-hit by *anyone*. Whoever deals the killing blow takes the full 500 souls + buff for their team. No exceptions, no protection mechanic, no smite-equivalent that removes the tension.

**This is the single biggest clip generator in the game and it must never be balanced away.** If it feels unfair, that is the correct feeling.

### 9.5 SURGE (comeback mechanic)
If a team is >2500 souls behind at any point after 6:00, their core emits **SURGE**: +15% soul income and −25% respawn timers until the gap closes below 1200. Visible to both teams as a pulsing red aura on the losing core — the winning team *knows* the comeback is armed, which creates tension rather than resentment.

### 9.6 PLAY OF THE MATCH
Post-match, score every 6-second window across all players by a weighted heuristic (damage dealt × takedowns × improbability-of-survival × objective value). Play the top window as a replay. Winner gets a nameplate flourish. ~30 lines of code, enormous perceived value.

### 9.7 Spectator / stream mode
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
| Physics | Custom capsule-vs-AABB + raycast, ~500 LOC | A full physics engine is overkill and non-deterministic. We need: capsule collide-and-slide, raycasts, sphere overlaps. That's it. |
| Client shell | Vite + vanilla TS (**not** Next.js) | This is a game, not a site. No SSR, no React reconciler in the frame loop. |
| Server | Node 22 + `uWebSockets.js` | Fastest WS implementation in Node |
| Transport | Binary WebSocket, custom bitpacked protocol | WebRTC/UDP is a later optimization, not an MVP requirement at 3v3 |
| Matchmaking | In-memory room manager, single process | 500 CCU on one Hetzner box is plenty for validation |
| Deploy | Hetzner CX32 + Caddy | Already in your stack |
| Build/test | Vitest, headless bot harness | |

### 10.2 Repo structure

```
ovrrun/
├── packages/
│   ├── sim/                    # ⚠️ PURE. No DOM, no THREE, no Date.now()
│   │   ├── src/
│   │   │   ├── world.ts        # tick(state, inputs[]) -> state
│   │   │   ├── entities/       # hero, trooper, orb, tower, projectile
│   │   │   ├── systems/        # movement, combat, economy, ai, objectives
│   │   │   ├── collision.ts    # capsule/AABB, raycast, sphere overlap
│   │   │   ├── balance.ts      # ⭐ ALL tunable numbers, single file
│   │   │   └── rng.ts          # seeded xorshift128, no Math.random anywhere
│   │   └── test/
│   ├── protocol/               # bitpack encode/decode, shared enums
│   ├── client/
│   │   ├── render/             # THREE scene, materials, VFX
│   │   ├── net/                # prediction, reconciliation, interpolation
│   │   ├── input/              # keybinds, mouse, camera controller
│   │   ├── ui/                 # HUD (plain DOM overlay, no framework)
│   │   └── replay/             # .ovr playback, director cam, MP4 export
│   ├── server/                 # room manager, authority loop, clip buffer
│   └── bots/                   # AI controllers, shared client/server
├── tools/
│   ├── headless-bench/         # ⭐ run N matches bot-vs-bot, emit CSV
│   ├── peek-test/              # TPS abuse regression test
│   └── replay-diff/            # determinism verifier
└── assets/                     # .glb models, audio
```

### 10.3 The simulation contract

```ts
// The entire game is this function. Everything else is I/O.
function tick(state: WorldState, inputs: PlayerInput[], dt: 1/30): WorldState
```

**Non-negotiable rules:**
- Fixed timestep **30Hz**. Never variable. Never `dt` from `requestAnimationFrame`.
- No `Math.random()` — only seeded `rng.ts`
- No `Date.now()` — only `state.tick`
- No floating-point accumulation across ticks without explicit quantization
- `tick()` must be **pure**: same state + same inputs = byte-identical output, verified by `tools/replay-diff`

This is what makes the whole plan work. It gives you: offline play, online play, replays, bot testing, and automated balance benchmarking — from one code path.

### 10.4 Netcode

| Concern | Approach |
|---|---|
| Sim rate | 30Hz server authoritative |
| Snapshot rate | 20Hz, delta-compressed, area-of-interest culled |
| Client prediction | Client runs identical `tick()` on local input immediately |
| Reconciliation | Server acks input seq; on mismatch >0.05m, rewind to acked state and replay buffered inputs |
| Entity interpolation | Remote players rendered 100ms in the past, smooth-lerped |
| Lag compensation | Server rewinds hitboxes to shooter's rendered time, clamped at 200ms |
| Bandwidth budget | **<12 KB/s down, <3 KB/s up** per client |
| Input | 4 bytes/tick bitpacked (movement + buttons + quantized yaw/pitch) |

### 10.5 Bots
Bots are **first-class, not a testing afterthought.** They:
- Fill matches during low population (invisible backfill, generic names)
- Enable the entire M0–M3 development phase without networking
- Power `headless-bench` for automated balance tuning
- Provide the practice mode

Three difficulty tiers via a single reaction-time + aim-error parameter pair. Behavior tree, not ML.

### 10.6 Performance budget

| Metric | Target |
|---|---|
| Frame time | ≤8ms @ 1080p on Intel Iris Xe |
| Draw calls | <120 |
| Triangles | <400k |
| Initial download | <9 MB gzipped |
| Time to first match | <6s from cold load |
| Server CPU | <5% of one core per active match |

Enforced by `tools/headless-bench` — any milestone that regresses these fails its acceptance criteria.

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

### M0 — Feel Prototype *(target: 1 session)*
Grey box arena. One capsule character. WASD + mouse look. TPS/FPS toggle. One hitscan weapon. Dash. Shoot static targets.
- ✅ 60fps stable
- ✅ Camera transition ≤0.15s with no clipping through geometry
- ✅ **Gate: is moving and shooting fun with zero content?** If no, iterate here. Do not proceed.

### M1 — Sim Core *(1–2 sessions)*
Extract everything into `packages/sim`. Fixed 30Hz tick. Seeded RNG. Client becomes a pure renderer of sim state.
- ✅ `tick()` has zero imports from THREE/DOM
- ✅ Same seed + same input log → byte-identical state after 10,000 ticks (`replay-diff`)
- ✅ Sim runs headless in Node

### M2 — Lane *(1–2 sessions)*
Load THE STRIP. Trooper waves, pathing, tower aggro, structure damage. Soul orbs with claim/deny.
- ✅ Wave spawns every 25s, walks to enemy tower, engages
- ✅ Orbs drop, claim and deny both function, 2.5s expiry
- ✅ Towers target nearest trooper, switch to hero on hero-damages-ally
- ✅ Match ends when a core dies

### M3 — Combat & Bots *(2–3 sessions)*
All 4 heroes with full kits. Bots. Full economy including upgrades and bounties. **Playable 3v3 vs bots, start to finish.**
- ✅ A complete match is winnable and loseable against bots
- ✅ TTK measured at 1.2–2.0s in `headless-bench`
- ✅ All 12 upgrades functional with visible model changes
- ✅ **Gate: play 10 matches. Is it addictive solo? If no, fix the design before networking.**

### M4 — Netcode *(3–4 sessions — the hard one)*
Authoritative server. Prediction + reconciliation. Lag compensation. Room manager.
- ✅ 3v3 online, playable at 80ms RTT with no visible rubber-banding
- ✅ Playable at 150ms with 2% packet loss
- ✅ Bandwidth within budget
- ✅ Shooting feels identical online and offline (this is the real test)

### M5 — Objective & Match Flow *(1 session)*
MID PIT boss + steal. SURGE. Sudden death. Full match lifecycle: lobby → hero select → match → scoreboard → rematch.

### M6 — Viral Layer *(2 sessions)*
Clip buffer, killcam, announcer, Play of the Match, spectator, OBS overlay.
- ✅ Auto-clip fires correctly on all trigger conditions
- ✅ MP4 export works in Chrome and Firefox
- ✅ **Gate: watch a recorded match with someone who has never seen the game. Can they follow it?**

### M7 — Feel Pass *(2 sessions)*
Screenshake, hitmarkers, hit sounds, recoil curves, audio mix, particle polish, UI juice. Nothing new — everything existing made 30% better.
- ✅ Every single player action has audio + visual feedback within 50ms

### M8 — Playtest & Balance *(ongoing)*
1000 headless bot matches → CSV → tune `balance.ts` → repeat. Then 20 humans.
- ✅ Hero win rates 48–52%
- ✅ Median match length 10–14 min
- ✅ <8% of matches decided before 6:00

---

## 13. RALPH loop instructions

For each iteration:

1. **Read** `PRD.md` + `STATE.md` (current milestone, last failure, next task)
2. **Pick** the single smallest task that advances the current milestone's acceptance criteria
3. **Implement** in the smallest number of files possible
4. **Verify** — run `pnpm test`, `pnpm bench`, `pnpm determinism`
5. **Record** result in `STATE.md`, append learnings to `DECISIONS.md`
6. **Never** advance a milestone until every ✅ criterion passes programmatically

**Hard constraints for the agent:**
- Never add a dependency without recording the justification in `DECISIONS.md`
- Never modify `packages/sim` in a way that breaks the determinism test
- Never tune balance outside `balance.ts`
- Never add a feature not in this PRD — append to `BACKLOG.md` instead
- If `headless-bench` regresses any perf budget, revert and reconsider

**Kill criteria — stop and escalate to a human if:**
- M0's fun gate fails after 3 iterations → the core is wrong
- M4 can't hit 80ms playability after 6 iterations → transport needs rethinking
- Match length variance exceeds ±6 min at M8 → the economy is broken

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Netcode eats the whole timeline | **High** | Sim-first architecture means M0–M3 are fully playable with zero networking. If M4 stalls, you still have a shippable single-player-vs-bots game. |
| TPS peek advantage makes FPS dead | High | Head-authoritative visibility gating (§5.3) + automated regression test |
| MOBA complexity creeps back in | High | Hard caps: 4 heroes, 12 upgrades, 3 slots, 1 lane. Everything else → `BACKLOG.md`. |
| Empty lobbies kill it | High | Bot backfill is invisible and always available. The game is never unplayable. |
| Browser perf ceiling | Medium | Low-poly is a design pillar, not a fallback. Budgets enforced in CI. |
| Sounds like a Deadlock clone | Medium | 3v3 / 12 min / single lane / camera toggle / clip-first is a materially different product. Lean into "the short one." |
| Web audio latency | Medium | Preload and pool all AudioBuffers; never construct sources at fire time |

---

## 15. Success criteria

**MVP is done when:**
1. Three humans can play a full 3v3 online match with sub-100ms feel
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
9. Replay sharing site (clip feed — potentially the real growth engine)
10. Mobile spectator app

---

## 17. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does the FPS/TPS toggle survive contact with real players, or does everyone just pick one and never switch? | Instrument it from M3. If <15% of players toggle mid-fight, reduce it to hold-ADS only and stop calling it a pillar. |
| Q2 | Is 3v3 too few for teamfight spectacle? | Ship 3v3. It's the fastest path to a fun match. Test 4v4 at M8 by changing one constant. |
| Q3 | Should souls persist on death? | Currently −10% capped at 200. Test 0% and −25% in headless bench; pick by comeback frequency. |
| Q4 | Browser-only, or Steam? | Browser for viral distribution and zero-friction playtesting. Tauri wrapper later if it takes. |
| Q5 | Is 12 min actually the right length? | Instrument at M8. If players immediately requeue, it's right. If they stop after one, it's too long. |

---

*End of PRD v1.0*
