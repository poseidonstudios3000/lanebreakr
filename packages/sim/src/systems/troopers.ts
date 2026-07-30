/**
 * troopers — wave spawning, pathing, targeting, attacks.
 *
 * The wave is the metronome the whole game runs on (PRD §3's 25s loop), and it
 * is also mobile cover: `BLOCKS_BULLETS` means shooting through your own wave
 * is a real decision, not a free line.
 *
 * The one rule that is easy to get wrong: damaging an allied TROOPER never
 * redirects a wave, and never pulls tower aggro. The other reading of §12/M2's
 * "hero-damages-ally" makes every last hit aggro the tower, which makes
 * contesting souls under a tower impossible — in exactly the zone a pushed lane
 * puts the contested farm.
 */

import { SPINE, WORLD, waveScale } from '../balance.js';
import {
  type WorldState, type TrooperState, type HeroState, type StructureState,
  TrooperKind, Team, MatchPhase,
} from '../types.js';

const MM = 1000;
const T = WORLD.TROOPERS;

function statsOf(kind: TrooperKind): typeof WORLD.TROOPERS.LINE | typeof WORLD.TROOPERS.LANCER | typeof WORLD.TROOPERS.SIEGER {
  return kind === TrooperKind.Line ? T.LINE : kind === TrooperKind.Lancer ? T.LANCER : T.SIEGER;
}

export function trooperSpeed(kind: TrooperKind): number {
  return kind === TrooperKind.Sieger ? T.SIEGER.MOVE_SPEED_MPS : T.MOVE_SPEED_MPS;
}

const KIND_BY_NAME: Record<string, TrooperKind> = {
  LINE: TrooperKind.Line, LANCER: TrooperKind.Lancer, SIEGER: TrooperKind.Sieger,
};

export function spawnWave(s: WorldState, spawns: { [team: number]: { x: number; z: number } }): void {
  const isSiege = (s.waveIndex + 1) % T.SIEGE_WAVE_EVERY === 0;
  const comp = isSiege ? T.COMPOSITION_SIEGE : T.COMPOSITION_NORMAL;
  const scale = waveScale(s.waveIndex);

  for (const team of [Team.A, Team.B]) {
    const sp = spawns[team]!;
    for (let i = 0; i < comp.length; i++) {
      const kind = KIND_BY_NAME[comp[i]!]!;
      const hp = Math.round(statsOf(kind).HP * scale) * SPINE.DAMAGE_SCALE;
      // Fixed lateral offsets, never randomised: a wave must look the same
      // every time or the player cannot learn where to stand.
      const lateral = [-1.6, -0.6, 0.6, 1.6][i] ?? 0;
      s.troopers.push({
        id: s.nextEntityId++,
        team,
        kind,
        alive: true,
        px: Math.round(sp.x * MM),
        py: 0,
        pz: Math.round((sp.z + lateral) * MM),
        hp,
        maxHp: hp,
        waveIndex: s.waveIndex,
        targetId: -1,
        targetDwell: 0,
        attackCooldown: 0,
        retargetIn: i * 3, // stagger so a wave does not retarget in lockstep
        retaliateUntil: -1,
        retaliateTarget: -1,
      });
    }
  }
  s.waveIndex++;
  s.nextWaveTick = s.tick + T.WAVE_INTERVAL_TICKS;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = (ax - bx) / MM;
  const dz = (az - bz) / MM;
  return dx * dx + dz * dz;
}

/**
 * Priority, top-down (WORLD.TROOPERS):
 *   1. enemy hero who damaged an allied HERO recently, in range
 *   2. nearest enemy trooper in range
 *   3. nearest enemy hero in range
 *   4. enemy structure in range
 *   5. march
 */
function retarget(s: WorldState, t: TrooperState): void {
  const st = statsOf(t.kind);
  const aggro2 = st.AGGRO_RADIUS_M * st.AGGRO_RADIUS_M;

  if (t.retaliateUntil > s.tick && t.retaliateTarget >= 0) {
    const h = s.heroes.find((x) => x.id === t.retaliateTarget && x.alive);
    if (h !== undefined && dist2(t.px, t.pz, h.px, h.pz) <= aggro2) {
      t.targetId = h.id;
      return;
    }
  }

  let best = -1;
  let bestD = aggro2;
  for (const o of s.troopers) {
    if (!o.alive || o.team === t.team) continue;
    const d = dist2(t.px, t.pz, o.px, o.pz);
    if (d < bestD) { bestD = d; best = o.id; }
  }
  if (best >= 0) { t.targetId = best; return; }

  bestD = aggro2;
  for (const h of s.heroes) {
    if (!h.alive || h.team === t.team) continue;
    const d = dist2(t.px, t.pz, h.px, h.pz);
    if (d < bestD) { bestD = d; best = h.id; }
  }
  if (best >= 0) { t.targetId = best; return; }

  bestD = aggro2;
  for (const st2 of s.structures) {
    if (!st2.alive || st2.team === t.team) continue;
    const d = dist2(t.px, t.pz, st2.px, st2.pz);
    if (d < bestD) { bestD = d; best = st2.id; }
  }
  t.targetId = best;
}

function findPos(s: WorldState, id: number): { px: number; pz: number } | null {
  for (const h of s.heroes) if (h.id === id && h.alive) return h;
  for (const t of s.troopers) if (t.id === id && t.alive) return t;
  for (const st of s.structures) if (st.id === id && st.alive) return st;
  return null;
}

export function stepTroopers(
  s: WorldState,
  spawns: { [team: number]: { x: number; z: number } },
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team) => void,
): void {
  if (s.phase === MatchPhase.Over) return;

  if (s.tick >= s.nextWaveTick) spawnWave(s, spawns);

  const scale = 1; // per-wave scaling is baked into HP and structure damage at spawn

  for (let i = 0; i < s.troopers.length; i++) {
    const t = s.troopers[i]!;
    if (!t.alive) continue;

    const st = statsOf(t.kind);
    const march = t.team === Team.A ? 1 : -1;
    const marchMult = s.teams[t.team]!.marchTicksLeft > 0 ? WORLD.MARCH.TROOPER_MOVE_SPEED_MPS / T.MOVE_SPEED_MPS : 1;

    if (t.attackCooldown > 0) t.attackCooldown--;
    if (t.targetDwell > 0) t.targetDwell--;
    if (t.retargetIn > 0) {
      t.retargetIn--;
    } else {
      t.retargetIn = T.RETARGET_INTERVAL_TICKS;
      if (t.targetDwell <= 0) {
        retarget(s, t);
        t.targetDwell = T.TARGET_MIN_DWELL_TICKS;
      }
    }

    const target = t.targetId >= 0 ? findPos(s, t.targetId) : null;
    if (target === null) {
      t.targetId = -1;
    } else {
      const d = Math.sqrt(dist2(t.px, t.pz, target.px, target.pz));
      if (d <= st.RANGE_M) {
        // STOP_TO_FIRE: a wave that walks and shoots has no readable rhythm.
        if (t.attackCooldown === 0) {
          t.attackCooldown = st.ATTACK_INTERVAL_TICKS;
          const isHero = s.heroes.some((h) => h.id === t.targetId);
          const isStruct = s.structures.some((x) => x.id === t.targetId);
          let dmg: number = isHero ? st.DMG_VS_HERO : isStruct ? st.DMG_VS_STRUCTURE : st.DMG_VS_TROOPER;
          if (isStruct) {
            dmg = Math.round(dmg * waveScale(t.waveIndex));
            if (s.teams[t.team]!.marchTicksLeft > 0) dmg = Math.round(dmg * WORLD.MARCH.TROOPER_STRUCT_DMG_MULT);
          }
          applyDamage(t.targetId, dmg * SPINE.DAMAGE_SCALE * scale, t.team);
        }
        continue; // holding position to fire
      }
    }

    // March, or close on the target.
    const speed = trooperSpeed(t.kind) * marchMult;
    const step = Math.round(speed * SPINE.TICK_S * MM);
    if (target !== null) {
      const dx = target.px - t.px;
      const dz = target.pz - t.pz;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1) {
        t.px += Math.round((dx / len) * step);
        t.pz += Math.round((dz / len) * step);
      }
    } else {
      t.px += march * step;
      // Drift back to the lane centreline so a wave re-forms after a fight.
      const laneZ = Math.round(T.PATH_Z_M * MM);
      if (t.pz > laneZ + 100) t.pz -= Math.min(step, t.pz - laneZ);
      else if (t.pz < laneZ - 100) t.pz += Math.min(step, laneZ - t.pz);
    }
  }

  // Compact the dead out once they have no further effect. Fixed order.
  if (s.troopers.length > 96) {
    s.troopers = s.troopers.filter((t) => t.alive);
  }
}

/** Called by combat when a hero damages an allied hero near a wave. */
export function markRetaliation(s: WorldState, victim: HeroState, attackerId: number): void {
  for (const t of s.troopers) {
    if (!t.alive || t.team !== victim.team) continue;
    if (dist2(t.px, t.pz, victim.px, victim.pz) > 900) continue; // 30m
    t.retaliateUntil = s.tick + T.RETALIATE_WINDOW_TICKS;
    t.retaliateTarget = attackerId;
  }
}

export function structureOf(s: WorldState, id: number): StructureState | undefined {
  return s.structures.find((x) => x.id === id);
}
