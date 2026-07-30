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
  MoveState, CameraMode, Btn, Team, StructureKind,
} from '../types.js';
import { type Aabb, rayVsBox, rayVsBoxes, rayVsCapsule, rayVsSphere } from '../collision.js';
import { aimDir } from './movement.js';
import { damageOrb } from './economy.js';

const DT = SPINE.TICK_S;
const MM = 1000;
const DEG = PI / 180;
const W = COMBAT.SMG; // M0 ships one weapon

const MAX_RANGE_M = 200;

function pressed(input: PlayerInput, prev: number, bit: Btn): boolean {
  return (input.buttons & bit) !== 0 && (prev & bit) === 0;
}

/** Current spread cone half-angle in degrees, before the RNG sample. */
export function currentSpreadDeg(h: HeroState): number {
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

export function falloffMult(distance: number): number {
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

  // ---- build the shot ray ------------------------------------------------
  const cone = currentSpreadDeg(h) * DEG;
  const [ax, ay, az] = aimDir(h.yaw, h.pitch);

  // Orthonormal basis around the aim vector. Picking the "up" reference by
  // magnitude avoids the degenerate case when looking straight up or down.
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

  // Uniform sample inside the cone disc: sqrt for area-uniformity, or shots
  // cluster at the centre and the cone reads tighter than its number.
  const u1 = rPellet.unit();
  const u2 = rPellet.unit();
  const theta = u1 * 2 * PI;
  const radial = Math.sqrt(u2) * (sin(cone) / cos(cone));
  const ox2 = cos(theta) * radial;
  const oy2 = sin(theta) * radial;

  let dx = ax + rx * ox2 + bx * oy2;
  let dy = ay + ry * ox2 + by * oy2;
  let dz = az + rz * ox2 + bz * oy2;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx /= dl; dy /= dl; dz /= dl;

  // Muzzle in world space (§5.3 fix 3), NOT the camera.
  const mx = h.px / MM + ax * ENTITY.MUZZLE_FORWARD_M;
  const my = h.py / MM + ENTITY.MUZZLE_HEIGHT_M;
  const mz = h.pz / MM + az * ENTITY.MUZZLE_FORWARD_M;

  // ---- trace -------------------------------------------------------------
  // Geometry first, so it caps the ray. Everything else must beat that t.
  const geo = rayVsBoxes(mx, my, mz, dx, dy, dz, MAX_RANGE_M, boxes);
  let bestT = geo.hit ? geo.t : MAX_RANGE_M;
  let hitId = -1;
  let hitKind: 'hero' | 'trooper' | 'orb' | 'target' | 'structure' | null = null;
  let headshot = false;
  let hx = 0, hy = 0, hz = 0, nx = 0, ny = 0, nz = 0;

  const capsuleTest = (
    id: number, kind: 'hero' | 'trooper' | 'target',
    px: number, py: number, pz: number,
    radius: number, height: number, headR: number, headY: number,
    headsEnabled: boolean,
  ): void => {
    const tx = px / MM, ty = py / MM, tz = pz / MM;
    if (headsEnabled) {
      const head = rayVsSphere(mx, my, mz, dx, dy, dz, bestT, tx, ty + headY, tz, headR);
      if (head.hit && head.t < bestT) {
        bestT = head.t; hitId = id; hitKind = kind; headshot = true;
        hx = head.x; hy = head.y; hz = head.z; nx = head.nx; ny = head.ny; nz = head.nz;
        return;
      }
    }
    const body = rayVsCapsule(mx, my, mz, dx, dy, dz, bestT, tx, ty, tz, radius, height);
    if (body.hit && body.t < bestT) {
      bestT = body.t; hitId = id; hitKind = kind; headshot = false;
      hx = body.x; hy = body.y; hz = body.z; nx = body.nx; ny = body.ny; nz = body.nz;
    }
  };

  // Fixed evaluation order: heroes, troopers, orbs, range targets.
  for (const o of s.heroes) {
    if (!o.alive || o.id === h.id || o.team === h.team) continue;
    capsuleTest(o.id, 'hero', o.px, o.py, o.pz,
      ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M,
      ENTITY.HEAD_SPHERE_RADIUS_M, ENTITY.HEAD_SPHERE_CENTER_M, true);
  }
  // BLOCKS_BULLETS: your own wave is mobile cover, so friendly troopers are
  // traced too. Shooting through a wave is a real decision, not a free line.
  const TR = WORLD.TROOPERS;
  for (const t of s.troopers) {
    if (!t.alive) continue;
    capsuleTest(t.id, 'trooper', t.px, t.py, t.pz,
      TR.HITBOX_RADIUS_M, TR.HITBOX_HEIGHT_M,
      TR.HEAD_SPHERE_RADIUS_M, TR.HEAD_SPHERE_CENTER_Y_M, TR.HEADSHOTS_ENABLED);
  }
  for (const o of s.orbs) {
    if (!o.alive || o.armTicksLeft > 0) continue;
    const sp = rayVsSphere(mx, my, mz, dx, dy, dz, bestT,
      o.px / MM, o.py / MM, o.pz / MM, ECONOMY.ORB_HITBOX_RADIUS_M);
    if (sp.hit && sp.t < bestT) {
      bestT = sp.t; hitId = o.id; hitKind = 'orb'; headshot = false;
      hx = sp.x; hy = sp.y; hz = sp.z; nx = sp.nx; ny = sp.ny; nz = sp.nz;
    }
  }
  for (const t of s.targets) {
    if (!t.alive) continue;
    capsuleTest(t.id, 'target', t.px, t.py, t.pz,
      ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M,
      ENTITY.HEAD_SPHERE_RADIUS_M, ENTITY.HEAD_SPHERE_CENTER_M, true);
  }
  /**
   * Structures. These are also in `boxes` as world geometry, which is what
   * makes them block bullets and movement — but that means a shot at a tower
   * resolved as a WALL HIT and dealt zero damage. A bot reached 2m from a tower
   * and could not scratch it; twelve minutes of bench read 100% on every
   * structure and looked like a pathing problem.
   *
   * Tested last and on `<= bestT` so it ties with, and beats, the identical
   * geometry hit at the same surface.
   */
  for (const st of s.structures) {
    if (!st.alive || st.team === h.team) continue;
    const dim = st.kind === StructureKind.Core
      ? WORLD.STRUCTURES.CORE_COLLIDER_M : WORLD.STRUCTURES.TOWER_COLLIDER_M;
    const cx = st.px / MM, cz = st.pz / MM;
    const hit = rayVsBox(mx, my, mz, dx, dy, dz, bestT, {
      minX: cx - dim[0]! / 2, minY: 0, minZ: cz - dim[2]! / 2,
      maxX: cx + dim[0]! / 2, maxY: dim[1]!, maxZ: cz + dim[2]! / 2,
    });
    if (hit.hit && hit.t <= bestT) {
      bestT = hit.t; hitId = st.id; hitKind = 'structure'; headshot = false;
      hx = hit.x; hy = hit.y; hz = hit.z; nx = hit.nx; ny = hit.ny; nz = hit.nz;
    }
  }

  if (hitKind === null) {
    if (geo.hit) {
      events.push({
        tick, shooterId: h.id, targetId: -1,
        x: geo.x, y: geo.y, z: geo.z, nx: geo.nx, ny: geo.ny, nz: geo.nz,
        damage: 0, headshot: false, killed: false, geometry: true,
      });
    }
    return;
  }

  const falloff = falloffMult(bestT);

  // ---- orbs take a separate, flat damage number --------------------------
  // Orb damage = BASE × FALLOFF only: no headshot, no item bonuses, no ability
  // damage. The falloff half is BULWARK's range gate; the no-bonuses half stops
  // an itemisation→faster-farm spiral. Collapsing them into one flag is what
  // made two derived domains contradict each other.
  if (hitKind === 'orb') {
    const orb = s.orbs.find((o) => o.id === hitId);
    if (orb !== undefined) {
      const done = damageOrb(s, orb, h, ECONOMY.ORB_DAMAGE_SMG, ECONOMY.ORB_DAMAGE_APPLIES_FALLOFF ? falloff : 1);
      events.push({
        tick, shooterId: h.id, targetId: hitId,
        x: hx, y: hy, z: hz, nx, ny, nz,
        damage: 0, headshot: false, killed: done, geometry: false,
      });
    }
    return;
  }

  // ---- damage ------------------------------------------------------------
  const base = W.DAMAGE * SPINE.DAMAGE_SCALE;
  // §12 M2 settlement: structures take no headshots, and falloff does not
  // apply to them — the per-weapon STRUCTURE_DAMAGE_MULT already encodes
  // archetype siege identity, and stacking falloff on top double-punishes the
  // shotgun and invalidates the single-number siege model.
  if (hitKind === 'structure') {
    const dmgS = Math.max(
      COMBAT.MIN_DAMAGE_MILLI,
      Math.trunc(base * (COMBAT.FALLOFF_APPLIES_TO_STRUCTURES ? falloff : 1) * W.STRUCTURE_DAMAGE_MULT),
    );
    h.hitsLanded++;
    h.damageDealt += dmgS;
    const beforeS = hpOf(s, hitId);
    applyDamage(hitId, dmgS, h.team, h.id);
    events.push({
      tick, shooterId: h.id, targetId: hitId,
      x: hx, y: hy, z: hz, nx, ny, nz,
      damage: dmgS, headshot: false,
      killed: beforeS > 0 && hpOf(s, hitId) <= 0, geometry: false,
    });
    return;
  }
  const afterFalloff = Math.trunc(base * falloff);
  const afterHead = headshot ? Math.trunc(afterFalloff * COMBAT.HEADSHOT_MULT_HITSCAN) : afterFalloff;
  const dmg = Math.max(COMBAT.MIN_DAMAGE_MILLI, afterHead);

  h.hitsLanded++;
  h.damageDealt += dmg;
  if (headshot) h.headshots++;

  const before = hpOf(s, hitId);
  applyDamage(hitId, dmg, h.team, h.id);
  const killed = before > 0 && hpOf(s, hitId) <= 0;

  events.push({
    tick, shooterId: h.id, targetId: hitId,
    x: hx, y: hy, z: hz, nx, ny, nz,
    damage: dmg, headshot, killed, geometry: false,
  });
}

function hpOf(s: WorldState, id: number): number {
  for (const h of s.heroes) if (h.id === id) return h.hp;
  for (const t of s.troopers) if (t.id === id) return t.hp;
  for (const st of s.structures) if (st.id === id) return st.hp;
  for (const t of s.targets) if (t.id === id) return t.hp;
  return 0;
}
