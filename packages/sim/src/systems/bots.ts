/**
 * bots — PRD §10.5: "first-class, not a testing afterthought."
 *
 * They fill matches at low population, take over on disconnect, power
 * headless-bench, and are the entire practice mode. They also produce every
 * balance number the project has, which is why the one rule that matters is:
 *
 *   A BOT MAY ONLY ACT ON WHAT `canSee()` RETURNS.
 *
 * A bot that reads WorldState directly is an omniscient bot, and a bench of
 * omniscient bots measures a game nobody plays. Everything below routes
 * perception through visibility.ts or through an explicit audio radius —
 * footsteps are a real information channel (§4.1 makes tunnels loud on
 * purpose), so bots get to use them too, but only within a radius.
 *
 * Behaviour tree, not ML (§10.5). Three tiers from one reaction-time /
 * aim-error pair, so difficulty is two numbers rather than three AIs.
 */

import { ECONOMY, WORLD, COMBAT } from '../balance.js';
import { atan2, clamp, PI, TAU } from '../mathd.js';
import { rngFor, RNG_STREAM } from '../rng.js';
import {
  type WorldState, type HeroState, type PlayerInput,
  Btn, Team, MatchPhase, YAW_STEPS, PITCH_LIMIT,
} from '../types.js';
import { type Aabb } from '../collision.js';
import { canSee, canSeeRaw, type VisibilityMemory } from './visibility.js';

const MM = 1000;

export interface BotTier {
  name: string;
  /** ticks between seeing a thing and acting on it */
  reactionTicks: number;
  /** standard aim error in degrees at the reference range */
  aimErrorDeg: number;
  /** how tightly it tracks a moving target, 0..1 */
  tracking: number;
}

/** §10.5: three tiers from a single reaction-time + aim-error pair. */
export const BOT_TIERS: Record<'easy' | 'normal' | 'hard', BotTier> = {
  easy: { name: 'easy', reactionTicks: 24, aimErrorDeg: 5.0, tracking: 0.35 },
  normal: { name: 'normal', reactionTicks: 13, aimErrorDeg: 2.2, tracking: 0.62 },
  hard: { name: 'hard', reactionTicks: 7, aimErrorDeg: 0.9, tracking: 0.85 },
};

export interface BotState {
  heroId: number;
  tier: BotTier;
  /** ticks until the bot may act on what it currently perceives */
  reactionLeft: number;
  targetHeroId: number;
  targetOrbId: number;
  aimYaw: number;
  aimPitch: number;
  /** deliberate wander so a bot never stands perfectly still */
  strafeSign: number;
  strafeTicks: number;
  retreating: boolean;
  /** stuck detection — the lane has cover, a pit, tunnels and its own base */
  lastX: number;
  lastZ: number;
  stuckCheckIn: number;
  unstickTicks: number;
}

export function makeBot(heroId: number, tier: BotTier): BotState {
  return {
    heroId, tier,
    reactionLeft: 0,
    targetHeroId: -1,
    targetOrbId: -1,
    aimYaw: 0, aimPitch: 0,
    strafeSign: 1, strafeTicks: 0,
    retreating: false,
    lastX: 0, lastZ: 0, stuckCheckIn: 30, unstickTicks: 0,
  };
}

function yawTo(from: HeroState, tx: number, tz: number): number {
  // Matches the sim's convention: yaw 0 looks down −Z, +X is yaw 90°.
  const dx = tx - from.px / MM;
  const dz = tz - from.pz / MM;
  const rad = atan2(dx, -dz);
  const q = Math.round((rad / TAU) * YAW_STEPS);
  return ((q % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
}

function pitchTo(from: HeroState, tx: number, ty: number, tz: number): number {
  const ox = from.px / MM, oy = from.py / MM + 1.62, oz = from.pz / MM;
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const flat = Math.sqrt(dx * dx + dz * dz);
  const rad = atan2(dy, flat === 0 ? 1e-6 : flat);
  return clamp(Math.round((rad / (PI / 2)) * PITCH_LIMIT), -PITCH_LIMIT, PITCH_LIMIT);
}

function dist(a: HeroState, x: number, z: number): number {
  const dx = a.px / MM - x;
  const dz = a.pz / MM - z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Shortest signed step between two quantised yaws. */
function yawStep(from: number, to: number, frac: number): number {
  let d = ((to - from + YAW_STEPS * 1.5) % YAW_STEPS) - YAW_STEPS / 2;
  d = Math.round(d * frac);
  return ((from + d) % YAW_STEPS + YAW_STEPS) % YAW_STEPS;
}

/**
 * One bot's input for one tick.
 *
 * Reads perception through `canSee`/`canSeeRaw` only. The single place it is
 * allowed to consult raw state is its own hero and the map, which a human also
 * has.
 */
export function botInput(
  s: WorldState,
  bot: BotState,
  mem: VisibilityMemory,
  boxes: readonly Aabb[],
  seq: number,
): PlayerInput {
  const h = s.heroes.find((x) => x.id === bot.heroId);
  const idle: PlayerInput = {
    seq, entityId: bot.heroId, moveX: 0, moveZ: 0,
    yaw: bot.aimYaw, pitch: bot.aimPitch, buttons: 0, action: 0, fireSubTick: 0,
  };
  if (h === undefined || !h.alive || s.phase === MatchPhase.Over) return idle;

  const rng = rngFor(s.matchSeed, s.tick, h.id, RNG_STREAM.AI);
  let buttons = 0;
  let moveX = 0;
  let moveZ = 1; // default: advance down the lane

  const forward = h.team === Team.A ? 1 : -1;
  const hpFrac = h.hp / h.maxHp;

  // ---- perception -------------------------------------------------------
  // Visible enemies first; then anything close enough to hear.
  let enemy: HeroState | null = null;
  let enemyDist = 1e9;
  const HEAR_M = 22;
  for (const o of s.heroes) {
    if (!o.alive || o.team === h.team) continue;
    const d = dist(h, o.px / MM, o.pz / MM);
    const seen = canSee(s, mem, h.id, o.id);
    const heardMoving = d < HEAR_M && (Math.abs(o.vx) + Math.abs(o.vz)) > 2000;
    if (!seen && !heardMoving) continue;
    if (d < enemyDist) { enemyDist = d; enemy = o; }
  }

  // Orbs are physical objects in the world, so LOS applies to them too.
  let orb: { px: number; py: number; pz: number; id: number; mine: boolean } | null = null;
  let orbDist = 1e9;
  for (const o of s.orbs) {
    if (!o.alive || o.armTicksLeft > 0) continue;
    const d = dist(h, o.px / MM, o.pz / MM);
    if (d > 45 || d >= orbDist) continue;
    if (!canSeeRaw(h, o.px / MM, o.py / MM, o.pz / MM, 0.6, boxes)) continue;
    orbDist = d;
    orb = { px: o.px / MM, py: o.py / MM, pz: o.pz / MM, id: o.id, mine: o.ownerTeam === h.team };
  }

  /**
   * Enemy troopers. Bots that never shoot the wave are the reason a bot match
   * stalls: two symmetric waves annihilate each other at mid in perpetuity, no
   * side ever gains the trooper advantage that pushes a lane, and every
   * structure sits at 100% for the whole match.
   *
   * Prefer the lowest-HP one in range — that is last-hitting, it is what spawns
   * the orbs §7 is built around, and it is what a human does.
   */
  let creep: { px: number; py: number; pz: number; hp: number } | null = null;
  let creepDist = 1e9;
  let creepHp = 1e18;
  for (const t of s.troopers) {
    if (!t.alive || t.team === h.team) continue;
    const d = dist(h, t.px / MM, t.pz / MM);
    if (d > COMBAT.SMG.FALLOFF_END_M) continue;
    if (!canSeeRaw(h, t.px / MM, t.py / MM, t.pz / MM, WORLD.TROOPERS.HITBOX_HEIGHT_M, boxes)) continue;
    if (t.hp < creepHp || (t.hp === creepHp && d < creepDist)) {
      creepHp = t.hp; creepDist = d;
      creep = { px: t.px / MM, py: t.py / MM, pz: t.pz / MM, hp: t.hp };
    }
  }

  // Nearest live enemy structure, and whether we are close enough to commit.
  let siegeTarget: { x: number; z: number } | null = null;
  let siegeDist = 1e9;
  for (const st of s.structures) {
    if (!st.alive || st.team === h.team) continue;
    const d = dist(h, st.px / MM, st.pz / MM);
    if (d < siegeDist) { siegeDist = d; siegeTarget = { x: st.px / MM, z: st.pz / MM }; }
  }
  const SIEGE_COMMIT_M = WORLD.STRUCTURES.TOWER_RANGE_M + 15;
  if (siegeDist > SIEGE_COMMIT_M) siegeTarget = null;

  // ---- reaction ---------------------------------------------------------
  // A newly-acquired target cannot be acted on for `reactionTicks`. This is
  // the whole of "difficulty" alongside aim error.
  if (enemy !== null && enemy.id !== bot.targetHeroId) {
    bot.targetHeroId = enemy.id;
    bot.reactionLeft = bot.tier.reactionTicks;
  } else if (enemy === null) {
    bot.targetHeroId = -1;
  }
  if (bot.reactionLeft > 0) bot.reactionLeft--;
  const reacted = bot.reactionLeft === 0;

  // ---- retreat hysteresis ----------------------------------------------
  // Two thresholds, or the bot oscillates on the boundary and looks broken.
  if (!bot.retreating && hpFrac < 0.3) bot.retreating = true;
  else if (bot.retreating && hpFrac > 0.6) bot.retreating = false;

  // ---- aim --------------------------------------------------------------
  let wantYaw = bot.aimYaw;
  let wantPitch = 0;

  if (enemy !== null) {
    wantYaw = yawTo(h, enemy.px / MM, enemy.pz / MM);
    wantPitch = pitchTo(h, enemy.px / MM, enemy.py / MM + 1.2, enemy.pz / MM);
  } else if (orb !== null) {
    wantYaw = yawTo(h, orb.px, orb.pz);
    wantPitch = pitchTo(h, orb.px, orb.py, orb.pz);
  } else if (creep !== null) {
    wantYaw = yawTo(h, creep.px, creep.pz);
    wantPitch = pitchTo(h, creep.px, creep.py + 0.9, creep.pz);
  } else {
    // Walk the lane, looking where it is going.
    wantYaw = h.team === Team.A ? YAW_STEPS / 4 : (YAW_STEPS * 3) / 4;
    wantPitch = 0;
  }

  // Aim error, seeded so a replay reproduces every miss.
  const errDeg = rng.signed() * bot.tier.aimErrorDeg;
  const errSteps = Math.round((errDeg / 360) * YAW_STEPS);
  bot.aimYaw = yawStep(bot.aimYaw, (wantYaw + errSteps + YAW_STEPS) % YAW_STEPS, bot.tier.tracking);
  bot.aimPitch = Math.round(bot.aimPitch + (wantPitch - bot.aimPitch) * bot.tier.tracking);

  // ---- act --------------------------------------------------------------
  if (h.ammo === 0) buttons |= Btn.Reload;

  if (enemy !== null && reacted && !bot.retreating) {
    const aimed = Math.abs(((bot.aimYaw - wantYaw + YAW_STEPS * 1.5) % YAW_STEPS) - YAW_STEPS / 2);
    const withinCone = aimed < YAW_STEPS * 0.02; // ~7°
    if (withinCone && enemyDist < COMBAT.SMG.FALLOFF_END_M) buttons |= Btn.Fire;
    if (enemyDist > 25) buttons |= Btn.Ads; // hold the angle at range

    // Strafe while duelling. A bot that walks straight at you is target practice.
    bot.strafeTicks--;
    if (bot.strafeTicks <= 0) {
      bot.strafeTicks = 30 + rng.below(40);
      bot.strafeSign = -bot.strafeSign;
    }
    moveX = bot.strafeSign;
    moveZ = enemyDist > 18 ? 1 : enemyDist < 8 ? -1 : 0;
  } else if (orb !== null && orbDist < 40) {
    // Contest the orb. Denying an enemy orb is worth doing even when it pays
    // half — §7.2's whole point is that the contest is the gameplay.
    const aimed = Math.abs(((bot.aimYaw - wantYaw + YAW_STEPS * 1.5) % YAW_STEPS) - YAW_STEPS / 2);
    if (aimed < YAW_STEPS * 0.015 && orbDist < ECONOMY.SHOTGUN_ORB_WALL_M * 3) buttons |= Btn.Fire;
    moveZ = orbDist > 6 ? 1 : 0;
  } else if (siegeTarget !== null && !bot.retreating) {
    /**
     * Siege. This branch must outrank clearing the wave, or a bot never
     * commits: at mid there is almost always a creep inside weapon range, so
     * creep-first means the lane grinds for the whole match and every structure
     * finishes at 100%. Proximity to a live enemy structure is the signal that
     * the push already happened and it is time to cash it in.
     */
    bot.aimYaw = yawStep(bot.aimYaw, yawTo(h, siegeTarget.x, siegeTarget.z), 0.5);
    bot.aimPitch = Math.round(bot.aimPitch * 0.6);
    if (siegeDist < WORLD.STRUCTURES.TOWER_RANGE_M - 4) {
      buttons |= Btn.Fire;
      moveZ = siegeDist > 12 ? 1 : 0;
    } else {
      moveZ = 1;
    }
  } else if (creep !== null && !bot.retreating) {
    // Clear the wave — this is what creates the push the branch above cashes in.
    const aimed = Math.abs(((bot.aimYaw - wantYaw + YAW_STEPS * 1.5) % YAW_STEPS) - YAW_STEPS / 2);
    if (aimed < YAW_STEPS * 0.02) buttons |= Btn.Fire;
    moveZ = creepDist > 10 ? 1 : 0; // follow the wave, never back off from it
  } else {
    // Nothing to do here: walk down the lane toward the enemy base.
    const goalX = forward * WORLD.MAP.CORE_X_ABS_M;
    bot.aimYaw = yawStep(bot.aimYaw, yawTo(h, goalX, 0), 0.25);
    moveZ = 1;
  }

  if (bot.retreating) {
    moveZ = -1;
    moveX = 0;
    // Dash out. This is what §6.4 calls the get-out-of-jail card, and a bot
    // that never uses it makes the whole mechanic look optional in the bench.
    if (h.dashCharges > 0 && enemy !== null && enemyDist < 14) buttons |= Btn.Dash;
    bot.aimYaw = yawStep(bot.aimYaw, (yawTo(h, h.px / MM - forward * 20, h.pz / MM) + 0) % YAW_STEPS, 0.3);
  }

  /**
   * Stuck detection. A bot that walks into geometry and keeps pushing is the
   * single most common way a bench silently stops measuring anything — the
   * first version of this walked into its own core and stood there for the
   * whole match, and every "no damage dealt" result looked like a balance
   * problem rather than a pathing one.
   */
  bot.stuckCheckIn--;
  if (bot.stuckCheckIn <= 0) {
    bot.stuckCheckIn = 30;
    const moved = Math.abs(h.px / MM - bot.lastX) + Math.abs(h.pz / MM - bot.lastZ);
    const wantedToMove = moveX !== 0 || moveZ !== 0;
    if (wantedToMove && moved < 0.6) {
      bot.unstickTicks = 45;
      bot.strafeSign = -bot.strafeSign;
    }
    bot.lastX = h.px / MM;
    bot.lastZ = h.pz / MM;
  }
  if (bot.unstickTicks > 0) {
    bot.unstickTicks--;
    // Peel sideways and keep advancing: strafing alone can wedge in a corner.
    moveX = bot.strafeSign;
    if (bot.unstickTicks > 25) moveZ = 0;
    if (h.grounded && bot.unstickTicks === 30) buttons |= Btn.Jump;
  }

  // Never stand perfectly still: a motionless capsule is neither fun to fight
  // nor representative of a human for benchmarking purposes.
  if (moveX === 0 && moveZ === 0 && rng.below(100) < 4) moveX = rng.below(3) - 1;

  /**
   * Bots emote. This is not decoration: §9's whole thesis is clip generation,
   * and a bot that taunts after a kill produces the same moment a human would.
   * Rate-limited by the sim's shared wheel budget like everyone else.
   */
  let action = 0;
  if (!bot.retreating && enemy === null && rng.below(400) === 0) {
    action = 1 + rng.below(6); // Action.EmoteWave .. EmoteSit
  }

  return {
    seq, entityId: bot.heroId,
    moveX, moveZ,
    yaw: bot.aimYaw, pitch: bot.aimPitch,
    buttons, action, fireSubTick: 0,
  };
}

