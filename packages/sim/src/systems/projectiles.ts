/**
 * projectiles — RIFT's LOBBER, and the reason collision.ts carries swept tests.
 *
 * PRD §10.1 enumerated the physics primitives as "capsule collide-and-slide,
 * raycasts, sphere overlaps. That's it." Swept tests were the omission, and
 * this is where it bites: at 45 m/s a projectile advances 0.75m per tick at
 * 60Hz against a ~0.80m-wide hero capsule, so a discrete per-tick position
 * check lets rockets pass cleanly through people. At the PRD's original 30Hz
 * it was 1.5m per tick — roughly two body widths of tunnelling per step.
 *
 * So every projectile moves as a SWEPT segment, and the segment is what gets
 * traced. The trace reuses `traceRay`, which means a projectile hits exactly
 * the same things a bullet does, in the same fixed order — one code path, one
 * set of edge cases.
 */

import { SPINE, COMBAT, WORLD } from '../balance.js';
import {
  type WorldState, type ProjectileState,
  Team, MatchPhase,
} from '../types.js';
import { type Aabb } from '../collision.js';
import { traceRay, weaponOf } from './combat.js';

const MM = 1000;

export function stepProjectiles(
  s: WorldState,
  boxes: readonly Aabb[],
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team, attackerId?: number) => void,
): void {
  if (s.phase === MatchPhase.Over) return;

  for (let i = 0; i < s.projectiles.length; i++) {
    const p = s.projectiles[i]!;
    if (!p.alive) continue;

    p.ticksLeft--;
    if (p.ticksLeft <= 0) { p.alive = false; continue; }

    const W = weaponOf(p.kind) as unknown as typeof COMBAT.LAUNCHER;
    const owner = s.heroes.find((h) => h.id === p.ownerId);

    // Integrate, then trace the SEGMENT just travelled rather than testing the
    // new position. This is the whole point.
    const dx = (p.vx / MM) * SPINE.TICK_S;
    const dy = (p.vy / MM) * SPINE.TICK_S + (W.PROJECTILE_GRAVITY_MPS2 * SPINE.TICK_S * SPINE.TICK_S) / 2;
    const dz = (p.vz / MM) * SPINE.TICK_S;
    const step = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (step > 1e-6 && owner !== undefined) {
      const ox = p.px / MM, oy = p.py / MM, oz = p.pz / MM;
      const hit = traceRay(s, owner, ox, oy, oz, dx / step, dy / step, dz / step, boxes);
      if (hit !== null && hit.t <= step + W.PROJECTILE_RADIUS_M) {
        detonate(s, p, hit.x, hit.y, hit.z, hit.kind === 'geometry' ? -1 : hit.id, applyDamage);
        continue;
      }
    }

    p.px += Math.round(dx * MM);
    p.py += Math.round(dy * MM);
    p.pz += Math.round(dz * MM);
    if (W.PROJECTILE_GRAVITY_MPS2 !== 0) {
      p.vy += Math.round(W.PROJECTILE_GRAVITY_MPS2 * SPINE.TICK_S * MM);
    }
  }

  if (s.projectiles.length > 48) s.projectiles = s.projectiles.filter((p) => p.alive);
}

function detonate(
  s: WorldState,
  p: ProjectileState,
  x: number, y: number, z: number,
  directId: number,
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team, attackerId?: number) => void,
): void {
  p.alive = false;
  const W = weaponOf(p.kind) as unknown as typeof COMBAT.LAUNCHER;
  const owner = s.heroes.find((h) => h.id === p.ownerId);

  s.events.push({
    tick: s.tick, shooterId: p.ownerId, targetId: directId,
    x, y, z, nx: 0, ny: 1, nz: 0,
    damage: 0, headshot: false, killed: false, geometry: directId < 0,
  });

  // --- direct hit ---------------------------------------------------------
  if (directId >= 0) {
    const isStructure = s.structures.some((st) => st.id === directId);
    let dmg = W.DAMAGE * SPINE.DAMAGE_SCALE;
    if (isStructure) dmg = Math.trunc(dmg * W.STRUCTURE_DAMAGE_MULT);
    applyDamage(directId, dmg, p.team, p.ownerId);
    if (owner !== undefined) { owner.hitsLanded++; owner.damageDealt += dmg; }
  }

  // --- splash -------------------------------------------------------------
  // Linear falloff from centre to edge. The direct target is EXCLUDED: a direct
  // hit takes 210, not 210+90, or the LOBBER's TTK collapses out of band.
  const r = W.SPLASH_RADIUS_M;
  const r2 = r * r;
  for (const h of s.heroes) {
    if (!h.alive || h.team === p.team) continue;
    if (W.SPLASH_EXCLUDES_DIRECT_TARGET && h.id === directId) continue;
    const ex = h.px / MM - x, ey = h.py / MM + 0.9 - y, ez = h.pz / MM - z;
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 > r2) continue;
    const t = Math.sqrt(d2) / r;
    const dmg = Math.round(W.SPLASH_DAMAGE_CENTER + (W.SPLASH_DAMAGE_EDGE - W.SPLASH_DAMAGE_CENTER) * t);
    applyDamage(h.id, dmg * SPINE.DAMAGE_SCALE, p.team, p.ownerId);
  }
  for (const t of s.troopers) {
    if (!t.alive || t.team === p.team) continue;
    const ex = t.px / MM - x, ey = t.py / MM + 0.8 - y, ez = t.pz / MM - z;
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 > r2) continue;
    const f = Math.sqrt(d2) / r;
    const dmg = Math.round(W.SPLASH_DAMAGE_CENTER + (W.SPLASH_DAMAGE_EDGE - W.SPLASH_DAMAGE_CENTER) * f);
    applyDamage(t.id, dmg * SPINE.DAMAGE_SCALE, p.team, p.ownerId);
  }

  // Splash never touches soul orbs. 3m splash from 40m with zero aim would
  // delete §7.1's mini-duel, and the orb budget does not depend on it while
  // Pillar P2 does.
  void WORLD;
}
