/**
 * combat — firing, spread, recoil, falloff, damage.
 *
 * DAMAGE PIPELINE (PRD §6, settled — do not reorder):
 *   final = BASE × FALLOFF × HEADSHOT × (1 + Σ additive % bonuses)
 *
 * Bullets originate at the MUZZLE in world space, never at the camera
 * (§5.3 fix 3). That is what stops third-person from shooting around corners
 * the character cannot see past: if your reticle is on a wall from the
 * character's perspective, you shoot the wall.
 */

import { COMBAT, ENTITY, CAMERA, SPINE, ECONOMY, WORLD } from '../balance.js';
import { sin, cos, clamp, PI } from '../mathd.js';
import { rngFor, RNG_STREAM } from '../rng.js';
import {
  type HeroState, type PlayerInput, type WorldState,
  MoveState, CameraMode, Btn, Team, StructureKind, HeroKind,
} from '../types.js';
import { type Aabb, rayVsBox, rayVsBoxes, rayVsCapsule, rayVsSphere } from '../collision.js';
import { aimDir } from './movement.js';
import { damageOrb } from './economy.js';

const DT = SPINE.TICK_S;
const MM = 1000;
const DEG = PI / 180;
/**
 * §6.3: each hero has ONE weapon and no swapping — weapon identity IS hero
 * identity. The fiction is the tone in DIRECTION.md §0 (these spray paint,
 * foam and water rather than bullets); the numbers are the PRD's, reconciled.
 */
export const WEAPON_OF: Record<number, typeof COMBAT.SMG | typeof COMBAT.RIFLE | typeof COMBAT.SHOTGUN | typeof COMBAT.LAUNCHER> = {
  [HeroKind.Volt]: COMBAT.SMG,
  [HeroKind.Halo]: COMBAT.RIFLE,
  [HeroKind.Bulwark]: COMBAT.SHOTGUN,
  [HeroKind.Rift]: COMBAT.LAUNCHER,
};

export const WEAPON_NAME: Record<number, string> = {
  [HeroKind.Volt]: 'SPRAYER',
  [HeroKind.Halo]: 'PINPOINT',
  [HeroKind.Bulwark]: 'SCATTER',
  [HeroKind.Rift]: 'LOBBER',
};

export const HERO_NAME: Record<number, string> = {
  [HeroKind.Volt]: 'VOLT',
  [HeroKind.Halo]: 'HALO',
  [HeroKind.Bulwark]: 'BULWARK',
  [HeroKind.Rift]: 'RIFT',
};

export function weaponOf(kind: number): typeof COMBAT.SMG {
  return (WEAPON_OF[kind] ?? COMBAT.SMG) as typeof COMBAT.SMG;
}

const MAX_RANGE_M = 200;

function pressed(input: PlayerInput, prev: number, bit: Btn): boolean {
  return (input.buttons & bit) !== 0 && (prev & bit) === 0;
}

/** Current spread cone half-angle in degrees, before the RNG sample. */
export function currentSpreadDeg(h: HeroState): number {
  const W = weaponOf(h.kind);
  const adsFrac = h.adsTicks / CAMERA.ADS_ENTER_TICKS;
  const inFps = h.camera === CameraMode.FPS;
  const canAds = inFps && COMBAT.ADS_AVAILABLE_IN_TPS === false;

  let base = W.BASE_SPREAD_DEG;
  if (canAds && adsFrac > 0) {
    base = W.BASE_SPREAD_DEG + (W.ADS_SPREAD_DEG - W.BASE_SPREAD_DEG) * adsFrac;
  }

  // §5.1 — 1.0 by default. The mobility/precision axis lives in ADS speed and
  // FOV, not in a flat TPS accuracy tax.
  if (h.camera === CameraMode.TPS) base *= CAMERA.TPS_HIPFIRE_SPREAD_MULT;

  const speed = Math.sqrt((h.vx / MM) * (h.vx / MM) + (h.vz / MM) * (h.vz / MM));
  const moveFrac = clamp(speed / COMBAT.SPREAD_MOVE_SPEED_REF_MPS, 0, 1);

  let envMult: number;
  if (!h.grounded || h.moveState === MoveState.Dash) {
    envMult = W.SPREAD_AIR_MULT;
  } else {
    envMult = 1 + (W.SPREAD_MOVE_MULT - 1) * moveFrac;
  }

  const bloom = h.spreadMilliDeg / 1000;
  return Math.min(base * envMult + bloom, W.SPREAD_MAX_DEG * envMult);
}

export function falloffMult(distance: number, kind = HeroKind.Volt): number {
  const W = weaponOf(kind);
  if (distance <= W.FALLOFF_START_M) return 1;
  if (distance >= W.FALLOFF_END_M) return W.FALLOFF_END_MULT;
  const t = (distance - W.FALLOFF_START_M) / (W.FALLOFF_END_M - W.FALLOFF_START_M);
  return 1 + (W.FALLOFF_END_MULT - 1) * t;
}

/** Is the muzzle→reticle ray blocked? Drives the dim-red reticle in §5.3. */
export function muzzleBlocked(
  h: HeroState,
  boxes: readonly Aabb[],
): boolean {
  const [dx, , dz] = aimDir(h.yaw, h.pitch);
  const ex = h.px / MM;
  const ey = h.py / MM + ENTITY.EYE_HEIGHT_M;
  const ez = h.pz / MM;
  const mx = ex + dx * ENTITY.MUZZLE_FORWARD_M;
  const my = h.py / MM + ENTITY.MUZZLE_HEIGHT_M;
  const mz = ez + dz * ENTITY.MUZZLE_FORWARD_M;
  const seg = Math.sqrt((mx - ex) * (mx - ex) + (my - ey) * (my - ey) + (mz - ez) * (mz - ez));
  if (seg < 1e-6) return false;
  const h2 = rayVsBoxes(ex, ey, ez, (mx - ex) / seg, (my - ey) / seg, (mz - ez) / seg, seg, boxes);
  return h2.hit;
}

export function stepCombat(
  h: HeroState,
  input: PlayerInput,
  prevButtons: number,
  tick: number,
  matchSeed: number,
  s: WorldState,
  boxes: readonly Aabb[],
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team, attackerId?: number) => void,
): void {
  const events = s.events;
  const W = weaponOf(h.kind);
  // ---- timers ------------------------------------------------------------
  if (h.fireCooldownTicks > 0) h.fireCooldownTicks--;
  if (h.postReloadLockout > 0) h.postReloadLockout--;
  if (h.meleeCooldownTicks > 0) h.meleeCooldownTicks--;
  if (h.meleeTicksLeft > 0) h.meleeTicksLeft--;

  // ---- spread and recoil decay -------------------------------------------
  if (h.spreadDecayDelay > 0) {
    h.spreadDecayDelay--;
  } else if (h.spreadMilliDeg > 0) {
    h.spreadMilliDeg = Math.max(0, h.spreadMilliDeg - Math.round(W.SPREAD_DECAY_DEG_PER_S * 1000 * DT));
  }
  if (h.recoilRecoveryDelay > 0) {
    h.recoilRecoveryDelay--;
  } else {
    const rec = Math.round(W.RECOIL_RECOVERY_DEG_PER_S * 1000 * DT);
    if (h.recoilVertMilliDeg > 0) h.recoilVertMilliDeg = Math.max(0, h.recoilVertMilliDeg - rec);
    if (h.recoilHorizMilliDeg > 0) h.recoilHorizMilliDeg = Math.max(0, h.recoilHorizMilliDeg - rec);
    if (h.recoilHorizMilliDeg < 0) h.recoilHorizMilliDeg = Math.min(0, h.recoilHorizMilliDeg + rec);
  }

  // ---- reload ------------------------------------------------------------
  if (h.reloadTicksLeft > 0) {
    const cancel =
      (COMBAT.RELOAD_CANCEL_ON_DASH && h.moveState === MoveState.Dash) ||
      (COMBAT.RELOAD_CANCEL_ON_ABILITY && (input.buttons & (Btn.AbilityQ | Btn.AbilityE | Btn.AbilityR)) !== 0);
    if (cancel) {
      // §6.3 "a real decision": a cancelled reload yields ZERO ammo and
      // restarts from tick 0. Partial credit would remove the decision.
      h.reloadTicksLeft = 0;
    } else {
      h.reloadTicksLeft--;
      if (h.reloadTicksLeft === 0) {
        h.ammo = W.MAG_SIZE;
        h.postReloadLockout = COMBAT.POST_RELOAD_LOCKOUT_TICKS;
      }
      return;
    }
  }

  const wantsReload = pressed(input, prevButtons, Btn.Reload);
  const dryAndFiring = h.ammo === 0 && (input.buttons & Btn.Fire) !== 0;
  if ((wantsReload || dryAndFiring) && h.ammo < W.MAG_SIZE && h.moveState !== MoveState.Mantle) {
    h.reloadTicksLeft = W.RELOAD_TICKS + (h.ammo === 0 ? COMBAT.RELOAD_EMPTY_PENALTY_TICKS : 0);
    return;
  }

  // ---- melee -------------------------------------------------------------
  if (pressed(input, prevButtons, Btn.Melee) && h.meleeCooldownTicks === 0) {
    h.meleeTicksLeft = COMBAT.MELEE.TOTAL_TICKS;
    h.meleeCooldownTicks = COMBAT.MELEE.COOLDOWN_TICKS;
  }

  // ---- fire --------------------------------------------------------------
  const fireHeld = (input.buttons & Btn.Fire) !== 0;
  const wantsFire = W.AUTO ? fireHeld : pressed(input, prevButtons, Btn.Fire);
  const canFire =
    wantsFire &&
    h.ammo > 0 &&
    h.fireCooldownTicks === 0 &&
    h.postReloadLockout === 0 &&
    h.moveState !== MoveState.Mantle &&
    h.moveState !== MoveState.Zipline;

  if (!canFire) return;

  h.ammo--;
  h.fireCooldownTicks = W.FIRE_INTERVAL_TICKS;
  h.shotsFired++;

  // RNG draw contract: exactly one u32 from RECOIL, then one from PELLET.
  // A rejected shot draws NOTHING — which is why this sits after every guard.
  const rRecoil = rngFor(matchSeed, tick, h.id, RNG_STREAM.RECOIL);
  const rPellet = rngFor(matchSeed, tick, h.id, RNG_STREAM.PELLET);

  const horizKick = rRecoil.signed() * W.RECOIL_HORIZONTAL_DEG;
  h.recoilVertMilliDeg = Math.min(
    Math.round(W.RECOIL_ACCUM_MAX_DEG * 1000),
    h.recoilVertMilliDeg + Math.round(W.RECOIL_VERTICAL_DEG * 1000),
  );
  h.recoilHorizMilliDeg = clamp(
    h.recoilHorizMilliDeg + Math.round(horizKick * 1000),
    -Math.round(W.RECOIL_ACCUM_MAX_DEG * 1000),
    Math.round(W.RECOIL_ACCUM_MAX_DEG * 1000),
  );
  h.recoilRecoveryDelay = W.RECOIL_RECOVERY_DELAY_TICKS;

  h.spreadMilliDeg = Math.min(
    Math.round(W.SPREAD_MAX_DEG * 1000),
    h.spreadMilliDeg + Math.round(W.SPREAD_PER_SHOT_DEG * 1000),
  );
  h.spreadDecayDelay = W.SPREAD_DECAY_DELAY_TICKS;

  // ---- build the shot ------------------------------------------------------
  const [ax, ay, az] = aimDir(h.yaw, h.pitch);

  // Muzzle in world space (S5.3 fix 3), NOT the camera. This is what stops
  // third-person shooting around corners the character cannot see past.
  const mx = h.px / MM + ax * ENTITY.MUZZLE_FORWARD_M;
  const my = h.py / MM + ENTITY.MUZZLE_HEIGHT_M;
  const mz = h.pz / MM + az * ENTITY.MUZZLE_FORWARD_M;

  /**
   * RIFT's LOBBER is a projectile, not hitscan - and at 45 m/s it advances
   * 0.75m per tick against a ~0.80m capsule, which is why collision.ts carries
   * swept tests. A discrete per-tick position check lets it pass through people.
   */
  if (!W.HITSCAN) {
    const cone = currentSpreadDeg(h) * DEG;
    const [dx, dy, dz] = coneSample(ax, ay, az, cone, rPellet);
    const launcher = W as unknown as typeof COMBAT.LAUNCHER;
    const sp = launcher.PROJECTILE_SPEED_MPS;
    s.projectiles.push({
      id: s.nextEntityId++,
      ownerId: h.id, team: h.team, kind: h.kind,
      px: Math.round(mx * MM), py: Math.round(my * MM), pz: Math.round(mz * MM),
      vx: Math.round(dx * sp * MM), vy: Math.round(dy * sp * MM), vz: Math.round(dz * sp * MM),
      ticksLeft: launcher.PROJECTILE_LIFETIME_TICKS,
      alive: true,
    });
    return;
  }

  // Hitscan. One ray, or eight for BULWARK - pellets each resolve against a
  // single target, so one blast cannot claim eight soul orbs at once.
  const pellets = W.PELLET_COUNT;
  let headshotsThisShot = 0;
  for (let p = 0; p < pellets; p++) {
    const cone = currentSpreadDeg(h) * DEG;
    const [dx, dy, dz] = coneSample(ax, ay, az, cone, rPellet);
    const hit = traceRay(s, h, mx, my, mz, dx, dy, dz, boxes);
    if (hit === null) continue;

    if (hit.kind === 'geometry') {
      // Only report one geometry impact per trigger pull: eight identical
      // sparks on a wall reads as a rendering bug, not as a shotgun.
      if (p === 0) {
        events.push({
          tick, shooterId: h.id, targetId: -1,
          x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
          damage: 0, headshot: false, killed: false, geometry: true,
        });
      }
      continue;
    }

    const falloff = falloffMult(hit.t, h.kind);

    if (hit.kind === 'orb') {
      const orb = s.orbs.find((o) => o.id === hit.id);
      if (orb !== undefined) {
        const done = damageOrb(s, orb, h, orbDamageFor(h.kind), ECONOMY.ORB_DAMAGE_APPLIES_FALLOFF ? falloff : 1);
        events.push({
          tick, shooterId: h.id, targetId: hit.id,
          x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
          damage: 0, headshot: false, killed: done, geometry: false,
        });
      }
      continue;
    }

    const base = W.DAMAGE * SPINE.DAMAGE_SCALE;

    if (hit.kind === 'structure') {
      const dmgS = Math.max(
        COMBAT.MIN_DAMAGE_MILLI,
        Math.trunc(base * (COMBAT.FALLOFF_APPLIES_TO_STRUCTURES ? falloff : 1) * W.STRUCTURE_DAMAGE_MULT),
      );
      h.hitsLanded++;
      h.damageDealt += dmgS;
      const beforeS = hpOf(s, hit.id);
      applyDamage(hit.id, dmgS, h.team, h.id);
      events.push({
        tick, shooterId: h.id, targetId: hit.id,
        x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
        damage: dmgS, headshot: false,
        killed: beforeS > 0 && hpOf(s, hit.id) <= 0, geometry: false,
      });
      continue;
    }

    // S6.2's x1.5, EXCEPT shotgun-class pellet weapons: at x1.5 per pellet a
    // full head blast two-shots both 550 and 700 HP for a 0.667s TTK, exactly
    // the CoD-class TTK S6.1 rejects. At most one pellet gets it, and at x1.25.
    let mult = 1;
    if (hit.headshot) {
      if (pellets > 1) {
        const sg = W as unknown as typeof COMBAT.SHOTGUN;
        if (headshotsThisShot < sg.HEADSHOT_PELLET_CAP) {
          mult = sg.HEADSHOT_MULT_OVERRIDE;
          headshotsThisShot++;
        }
      } else {
        mult = COMBAT.HEADSHOT_MULT_HITSCAN;
      }
    }

    const dmg = Math.max(COMBAT.MIN_DAMAGE_MILLI, Math.trunc(Math.trunc(base * falloff) * mult));
    h.hitsLanded++;
    h.damageDealt += dmg;
    if (hit.headshot && mult > 1) h.headshots++;

    const before = hpOf(s, hit.id);
    applyDamage(hit.id, dmg, h.team, h.id);
    events.push({
      tick, shooterId: h.id, targetId: hit.id,
      x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
      damage: dmg, headshot: hit.headshot && mult > 1,
      killed: before > 0 && hpOf(s, hit.id) <= 0, geometry: false,
    });
  }
}

/** Per-weapon orb damage. Flat by design: no headshot, no item bonuses. */
function orbDamageFor(kind: number): number {
  switch (kind) {
    case HeroKind.Halo: return ECONOMY.ORB_DAMAGE_RIFLE;
    case HeroKind.Bulwark: return ECONOMY.ORB_DAMAGE_SHOTGUN_PER_PELLET;
    case HeroKind.Rift: return ECONOMY.ORB_DAMAGE_LAUNCHER_DIRECT;
    default: return ECONOMY.ORB_DAMAGE_SMG;
  }
}

/**
 * Uniform sample inside a cone. sqrt for area-uniformity, or shots cluster at
 * the centre and the cone reads tighter than the number says it is.
 */
function coneSample(
  ax: number, ay: number, az: number, cone: number,
  rng: { unit(): number },
): [number, number, number] {
  let ux = 0, uy = 1, uz = 0;
  if (ay > 0.99 || ay < -0.99) { ux = 1; uy = 0; uz = 0; }
  let rx = ay * uz - az * uy;
  let ry = az * ux - ax * uz;
  let rz = ax * uy - ay * ux;
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rl; ry /= rl; rz /= rl;
  const bx = ry * az - rz * ay;
  const by = rz * ax - rx * az;
  const bz = rx * ay - ry * ax;

  const theta = rng.unit() * 2 * PI;
  const radial = Math.sqrt(rng.unit()) * (sin(cone) / cos(cone));
  const ox = cos(theta) * radial;
  const oy = sin(theta) * radial;

  const dx = ax + rx * ox + bx * oy;
  const dy = ay + ry * ox + by * oy;
  const dz = az + rz * ox + bz * oy;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [dx / dl, dy / dl, dz / dl];
}

export interface ShotHit {
  kind: 'hero' | 'trooper' | 'orb' | 'target' | 'structure' | 'geometry';
  id: number;
  t: number;
  headshot: boolean;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

/** One ray against the whole world, in a fixed evaluation order. */
export function traceRay(
  s: WorldState,
  shooter: HeroState,
  mx: number, my: number, mz: number,
  dx: number, dy: number, dz: number,
  boxes: readonly Aabb[],
): ShotHit | null {
  const geo = rayVsBoxes(mx, my, mz, dx, dy, dz, MAX_RANGE_M, boxes);
  let best: ShotHit | null = geo.hit
    ? { kind: 'geometry', id: -1, t: geo.t, headshot: false, x: geo.x, y: geo.y, z: geo.z, nx: geo.nx, ny: geo.ny, nz: geo.nz }
    : null;
  let bestT = geo.hit ? geo.t : MAX_RANGE_M;

  const capsule = (
    id: number, kind: 'hero' | 'trooper' | 'target',
    px: number, py: number, pz: number,
    radius: number, height: number, headR: number, headY: number, heads: boolean,
  ): void => {
    const tx = px / MM, ty = py / MM, tz = pz / MM;
    if (heads) {
      const hd = rayVsSphere(mx, my, mz, dx, dy, dz, bestT, tx, ty + headY, tz, headR);
      if (hd.hit && hd.t < bestT) {
        bestT = hd.t;
        best = { kind, id, t: hd.t, headshot: true, x: hd.x, y: hd.y, z: hd.z, nx: hd.nx, ny: hd.ny, nz: hd.nz };
        return;
      }
    }
    const bd = rayVsCapsule(mx, my, mz, dx, dy, dz, bestT, tx, ty, tz, radius, height);
    if (bd.hit && bd.t < bestT) {
      bestT = bd.t;
      best = { kind, id, t: bd.t, headshot: false, x: bd.x, y: bd.y, z: bd.z, nx: bd.nx, ny: bd.ny, nz: bd.nz };
    }
  };

  for (const o of s.heroes) {
    if (!o.alive || o.id === shooter.id || o.team === shooter.team) continue;
    capsule(o.id, 'hero', o.px, o.py, o.pz,
      ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M,
      ENTITY.HEAD_SPHERE_RADIUS_M, ENTITY.HEAD_SPHERE_CENTER_M, true);
  }
  const TR = WORLD.TROOPERS;
  for (const t of s.troopers) {
    if (!t.alive) continue; // friendly troopers block bullets too - mobile cover
    capsule(t.id, 'trooper', t.px, t.py, t.pz,
      TR.HITBOX_RADIUS_M, TR.HITBOX_HEIGHT_M,
      TR.HEAD_SPHERE_RADIUS_M, TR.HEAD_SPHERE_CENTER_Y_M, TR.HEADSHOTS_ENABLED);
  }
  for (const o of s.orbs) {
    if (!o.alive || o.armTicksLeft > 0) continue;
    const sp = rayVsSphere(mx, my, mz, dx, dy, dz, bestT, o.px / MM, o.py / MM, o.pz / MM, ECONOMY.ORB_HITBOX_RADIUS_M);
    if (sp.hit && sp.t < bestT) {
      bestT = sp.t;
      best = { kind: 'orb', id: o.id, t: sp.t, headshot: false, x: sp.x, y: sp.y, z: sp.z, nx: sp.nx, ny: sp.ny, nz: sp.nz };
    }
  }
  for (const t of s.targets) {
    if (!t.alive) continue;
    capsule(t.id, 'target', t.px, t.py, t.pz,
      ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M,
      ENTITY.HEAD_SPHERE_RADIUS_M, ENTITY.HEAD_SPHERE_CENTER_M, true);
  }
  // Structures are also world geometry, so this must tie-break in their favour
  // at the same surface - otherwise a shot at a tower is a wall hit for zero.
  for (const st of s.structures) {
    if (!st.alive || st.team === shooter.team) continue;
    const dim = st.kind === StructureKind.Core
      ? WORLD.STRUCTURES.CORE_COLLIDER_M : WORLD.STRUCTURES.TOWER_COLLIDER_M;
    const cx = st.px / MM, cz = st.pz / MM;
    const hit = rayVsBox(mx, my, mz, dx, dy, dz, bestT, {
      minX: cx - dim[0]! / 2, minY: 0, minZ: cz - dim[2]! / 2,
      maxX: cx + dim[0]! / 2, maxY: dim[1]!, maxZ: cz + dim[2]! / 2,
    });
    if (hit.hit && hit.t <= bestT) {
      bestT = hit.t;
      best = { kind: 'structure', id: st.id, t: hit.t, headshot: false, x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz };
    }
  }

  return best;
}

function hpOf(s: WorldState, id: number): number {
  for (const h of s.heroes) if (h.id === id) return h.hp;
  for (const t of s.troopers) if (t.id === id) return t.hp;
  for (const st of s.structures) if (st.id === id) return st.hp;
  for (const t of s.targets) if (t.id === id) return t.hp;
  return 0;
}
