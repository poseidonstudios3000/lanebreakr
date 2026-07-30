/**
 * structures — towers, cores, aggro, regen, backdoor, win condition.
 *
 * Two ambiguities in §12/M2 and §3 had to be settled before this could be
 * built, and both were load-bearing:
 *
 *   "switch to hero on hero-damages-ally" — "ally" means an allied HERO. The
 *   trooper reading re-aggros the tower on every last hit, which makes
 *   contesting souls under a tower impossible and falsifies Pillar P2 in
 *   exactly the zone a pushed lane puts the contested farm.
 *
 *   Tower order — §3's "break TOWER → TOWER 2 → CORE" implies a sequence,
 *   while §9.1 makes "tower backdoor" an auto-clip trigger, which an order gate
 *   would render unreachable. There are no invulnerability gates. The order is
 *   descriptive of normal play, not a rule; protection is regen only, so a
 *   committed backdoor always works and an interrupted one always fails.
 */

import { SPINE, WORLD } from '../balance.js';
import {
  type WorldState, type StructureState,
  StructureKind, Team, MatchPhase,
} from '../types.js';

const MM = 1000;
const S = WORLD.STRUCTURES;

export function structureMaxHp(kind: StructureKind): number {
  return (kind === StructureKind.Core ? S.CORE_HP : kind === StructureKind.TowerT2 ? S.TOWER_T2_HP : S.TOWER_T1_HP) * SPINE.DAMAGE_SCALE;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = (ax - bx) / MM;
  const dz = (az - bz) / MM;
  return dx * dx + dz * dz;
}

/** Is a friendly tower still standing closer to mid than this one? */
function isProtected(s: WorldState, st: StructureState): boolean {
  const myDist = Math.abs(st.px);
  for (const o of s.structures) {
    if (!o.alive || o.team !== st.team || o.id === st.id) continue;
    if (Math.abs(o.px) < myDist) return true;
  }
  return false;
}

export function stepStructures(
  s: WorldState,
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team) => void,
): void {
  if (s.phase === MatchPhase.Over) return;

  for (let i = 0; i < s.structures.length; i++) {
    const st = s.structures[i]!;
    if (!st.alive) continue;

    st.outOfCombat++;

    // --- regen ------------------------------------------------------------
    if (s.phase !== MatchPhase.SuddenDeath || !WORLD.SUDDEN_DEATH.DISABLE_ALL_STRUCTURE_REGEN) {
      const protectedNow = st.kind !== StructureKind.Core && isProtected(s, st)
        && !(s.phase === MatchPhase.SuddenDeath && WORLD.SUDDEN_DEATH.DISABLE_BACKDOOR_PROTECTION);
      if (protectedNow && st.outOfCombat >= S.BACKDOOR_REGEN_DELAY_TICKS) {
        st.hp = Math.min(st.maxHp, st.hp + Math.round((S.BACKDOOR_REGEN_HPS * SPINE.DAMAGE_SCALE) / SPINE.SIM_HZ));
      } else if (st.kind !== StructureKind.Core && st.outOfCombat >= S.TOWER_REGEN_DELAY_TICKS) {
        st.hp = Math.min(st.maxHp, st.hp + Math.round((S.TOWER_REGEN_HPS * SPINE.DAMAGE_SCALE) / SPINE.SIM_HZ));
      }
    }

    if (st.kind === StructureKind.Core && !S.CORE_IS_ARMED) continue;

    // --- damage ramp decay (per tower, never reset by a target switch) ------
    if (st.rampStacks > 0) {
      if (st.rampDecayIn > 0) st.rampDecayIn--;
      else { st.rampStacks--; st.rampDecayIn = S.TOWER_RAMP_DECAY_TICKS; }
    }

    if (st.attackCooldown > 0) st.attackCooldown--;
    if (st.targetDwell > 0) st.targetDwell--;

    // --- targeting --------------------------------------------------------
    const prevTarget = st.targetId;
    if (st.targetDwell <= 0) {
      st.targetId = pickTarget(s, st);
      st.targetDwell = S.TOWER_TARGET_MIN_DWELL_TICKS;
    } else if (!stillValid(s, st)) {
      st.targetId = pickTarget(s, st);
    }

    if (st.targetId < 0) { st.acquireDelay = S.TOWER_ACQUIRE_DELAY_TICKS; continue; }
    if (st.targetId !== prevTarget) st.acquireDelay = S.TOWER_ACQUIRE_DELAY_TICKS;
    if (st.acquireDelay > 0) { st.acquireDelay--; continue; }

    if (st.attackCooldown === 0) {
      st.attackCooldown = S.TOWER_ATTACK_INTERVAL_TICKS;
      const isHero = s.heroes.some((h) => h.id === st.targetId);
      let dmg: number;
      if (isHero) {
        dmg = Math.min(S.TOWER_DMG_VS_HERO_CAP, S.TOWER_DMG_VS_HERO_BASE + S.TOWER_DMG_VS_HERO_RAMP * st.rampStacks);
        st.rampStacks++;
        st.rampDecayIn = S.TOWER_RAMP_DECAY_TICKS;
      } else {
        dmg = S.TOWER_DMG_VS_TROOPER;
      }
      applyDamage(st.targetId, dmg * SPINE.DAMAGE_SCALE, st.team);
    }
  }
}

function stillValid(s: WorldState, st: StructureState): boolean {
  const r2 = S.TOWER_RANGE_M * S.TOWER_RANGE_M;
  for (const h of s.heroes) if (h.id === st.targetId) return h.alive && dist2(st.px, st.pz, h.px, h.pz) <= r2;
  for (const t of s.troopers) if (t.id === st.targetId) return t.alive && dist2(st.px, st.pz, t.px, t.pz) <= r2;
  return false;
}

/**
 * Priority, top-down:
 *   1. enemy hero who damaged an allied HERO within the window, in range
 *   2. enemy hero who damaged THIS structure within the window
 *   3. nearest enemy trooper in range
 *   4. nearest enemy hero in range
 */
function pickTarget(s: WorldState, st: StructureState): number {
  const r2 = S.TOWER_RANGE_M * S.TOWER_RANGE_M;

  if (st.aggroHeroUntil > s.tick && st.aggroHeroId >= 0) {
    const h = s.heroes.find((x) => x.id === st.aggroHeroId);
    if (h !== undefined && h.alive && dist2(st.px, st.pz, h.px, h.pz) <= r2) return h.id;
  }

  let best = -1;
  let bestD = r2;
  for (const t of s.troopers) {
    if (!t.alive || t.team === st.team) continue;
    const d = dist2(st.px, st.pz, t.px, t.pz);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  if (best >= 0) return best;

  bestD = r2;
  for (const h of s.heroes) {
    if (!h.alive || h.team === st.team) continue;
    const d = dist2(st.px, st.pz, h.px, h.pz);
    if (d < bestD) { bestD = d; best = h.id; }
  }
  return best;
}

/** A hero damaged an allied hero — pull nearby friendly tower aggro. */
export function markStructureAggro(s: WorldState, victimTeam: Team, victimX: number, victimZ: number, attackerId: number): void {
  const r2 = S.TOWER_RANGE_M * S.TOWER_RANGE_M;
  for (const st of s.structures) {
    if (!st.alive || st.team !== victimTeam) continue;
    if (dist2(st.px, st.pz, victimX, victimZ) > r2) continue;
    st.aggroHeroUntil = s.tick + S.TOWER_HERO_AGGRO_WINDOW_TICKS;
    st.aggroHeroId = attackerId;
    st.targetDwell = 0; // re-evaluate immediately: this is the anti-dive rule
  }
}

/** Called when a structure reaches 0. Returns true if the match is over. */
export function onStructureDestroyed(s: WorldState, st: StructureState): boolean {
  st.alive = false;
  if (st.kind === StructureKind.Core) {
    s.phase = MatchPhase.Over;
    s.winner = st.team === Team.A ? Team.B : Team.A;
    return true;
  }
  s.teams[st.team]!.towersLost++;
  return false;
}
