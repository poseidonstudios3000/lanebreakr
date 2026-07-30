/**
 * world — THE ENTIRE GAME IS THIS FUNCTION. Everything else is I/O. (PRD §10.3)
 *
 *   tick(world, inputs) -> void
 *
 * Note what is NOT a parameter: dt. It is a module constant. A signature that
 * accepts dt is a signature a caller can pass a different dt to during
 * catch-up, and that is how determinism dies quietly six weeks into netcode.
 */

import { SPINE, ENTITY, MOVEMENT, M0 } from './balance.js';
import { type WorldState, type HeroState, type TargetState, type PlayerInput, MoveState, CameraMode, Team } from './types.js';
import { buildGreybox, type GreyboxMap } from './map/greybox.js';
import { stepMovement } from './systems/movement.js';
import { stepCombat } from './systems/combat.js';

const MM = 1000;

export interface World {
  state: WorldState;
  map: GreyboxMap;
}

export function createHero(id: number, x: number, y: number, z: number, yaw: number): HeroState {
  return {
    id, team: Team.A, alive: true,
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
    prevButtons: 0,
  };
}

function createTarget(id: number, x: number, y: number, z: number, minX: number, maxX: number, speed: number): TargetState {
  return {
    id,
    px: Math.round(x * MM), py: Math.round(y * MM), pz: Math.round(z * MM),
    hp: M0.TARGET_HP * SPINE.DAMAGE_SCALE,
    maxHp: M0.TARGET_HP * SPINE.DAMAGE_SCALE,
    alive: true, respawnTicksLeft: 0,
    vx: Math.round(speed * MM),
    minX: Math.round(minX * MM), maxX: Math.round(maxX * MM),
  };
}

export function createWorld(matchSeed: number): World {
  const map = buildGreybox();
  const heroes = [createHero(0, map.spawn.x, map.spawn.y, map.spawn.z, map.spawn.yaw)];
  const targets = map.targets.map((t, i) => createTarget(i + 100, t.x, t.y, t.z, t.minX, t.maxX, t.speed));
  return { state: { tick: 0, matchSeed, heroes, targets, events: [] }, map };
}

/**
 * One 60Hz step. Pure with respect to (state, inputs): same state + same
 * inputs produce the same next state on any engine, which is what §10.3
 * stakes the architecture on and what tools/replay-diff verifies.
 */
export function tick(world: World, inputs: readonly PlayerInput[]): void {
  const s = world.state;
  s.events.length = 0;

  // Fixed iteration order over heroes, ascending id. Never Map/Set iteration
  // order, and never "whichever input arrived first".
  for (let i = 0; i < s.heroes.length; i++) {
    const h = s.heroes[i]!;
    if (!h.alive) continue;

    let input: PlayerInput | undefined;
    for (let j = 0; j < inputs.length; j++) {
      if (inputs[j]!.entityId === h.id) { input = inputs[j]; break; }
    }
    if (input === undefined) continue;

    const prev = h.prevButtons;
    stepMovement(h, input, prev, s.tick, world.map.boxes, world.map.ziplines);
    stepCombat(h, input, prev, s.tick, s.matchSeed, s.targets, world.map.boxes, s.events);
    h.prevButtons = input.buttons;

    // Fell out of the world — only reachable in the grey box, but a silent
    // infinite fall is the worst way to discover a collision bug.
    if (h.py < -20 * MM) {
      h.px = Math.round(world.map.spawn.x * MM);
      h.py = Math.round(world.map.spawn.y * MM);
      h.pz = Math.round(world.map.spawn.z * MM);
      h.vx = 0; h.vy = 0; h.vz = 0;
    }
  }

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

  s.tick++;
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

  push(s.tick);
  for (const h of s.heroes) {
    push(h.px); push(h.py); push(h.pz);
    push(h.vx); push(h.vy); push(h.vz);
    push(h.yaw); push(h.pitch); push(h.hp);
    push(h.moveState); push(h.grounded ? 1 : 0);
    push(h.dashCharges); push(h.dashRechargeTicks); push(h.dashTicksLeft);
    push(h.slideTicksLeft); push(h.mantleTicksLeft); push(h.ziplineId); push(h.ziplineT);
    push(h.ammo); push(h.reloadTicksLeft); push(h.fireCooldownTicks);
    push(h.spreadMilliDeg); push(h.recoilVertMilliDeg); push(h.recoilHorizMilliDeg);
    push(h.shotsFired); push(h.hitsLanded); push(h.headshots); push(h.damageDealt);
    push(h.prevButtons);
  }
  for (const t of s.targets) {
    push(t.px); push(t.py); push(t.pz); push(t.hp); push(t.alive ? 1 : 0); push(t.vx);
  }
  return hash >>> 0;
}

export const EYE_HEIGHT_M = ENTITY.EYE_HEIGHT_M;
