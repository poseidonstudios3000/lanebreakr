/**
 * economy — soul orbs, income, SURGE.
 *
 * PRD §7.2 calls this "the single most important system in the game". It is
 * also the one the document specified least, and three of its rules had to be
 * settled before it could be built at all:
 *
 *   OWNERSHIP  never stated, so "deny" had no referent. An orb belongs to the
 *              team opposite the trooper that dropped it.
 *   CLAIM      never stated whether a hit or accumulated damage claims. Under
 *              one-hit-claims a 720 RPM hitscan gets 12 attempts/sec against
 *              the Launcher's 1/sec, so the plurality income source would be
 *              decided by hero pick. It is an HP pool.
 *   MULTI-HIT  never stated whether 8 shotgun pellets or a 3m splash claim one
 *              orb or all of them. Pellets each damage exactly one orb; splash
 *              claims nothing at all.
 *
 * And the passive trickle is 3.2× smaller than §7.3's, because at 12/s per team
 * it paid more than every orb in the match combined and made Pillar P2 false.
 */

import { SPINE, ECONOMY, WORLD, orbSouls } from '../balance.js';
import {
  type WorldState, type OrbState, type TrooperState, type HeroState,
  Team, SoulSource, MatchPhase,
} from '../types.js';

const MM = 1000;

export function spawnOrb(s: WorldState, t: TrooperState): void {
  s.orbs.push({
    id: s.nextEntityId++,
    // The orb belongs to the team that did NOT own the trooper.
    ownerTeam: t.team === Team.A ? Team.B : Team.A,
    px: t.px,
    py: t.py + Math.round(1.1 * MM),
    pz: t.pz,
    hoverTicksLeft: ECONOMY.ORB_HOVER_TICKS,
    armTicksLeft: ECONOMY.ORB_ARM_DELAY_TICKS,
    claimProgress: 0,
    denyProgress: 0,
    lastClaimer: -1,
    lastDenier: -1,
    alive: true,
  });
}

export function grantSouls(
  s: WorldState,
  hero: HeroState,
  amount: number,
  source: SoulSource,
  contestable: boolean,
): void {
  let v = amount;
  const team = s.teams[hero.team]!;
  if (contestable && team.surging && ECONOMY.PASSIVE_SURGE_ELIGIBLE === false) {
    v = Math.floor((v * ECONOMY.SURGE_INCOME_BONUS_NUM) / ECONOMY.SURGE_INCOME_BONUS_DEN);
  }
  team.souls[hero.id] = (team.souls[hero.id] ?? 0) + v;
  if (contestable) team.contestableEarned += v;
  s.soulEvents.push({
    tick: s.tick, heroId: hero.id, team: hero.team, source, amount: v,
    x: hero.px / MM, y: hero.py / MM, z: hero.pz / MM,
  });
}

/**
 * Apply weapon damage to an orb. Returns true if this hit completed it.
 *
 * `falloffMult` is applied here rather than by the caller because orb damage
 * takes falloff but NOT item bonuses or headshots — the two flags protect
 * different things (a range gate versus an itemisation→faster-farm spiral) and
 * collapsing them into one boolean is what made the two derived domains
 * contradict each other.
 */
export function damageOrb(
  s: WorldState,
  orb: OrbState,
  shooter: HeroState,
  baseDamage: number,
  falloffMult: number,
): boolean {
  if (!orb.alive || orb.armTicksLeft > 0) return false;
  const dmg = Math.trunc(baseDamage * falloffMult);
  if (dmg <= 0) return false;

  const isOwner = shooter.team === orb.ownerTeam;
  if (isOwner) {
    orb.claimProgress += dmg;
    orb.lastClaimer = shooter.id;
  } else {
    orb.denyProgress += dmg;
    orb.lastDenier = shooter.id;
  }

  const done = isOwner ? orb.claimProgress >= ECONOMY.ORB_HP : orb.denyProgress >= ECONOMY.ORB_HP;
  if (!done) return false;

  orb.alive = false;
  const credited = isOwner ? orb.lastClaimer : orb.lastDenier;
  const hero = s.heroes.find((h) => h.id === credited);
  if (hero !== undefined) {
    const souls = orbSouls(s.tick, !isOwner, false);
    grantSouls(s, hero, souls, isOwner ? SoulSource.OrbClaim : SoulSource.OrbDeny, true);
    // §6.2 promised "sustain comes from items and soul pickups" and its income
    // table delivered none. The denier heals more: they are by definition the
    // one being pushed, and this is the only in-lane recovery path in a game
    // with no healers and no fog.
    const heal = (isOwner ? ECONOMY.ORB_CLAIM_HEAL_HP : ECONOMY.ORB_DENY_HEAL_HP) * SPINE.DAMAGE_SCALE;
    hero.hp = Math.min(hero.maxHp, hero.hp + heal);
  }
  return true;
}

export function stepEconomy(s: WorldState): void {
  if (s.phase === MatchPhase.Over) return;

  // --- orbs --------------------------------------------------------------
  for (let i = 0; i < s.orbs.length; i++) {
    const o = s.orbs[i]!;
    if (!o.alive) continue;
    if (o.armTicksLeft > 0) o.armTicksLeft--;
    o.hoverTicksLeft--;
    if (o.hoverTicksLeft <= 0) {
      o.alive = false; // ORB_EXPIRE_SOULS = 0: an unclaimed orb pays nobody
    }
  }
  if (s.orbs.length > 64) s.orbs = s.orbs.filter((o) => o.alive);

  // --- passive trickle ---------------------------------------------------
  // Granted as an integer on a fixed interval so nothing accumulates in float.
  if (s.tick % ECONOMY.PASSIVE_GRANT_INTERVAL_TICKS === 0) {
    for (const h of s.heroes) {
      // PASSIVE_PAYS_WHILE_DEAD: this is the floor, and the only income that
      // is not a physical object someone can shoot away from you.
      grantSouls(s, h, ECONOMY.PASSIVE_GRANT_SOULS, SoulSource.Passive, false);
    }
  }

  // --- SURGE -------------------------------------------------------------
  if (s.tick % ECONOMY.SURGE_EVAL_INTERVAL_TICKS === 0) evaluateSurge(s);
  for (const team of s.teams) {
    if (team.surgeTicksLeft > 0) team.surgeTicksLeft--;
    if (team.marchTicksLeft > 0) team.marchTicksLeft--;
  }
}

/**
 * §9.5's SURGE armed at >2500 behind on TOTAL souls after 6:00 and disarmed
 * below 1200 — a 1300 swing that +15% could never produce, so it never
 * disarmed; and because the trickle was identical for both teams it diluted
 * the gap and only armed in a ~62/38 stomp.
 *
 * The gap is now measured on CONTESTABLE lifetime earnings only, the trigger is
 * lower, and the bonus is large enough to reach its own exit.
 */
function evaluateSurge(s: WorldState): void {
  if (s.tick < ECONOMY.SURGE_ARM_EARLIEST_TICK) return;
  if (s.phase === MatchPhase.SuddenDeath && ECONOMY.SURGE_DISABLED_IN_SUDDEN_DEATH) {
    s.teams[0]!.surging = false;
    s.teams[1]!.surging = false;
    return;
  }

  const a = s.teams[0]!.contestableEarned;
  const b = s.teams[1]!.contestableEarned;
  for (const t of [0, 1] as const) {
    const team = s.teams[t]!;
    const gap = (t === 0 ? b - a : a - b);
    if (!team.surging && gap > ECONOMY.SURGE_ARM_GAP) {
      team.surging = true;
      team.surgeTicksLeft = ECONOMY.SURGE_MIN_DURATION_TICKS;
    } else if (team.surging && gap < ECONOMY.SURGE_DISARM_GAP && team.surgeTicksLeft <= 0) {
      team.surging = false;
    }
  }
}

export function teamSouls(s: WorldState, team: Team): number {
  let total = 0;
  for (const v of s.teams[team]!.souls) total += v ?? 0;
  return total;
}

export const MARCH_TICKS = WORLD.MARCH.DURATION_TICKS;
