/**
 * world — THE ENTIRE GAME IS THIS FUNCTION. Everything else is I/O. (PRD §10.3)
 *
 *   tick(world, inputs) -> void
 *
 * Note what is NOT a parameter: dt. It is a module constant. A signature that
 * accepts dt is a signature a caller can pass a different dt to during
 * catch-up, and that is how determinism dies quietly six weeks into netcode.
 */

import { SPINE, ENTITY, MOVEMENT, ECONOMY, WORLD, COMBAT, M0, respawnTicks, suddenDeathDecayPerTick } from './balance.js';
import {
  type WorldState, type HeroState, type TargetState, type PlayerInput,
  type TrooperState, type StructureState, type TeamState,
  MoveState, CameraMode, Team, MatchPhase, StructureKind, SoulSource, Btn,
} from './types.js';
import { buildGreybox } from './map/greybox.js';
import { buildStrip, type GameMap } from './map/strip.js';
import { stepMovement } from './systems/movement.js';
import { stepCombat } from './systems/combat.js';
import { stepTroopers, markRetaliation } from './systems/troopers.js';
import { stepEconomy, spawnOrb, grantSouls } from './systems/economy.js';
import { stepStructures, structureMaxHp, onStructureDestroyed, markStructureAggro } from './systems/structures.js';
import { updateVisibility, newVisibilityMemory, canSee, type VisibilityMemory } from './systems/visibility.js';
import { stepGlitch, castGlitch, scrambleInput } from './systems/glitch.js';
import { botInput, makeBot, BOT_TIERS, type BotState, type BotTier } from './systems/bots.js';

const MM = 1000;

export type WorldMode = 'greybox' | 'strip';

export interface World {
  state: WorldState;
  map: GameMap;
  mode: WorldMode;
  /** respawn countdowns, indexed by hero id */
  respawn: number[];
  deathsInSuddenDeath: number[];
  /** §5.3's gate, shared by the renderer, the bots and peek-test */
  vis: VisibilityMemory;
  /** hero ids driven by AI. §10.5: bots are first-class, not a test fixture. */
  bots: Map<number, BotState>;
}

export function createHero(id: number, team: Team, x: number, y: number, z: number, yaw: number): HeroState {
  return {
    id, team, alive: true,
    px: Math.round(x * MM), py: Math.round(y * MM), pz: Math.round(z * MM),
    vx: 0, vy: 0, vz: 0,
    yaw, pitch: 0,
    hp: SPINE.HERO_BASE_HP * SPINE.DAMAGE_SCALE,
    maxHp: SPINE.HERO_BASE_HP * SPINE.DAMAGE_SCALE,
    moveState: MoveState.Air, grounded: false, groundedTick: -999, jumpBufferedTick: -999,
    camera: CameraMode.TPS, cameraLerp: 0, adsTicks: 0, adsPriorCamera: -1,
    dashCharges: MOVEMENT.DASH_CHARGES, dashRechargeTicks: 0, dashTicksLeft: 0,
    dashCooldownTicks: 0, iframeTicksLeft: 0, dashDirX: 0, dashDirZ: 0,
    slideTicksLeft: 0, slideCooldownTicks: 0,
    mantleTicksLeft: 0, mantleTotalTicks: 1, mantleTargetX: 0, mantleTargetY: 0, mantleTargetZ: 0,
    ziplineId: -1, ziplineT: 0, ziplineDir: 1,
    ammo: 32, reloadTicksLeft: 0, fireCooldownTicks: 0, postReloadLockout: 0,
    meleeTicksLeft: 0, meleeCooldownTicks: 0,
    spreadMilliDeg: 0, spreadDecayDelay: 0,
    recoilVertMilliDeg: 0, recoilHorizMilliDeg: 0, recoilRecoveryDelay: 0,
    shotsFired: 0, hitsLanded: 0, headshots: 0, damageDealt: 0,
    glitchTicksLeft: 0, glitchSeed: 0, abilityQCooldown: 0,
    prevButtons: 0, lastDamagedTick: -99999, lastMoveX: 0, lastMoveZ: 0, noInputTicks: 0,
  };
}

function createTarget(id: number, x: number, y: number, z: number, minX: number, maxX: number, speed: number): TargetState {
  return {
    id,
    px: Math.round(x * MM), py: Math.round(y * MM), pz: Math.round(z * MM),
    hp: M0.TARGET_HP * SPINE.DAMAGE_SCALE, maxHp: M0.TARGET_HP * SPINE.DAMAGE_SCALE,
    alive: true, respawnTicksLeft: 0,
    vx: Math.round(speed * MM),
    minX: Math.round(minX * MM), maxX: Math.round(maxX * MM),
  };
}

function emptyTeam(): TeamState {
  return { souls: [], contestableEarned: 0, surging: false, surgeTicksLeft: 0, marchTicksLeft: 0, towersLost: 0 };
}

export function createWorld(matchSeed: number, mode: WorldMode = 'greybox'): World {
  const map = mode === 'strip' ? buildStrip() : (buildGreybox() as unknown as GameMap);

  const heroes: HeroState[] = [];
  const structures: StructureState[] = [];
  let nextId = 0;

  if (mode === 'strip') {
    // 3v3. Ids 0–2 are team A, 3–5 team B, always — a fixed id layout is what
    // lets the wire protocol and the bots index without a lookup.
    for (const team of [Team.A, Team.B]) {
      const sp = map.heroSpawn[team]!;
      for (let i = 0; i < 3; i++) {
        // Cover blocks occupy |z| ∈ [4.5, 8.5]; stay inside that.
        const lateral = [-2.5, 0, 2.5][i]!;
        heroes.push(createHero(nextId++, team, sp.x, sp.y, sp.z + lateral, sp.yaw));
      }
    }
    for (const site of map.structures) {
      const hp = structureMaxHp(site.kind);
      structures.push({
        id: nextId++, team: site.team, kind: site.kind, alive: true,
        px: Math.round(site.x * MM), py: 0, pz: Math.round(site.z * MM),
        hp, maxHp: hp,
        attackCooldown: 0, acquireDelay: 0, targetId: -1, targetDwell: 0,
        rampStacks: 0, rampDecayIn: 0, outOfCombat: 9999,
        aggroHeroUntil: -1, aggroHeroId: -1,
      });
    }
  } else {
    heroes.push(createHero(nextId++, Team.A, map.spawn.x, map.spawn.y, map.spawn.z, map.spawn.yaw));
  }

  const targets = mode === 'greybox'
    ? map.targets.map((t, i) => createTarget(1000 + i, t.x, t.y, t.z, t.minX, t.maxX, t.speed))
    : [];

  return {
    state: {
      tick: 0, matchSeed,
      phase: mode === 'strip' ? MatchPhase.Live : MatchPhase.Warmup,
      winner: -1,
      heroes, troopers: [], orbs: [], structures, glitches: [],
      teams: [emptyTeam(), emptyTeam()],
      nextWaveTick: WORLD.TROOPERS.FIRST_WAVE_TICK,
      waveIndex: 0,
      nextEntityId: nextId,
      targets, events: [], soulEvents: [],
    },
    map,
    mode,
    respawn: [],
    deathsInSuddenDeath: [],
    vis: newVisibilityMemory(),
    bots: new Map(),
  };
}

/** Put a bot on a hero slot. Backfill, practice mode and the bench all use this. */
export function assignBot(w: World, heroId: number, tier: BotTier = BOT_TIERS.normal): void {
  w.bots.set(heroId, makeBot(heroId, tier));
}

/** Every slot except `humanIds` gets a bot — the default single-player setup. */
export function fillWithBots(w: World, humanIds: readonly number[], tier: BotTier = BOT_TIERS.normal): void {
  for (const h of w.state.heroes) {
    if (!humanIds.includes(h.id)) assignBot(w, h.id, tier);
  }
}

export { BOT_TIERS, canSee };
export type { BotTier };

/**
 * The single damage router. Every source — bullets, troopers, towers, the boss
 * — resolves through here, so there is exactly one place where "what happens
 * when a thing loses HP" is decided.
 */
export function makeApplyDamage(w: World) {
  const s = w.state;
  return function applyDamage(targetId: number, milliDamage: number, sourceTeam: Team, attackerId = -1): void {
    for (const h of s.heroes) {
      if (h.id !== targetId || !h.alive) continue;
      if (h.iframeTicksLeft > 0) return; // dash i-frames, evaluated at the rewound tick
      h.hp -= milliDamage;
      h.lastDamagedTick = s.tick;
      if (attackerId >= 0) {
        markRetaliation(s, h, attackerId);
        markStructureAggro(s, h.team, h.px, h.pz, attackerId);
      }
      if (h.hp <= 0) killHero(w, h, attackerId);
      return;
    }
    for (const t of s.troopers) {
      if (t.id !== targetId || !t.alive) continue;
      t.hp -= milliDamage;
      if (t.hp <= 0) { t.alive = false; spawnOrb(s, t); }
      return;
    }
    for (const st of s.structures) {
      if (st.id !== targetId || !st.alive) continue;
      st.hp -= milliDamage;
      st.outOfCombat = 0;
      if (st.hp <= 0) {
        st.hp = 0;
        const over = onStructureDestroyed(s, st);
        if (!over) {
          const payout = st.kind === StructureKind.TowerT2
            ? ECONOMY.TOWER_T2_SOULS_PER_PLAYER : ECONOMY.TOWER_T1_SOULS_PER_PLAYER;
          const winners = st.team === Team.A ? Team.B : Team.A;
          for (const h of s.heroes) {
            if (h.team === winners) grantSouls(s, h, payout, SoulSource.Tower, true);
          }
        }
      }
      return;
    }
    for (const t of s.targets) {
      if (t.id !== targetId || !t.alive) continue;
      t.hp -= milliDamage;
      if (t.hp <= 0) { t.hp = 0; t.alive = false; t.respawnTicksLeft = M0.TARGET_RESPAWN_TICKS; }
      return;
    }
  };
}

function killHero(w: World, h: HeroState, killerId: number): void {
  const s = w.state;
  h.hp = 0;
  h.alive = false;
  h.vx = 0; h.vy = 0; h.vz = 0;

  const sd = s.phase === MatchPhase.SuddenDeath;
  if (sd) w.deathsInSuddenDeath[h.id] = (w.deathsInSuddenDeath[h.id] ?? 0) + 1;
  w.respawn[h.id] = respawnTicks(s.tick, s.teams[h.team]!.surging, sd, w.deathsInSuddenDeath[h.id] ?? 0);

  const killer = s.heroes.find((x) => x.id === killerId);
  if (killer !== undefined && killer.team !== h.team) {
    grantSouls(s, killer, ECONOMY.TAKEDOWN_SOULS, SoulSource.Takedown, true);
  }
}

/** One 60Hz step. Pure with respect to (state, inputs). */
export function tick(world: World, inputs: readonly PlayerInput[]): void {
  const s = world.state;
  s.events.length = 0;
  s.soulEvents.length = 0;

  // Perception first, so bots act on this tick's sample rather than last
  // tick's. Tick-locked inside, so this is cheap on the 3 ticks out of 4 it
  // does nothing.
  updateVisibility(s, world.vis, world.map.boxes);

  // Bot inputs are appended, never substituted: a human input for the same id
  // always wins, which is what makes disconnect-takeover a one-line change.
  let allInputs: PlayerInput[] | readonly PlayerInput[] = inputs;
  if (world.bots.size > 0) {
    const merged = [...inputs];
    for (const bot of world.bots.values()) {
      if (merged.some((i) => i.entityId === bot.heroId)) continue;
      merged.push(botInput(s, bot, world.vis, world.map.boxes, s.tick));
    }
    allInputs = merged;
  }
  inputs = allInputs;

  const applyDamage = makeApplyDamage(world);

  if (s.phase !== MatchPhase.Over && world.mode === 'strip' && s.tick >= SPINE.SUDDEN_DEATH_TICK) {
    s.phase = MatchPhase.SuddenDeath;
  }

  // Fixed iteration order over heroes, ascending id. Never Map/Set iteration
  // order, and never "whichever input arrived first".
  for (let i = 0; i < s.heroes.length; i++) {
    const h = s.heroes[i]!;

    if (!h.alive) {
      const left = (world.respawn[h.id] ?? 0) - 1;
      world.respawn[h.id] = left;
      if (left <= 0) {
        const sp = world.mode === 'strip' ? world.map.heroSpawn[h.team]! : world.map.spawn;
        h.alive = true;
        h.hp = h.maxHp;
        h.px = Math.round(sp.x * MM); h.py = Math.round(sp.y * MM); h.pz = Math.round(sp.z * MM);
        h.vx = 0; h.vy = 0; h.vz = 0;
        h.ammo = 32; h.reloadTicksLeft = 0;
      }
      continue;
    }

    let input: PlayerInput | undefined;
    for (let j = 0; j < inputs.length; j++) {
      if (inputs[j]!.entityId === h.id) { input = inputs[j]; break; }
    }

    /**
     * §10.4: a missing input repeats the last one for up to 3 ticks, then
     * zeroes the movement axes while holding view angles — it never freezes
     * the entity. Skipping the whole step instead means gravity, cooldowns and
     * reloads all stop, so a player whose packet was dropped hangs in mid-air
     * with a frozen gun. That is a netcode bug you would otherwise not meet
     * until M4, in a build where it looks like lag.
     */
    if (input === undefined) {
      h.noInputTicks++;
      const stale = h.noInputTicks > 3;
      input = {
        seq: -1, entityId: h.id,
        moveX: stale ? 0 : h.lastMoveX,
        moveZ: stale ? 0 : h.lastMoveZ,
        yaw: h.yaw, pitch: h.pitch,
        buttons: stale ? 0 : h.prevButtons,
        fireSubTick: 0,
      };
    } else {
      h.noInputTicks = 0;
      h.lastMoveX = input.moveX;
      h.lastMoveZ = input.moveZ;
    }

    // §6.2: 2%/s after 5s out of combat. Note it is NOT gated on shooting a
    // soul orb — §7 makes orbs the other sustain path, and treating a farm as
    // "in combat" would delete the only in-lane recovery a healerless game has.
    if (s.tick - h.lastDamagedTick >= COMBAT.REGEN_OUT_OF_COMBAT_TICKS && h.hp < h.maxHp) {
      h.hp = Math.min(h.maxHp, h.hp + Math.round((h.maxHp * COMBAT.REGEN_FRAC_PER_S) / SPINE.SIM_HZ));
    }

    const prevInput = h.prevButtons;
    // GLITCH BOMB. Cast reads the RAW input (you can always try to throw one),
    // but movement and aim consume the SCRAMBLED input — the sim owns the
    // scramble because a client-side one is a client-side one, and because a
    // replay has to reproduce the exact flailing.
    if ((input.buttons & Btn.AbilityQ) !== 0 && (prevInput & Btn.AbilityQ) === 0) {
      castGlitch(s, h, world.map.boxes);
    }
    input = scrambleInput(s, h, input);

    const prev = h.prevButtons;
    stepMovement(h, input, prev, s.tick, world.map.boxes, world.map.ziplines);
    stepCombat(h, input, prev, s.tick, s.matchSeed, s, world.map.boxes, applyDamage);
    h.prevButtons = input.buttons;

    if (h.py < -30 * MM) {
      const sp = world.mode === 'strip' ? world.map.heroSpawn[h.team]! : world.map.spawn;
      h.px = Math.round(sp.x * MM); h.py = Math.round(sp.y * MM); h.pz = Math.round(sp.z * MM);
      h.vx = 0; h.vy = 0; h.vz = 0;
    }
  }

  if (world.mode === 'strip') {
    stepGlitch(s, applyDamage);
    stepTroopers(s, world.map.trooperSpawn, applyDamage);
    stepStructures(s, applyDamage);
    stepEconomy(s);

    if (s.phase === MatchPhase.SuddenDeath) {
      const fracA = structureFrac(s, Team.A);
      const fracB = structureFrac(s, Team.B);
      for (const st of s.structures) {
        if (!st.alive) continue;
        const leader = st.team === Team.A ? fracA >= fracB : fracB > fracA;
        const decay = suddenDeathDecayPerTick(s.tick, leader);
        st.hp -= Math.round(st.maxHp * decay);
        if (st.hp <= 0) { st.hp = 0; onStructureDestroyed(s, st); }
      }
    }
  } else {
    for (let i = 0; i < s.targets.length; i++) {
      const t = s.targets[i]!;
      if (!t.alive) {
        t.respawnTicksLeft--;
        if (t.respawnTicksLeft <= 0) { t.alive = true; t.hp = t.maxHp; }
        continue;
      }
      if (t.vx !== 0) {
        t.px += Math.round(t.vx * SPINE.TICK_S);
        if (t.px >= t.maxX) { t.px = t.maxX; t.vx = -t.vx; }
        else if (t.px <= t.minX) { t.px = t.minX; t.vx = -t.vx; }
      }
    }
  }

  s.tick++;
}

function structureFrac(s: WorldState, team: Team): number {
  let hp = 0;
  let max = 0;
  for (const st of s.structures) {
    if (st.team !== team) continue;
    hp += Math.max(0, st.hp);
    max += st.maxHp;
  }
  return max > 0 ? hp / max : 0;
}

/**
 * Canonical state hash. Order and field set are fixed; this is the value
 * tools/replay-diff compares across Node, Chrome and Firefox (§12/M1).
 * FNV-1a over the integer state — no floats reach it by construction.
 */
export function hashState(s: WorldState): number {
  let hash = 0x811c9dc5;
  const push = (v: number): void => {
    const n = v | 0;
    hash ^= n & 0xff; hash = Math.imul(hash, 0x01000193);
    hash ^= (n >>> 8) & 0xff; hash = Math.imul(hash, 0x01000193);
    hash ^= (n >>> 16) & 0xff; hash = Math.imul(hash, 0x01000193);
    hash ^= (n >>> 24) & 0xff; hash = Math.imul(hash, 0x01000193);
  };

  push(s.tick); push(s.phase); push(s.winner); push(s.waveIndex); push(s.nextEntityId);
  for (const h of s.heroes) {
    push(h.px); push(h.py); push(h.pz); push(h.vx); push(h.vy); push(h.vz);
    push(h.yaw); push(h.pitch); push(h.hp); push(h.alive ? 1 : 0);
    push(h.moveState); push(h.grounded ? 1 : 0);
    push(h.dashCharges); push(h.dashRechargeTicks); push(h.dashTicksLeft);
    push(h.slideTicksLeft); push(h.mantleTicksLeft); push(h.ziplineId); push(h.ziplineT);
    push(h.ammo); push(h.reloadTicksLeft); push(h.fireCooldownTicks);
    push(h.spreadMilliDeg); push(h.recoilVertMilliDeg); push(h.recoilHorizMilliDeg);
    push(h.shotsFired); push(h.hitsLanded); push(h.headshots); push(h.damageDealt);
    push(h.glitchTicksLeft); push(h.glitchSeed); push(h.abilityQCooldown);
    push(h.prevButtons);
  }
  for (const t of s.troopers) {
    push(t.id); push(t.px); push(t.py); push(t.pz); push(t.hp); push(t.alive ? 1 : 0);
    push(t.targetId); push(t.attackCooldown); push(t.retargetIn);
  }
  for (const o of s.orbs) {
    push(o.id); push(o.px); push(o.py); push(o.pz); push(o.hoverTicksLeft);
    push(o.claimProgress); push(o.denyProgress); push(o.alive ? 1 : 0);
  }
  for (const st of s.structures) {
    push(st.id); push(st.hp); push(st.alive ? 1 : 0); push(st.targetId);
    push(st.attackCooldown); push(st.rampStacks); push(st.outOfCombat);
  }
  for (const t of s.teams) {
    push(t.contestableEarned); push(t.surging ? 1 : 0); push(t.marchTicksLeft);
    for (const v of t.souls) push(v ?? 0);
  }
  for (const t of s.targets) {
    push(t.px); push(t.py); push(t.pz); push(t.hp); push(t.alive ? 1 : 0); push(t.vx);
  }
  return hash >>> 0;
}

export const EYE_HEIGHT_M = ENTITY.EYE_HEIGHT_M;
export type { TrooperState, StructureState };
