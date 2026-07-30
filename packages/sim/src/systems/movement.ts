/**
 * movement — the capsule controller. Ground, air, dash, slide, mantle, zipline.
 *
 * PRD §1.3 P3 calls movement tech "the primary clip source", and §12/M0 now
 * gates on it. All five verbs live here because they are the same controller:
 * building slide or mantle later, after prediction exists, costs several times
 * what it costs now (a zipline is attached remote-player movement, which is
 * precisely the M4 problem).
 */

import { MOVEMENT, ENTITY, CAMERA, SPINE } from '../balance.js';
import { sin, cos, clamp } from '../mathd.js';
import {
  type HeroState, type PlayerInput, MoveState, CameraMode, Btn,
  YAW_TO_RAD, PITCH_TO_RAD,
} from '../types.js';
import { type Aabb, moveAndSlide, groundProbe, rayVsBoxes } from '../collision.js';
import type { Zipline } from '../map/greybox.js';

const DT = SPINE.TICK_S;
const MM = 1000;

export function yawSin(yawQ: number): number { return sin(yawQ * YAW_TO_RAD); }
export function yawCos(yawQ: number): number { return cos(yawQ * YAW_TO_RAD); }

/** Unit aim vector from quantised yaw/pitch. yaw 0 looks down −Z. */
export function aimDir(yawQ: number, pitchQ: number): [number, number, number] {
  const cy = cos(yawQ * YAW_TO_RAD);
  const sy = sin(yawQ * YAW_TO_RAD);
  const cp = cos(pitchQ * PITCH_TO_RAD);
  const sp = sin(pitchQ * PITCH_TO_RAD);
  return [sy * cp, sp, -cy * cp];
}

function pressed(input: PlayerInput, prev: number, bit: Btn): boolean {
  return (input.buttons & bit) !== 0 && (prev & bit) === 0;
}

export function stepMovement(
  h: HeroState,
  input: PlayerInput,
  prevButtons: number,
  tick: number,
  boxes: readonly Aabb[],
  ziplines: readonly Zipline[],
): void {
  // ---- integer state → float working values ------------------------------
  let x = h.px / MM, y = h.py / MM, z = h.pz / MM;
  let vx = h.vx / MM, vy = h.vy / MM, vz = h.vz / MM;

  h.yaw = input.yaw;
  h.pitch = input.pitch;

  // ---- timers ------------------------------------------------------------
  if (h.dashCooldownTicks > 0) h.dashCooldownTicks--;
  if (h.slideCooldownTicks > 0) h.slideCooldownTicks--;
  if (h.iframeTicksLeft > 0) h.iframeTicksLeft--;
  if (h.cameraLerp > 0) h.cameraLerp--;
  if (h.dashCharges < MOVEMENT.DASH_CHARGES) {
    h.dashRechargeTicks++;
    if (h.dashRechargeTicks >= MOVEMENT.DASH_RECHARGE_TICKS) {
      h.dashRechargeTicks = 0;
      h.dashCharges++;
    }
  }

  // ---- camera. §5.2: switching is NEVER blocked — not while dashing, not
  //      mid-air, not while stunned. The camera moves during a stun on
  //      purpose; the spectacle is the point. ----------------------------
  if (pressed(input, prevButtons, Btn.CameraToggle)) {
    h.camera = h.camera === CameraMode.TPS ? CameraMode.FPS : CameraMode.TPS;
    h.cameraLerp = CAMERA.TRANSITION_TICKS;
  }
  const adsHeld = (input.buttons & Btn.Ads) !== 0;
  if (adsHeld && h.moveState !== MoveState.Dash) {
    if (h.adsTicks < CAMERA.ADS_ENTER_TICKS) h.adsTicks++;
  } else if (h.adsTicks > 0) {
    h.adsTicks--;
  }
  const adsFrac = h.adsTicks / CAMERA.ADS_ENTER_TICKS;

  // ---- movement basis ----------------------------------------------------
  const sy = yawSin(h.yaw);
  const cy = yawCos(h.yaw);
  // forward = (sy, 0, −cy); right = (cy, 0, sy)
  let wishX = input.moveX * cy + input.moveZ * sy;
  let wishZ = input.moveX * sy - input.moveZ * cy;
  const wishLen2 = wishX * wishX + wishZ * wishZ;
  if (wishLen2 > 1e-9) {
    const inv = 1 / Math.sqrt(wishLen2);
    wishX *= inv;
    wishZ *= inv;
  }

  const grounded = h.grounded;
  if (grounded) h.groundedTick = tick;
  const coyoteOk = tick - h.groundedTick <= MOVEMENT.COYOTE_TICKS;

  if (pressed(input, prevButtons, Btn.Jump)) h.jumpBufferedTick = tick;
  const jumpBuffered = tick - h.jumpBufferedTick <= MOVEMENT.JUMP_BUFFER_TICKS;

  // ---- state transitions --------------------------------------------------

  // Zipline attach / detach.
  if (h.moveState === MoveState.Zipline) {
    if (pressed(input, prevButtons, Btn.Jump) || pressed(input, prevButtons, Btn.Zipline)) {
      h.moveState = MoveState.Air;
      h.ziplineId = -1;
      vy = MOVEMENT.JUMP_VELOCITY_MPS * 0.6;
    }
  } else if (pressed(input, prevButtons, Btn.Zipline)) {
    const zl = findZipline(x, y, z, ziplines);
    if (zl !== null) {
      h.moveState = MoveState.Zipline;
      h.ziplineId = zl.id;
      h.ziplineT = Math.round(zl.t * MM);
      h.ziplineDir = zl.dir;
      vx = 0; vy = 0; vz = 0;
    }
  }

  // Dash. Overrides everything except mantle; that is what makes it the
  // get-out-of-jail card (§6.4).
  if (
    h.moveState !== MoveState.Mantle &&
    pressed(input, prevButtons, Btn.Dash) &&
    h.dashCharges > 0 &&
    h.dashCooldownTicks === 0
  ) {
    h.dashCharges--;
    h.dashTicksLeft = MOVEMENT.DASH_DURATION_TICKS;
    h.dashCooldownTicks = MOVEMENT.DASH_COOLDOWN_TICKS;
    h.iframeTicksLeft = MOVEMENT.DASH_IFRAME_TICKS;
    h.moveState = MoveState.Dash;
    h.ziplineId = -1;
    // No directional input dashes forward, which is what players expect when
    // they panic-press with no key down.
    const dx = wishLen2 > 1e-9 ? wishX : sy;
    const dz = wishLen2 > 1e-9 ? wishZ : -cy;
    h.dashDirX = Math.round(dx * MM);
    h.dashDirZ = Math.round(dz * MM);
    h.slideTicksLeft = 0;
  }

  // Slide. Requires real entry speed, so it is a commitment, not a crouch spam.
  const speed2 = vx * vx + vz * vz;
  if (
    h.moveState === MoveState.Ground &&
    pressed(input, prevButtons, Btn.Slide) &&
    h.slideCooldownTicks === 0 &&
    speed2 >= MOVEMENT.SLIDE_MIN_ENTRY_SPEED_MPS * MOVEMENT.SLIDE_MIN_ENTRY_SPEED_MPS
  ) {
    h.moveState = MoveState.Slide;
    h.slideTicksLeft = MOVEMENT.SLIDE_DURATION_TICKS;
    h.slideCooldownTicks = MOVEMENT.SLIDE_COOLDOWN_TICKS;
    const s = Math.sqrt(speed2);
    const boost = MOVEMENT.SLIDE_ENTRY_SPEED_MULT;
    vx = (vx / s) * s * boost;
    vz = (vz / s) * s * boost;
  }

  // Mantle probe — only when airborne or pressed against a ledge while moving.
  if (
    h.moveState !== MoveState.Mantle &&
    h.moveState !== MoveState.Dash &&
    h.moveState !== MoveState.Zipline &&
    jumpBuffered &&
    wishLen2 > 1e-9
  ) {
    const m = probeMantle(x, y, z, wishX, wishZ, boxes);
    if (m !== null) {
      h.moveState = MoveState.Mantle;
      h.mantleTicksLeft = MOVEMENT.MANTLE_DURATION_TICKS;
      h.mantleTargetX = Math.round(m.x * MM);
      h.mantleTargetY = Math.round(m.y * MM);
      h.mantleTargetZ = Math.round(m.z * MM);
      h.jumpBufferedTick = -999;
      vx = 0; vy = 0; vz = 0;
    }
  }

  // ---- integrate ----------------------------------------------------------
  switch (h.moveState) {
    case MoveState.Mantle: {
      const total = MOVEMENT.MANTLE_DURATION_TICKS;
      const remaining = h.mantleTicksLeft;
      const t = (total - remaining) / total;
      const tx = h.mantleTargetX / MM;
      const ty = h.mantleTargetY / MM;
      const tz = h.mantleTargetZ / MM;
      // Rise first, then translate — reads as a pull-up rather than a slide.
      const yEase = t < 0.6 ? t / 0.6 : 1;
      const xzEase = t < 0.4 ? 0 : (t - 0.4) / 0.6;
      y = y + (ty - y) * yEase;
      x = x + (tx - x) * xzEase;
      z = z + (tz - z) * xzEase;
      h.mantleTicksLeft--;
      if (h.mantleTicksLeft <= 0) {
        x = tx; y = ty; z = tz;
        h.moveState = MoveState.Ground;
      }
      h.px = Math.round(x * MM); h.py = Math.round(y * MM); h.pz = Math.round(z * MM);
      h.vx = 0; h.vy = 0; h.vz = 0;
      h.grounded = false;
      return;
    }

    case MoveState.Zipline: {
      const zl = ziplines[h.ziplineId];
      if (zl === undefined) { h.moveState = MoveState.Air; break; }
      const accelFrac = clamp(
        (MOVEMENT.ZIPLINE_ACCEL_TICKS - Math.max(0, MOVEMENT.ZIPLINE_ACCEL_TICKS - (tick % 100000))) /
          MOVEMENT.ZIPLINE_ACCEL_TICKS, 0.35, 1,
      );
      const step = (MOVEMENT.ZIPLINE_SPEED_MPS * accelFrac * DT) / zl.length;
      let t = h.ziplineT / MM + step * h.ziplineDir;
      if (t >= 1 || t <= 0) {
        t = clamp(t, 0, 1);
        h.moveState = MoveState.Air;
        h.ziplineId = -1;
        vy = 0;
      }
      h.ziplineT = Math.round(t * MM);
      x = zl.ax + (zl.bx - zl.ax) * t;
      y = zl.ay + (zl.by - zl.ay) * t - 1.0; // hang below the cable
      z = zl.az + (zl.bz - zl.az) * t;
      vx = ((zl.bx - zl.ax) / zl.length) * MOVEMENT.ZIPLINE_SPEED_MPS * h.ziplineDir;
      vz = ((zl.bz - zl.az) / zl.length) * MOVEMENT.ZIPLINE_SPEED_MPS * h.ziplineDir;
      h.px = Math.round(x * MM); h.py = Math.round(y * MM); h.pz = Math.round(z * MM);
      h.vx = Math.round(vx * MM); h.vy = 0; h.vz = Math.round(vz * MM);
      h.grounded = false;
      return;
    }

    case MoveState.Dash: {
      const speed = MOVEMENT.DASH_DISTANCE_M / (MOVEMENT.DASH_DURATION_TICKS * DT);
      vx = (h.dashDirX / MM) * speed;
      vz = (h.dashDirZ / MM) * speed;
      vy = 0; // flat dash: predictable, and it does not become a jump extender
      h.dashTicksLeft--;
      if (h.dashTicksLeft <= 0) {
        vx *= MOVEMENT.DASH_PRESERVES_SPEED_FRAC;
        vz *= MOVEMENT.DASH_PRESERVES_SPEED_FRAC;
        h.moveState = grounded ? MoveState.Ground : MoveState.Air;
      }
      break;
    }

    case MoveState.Slide: {
      const s = Math.sqrt(vx * vx + vz * vz);
      const floor = MOVEMENT.BASE_SPEED_MPS * MOVEMENT.SLIDE_MIN_EXIT_SPEED_FRAC;
      if (s > floor) {
        const dec = MOVEMENT.SLIDE_FRICTION_MPS2 * DT;
        const ns = Math.max(floor, s - dec);
        vx = (vx / s) * ns;
        vz = (vz / s) * ns;
      }
      vy += MOVEMENT.GRAVITY_MPS2 * DT;
      h.slideTicksLeft--;
      if (h.slideTicksLeft <= 0 || !grounded) {
        h.moveState = grounded ? MoveState.Ground : MoveState.Air;
      }
      if (jumpBuffered && coyoteOk) {
        vy = MOVEMENT.JUMP_VELOCITY_MPS;
        h.moveState = MoveState.Air;
        h.slideTicksLeft = 0;
        h.jumpBufferedTick = -999;
      }
      break;
    }

    default: {
      // Ground / Air share one accelerate-and-clamp model.
      let maxSpeed = MOVEMENT.BASE_SPEED_MPS;
      if (adsFrac > 0) {
        maxSpeed *= 1 + (MOVEMENT.ADS_SPEED_MULT - 1) * adsFrac;
      }

      if (grounded) {
        h.moveState = MoveState.Ground;
        const cur = Math.sqrt(vx * vx + vz * vz);
        if (wishLen2 > 1e-9) {
          const target = maxSpeed;
          const accel = MOVEMENT.GROUND_ACCEL_MPS2 * DT;
          vx += wishX * accel;
          vz += wishZ * accel;
          const ns = Math.sqrt(vx * vx + vz * vz);
          if (ns > target) { vx = (vx / ns) * target; vz = (vz / ns) * target; }
        } else if (cur > 0) {
          const dec = MOVEMENT.GROUND_FRICTION_MPS2 * DT;
          const ns = Math.max(0, cur - dec);
          if (ns <= 0) { vx = 0; vz = 0; } else { vx = (vx / cur) * ns; vz = (vz / cur) * ns; }
        }
        if (jumpBuffered && coyoteOk) {
          vy = MOVEMENT.JUMP_VELOCITY_MPS;
          h.moveState = MoveState.Air;
          h.jumpBufferedTick = -999;
          h.groundedTick = -999;
        } else if (vy < 0) {
          vy = 0;
        }
      } else {
        h.moveState = MoveState.Air;
        if (wishLen2 > 1e-9) {
          const accel = MOVEMENT.AIR_ACCEL_MPS2 * DT;
          const projected = vx * wishX + vz * wishZ;
          const addCap = maxSpeed * MOVEMENT.AIR_SPEED_MULT - projected;
          if (addCap > 0) {
            const add = Math.min(accel, addCap, MOVEMENT.MAX_AIR_SPEED_GAIN_MPS);
            vx += wishX * add;
            vz += wishZ * add;
          }
        }
      }
      vy += MOVEMENT.GRAVITY_MPS2 * DT;
      break;
    }
  }

  // ---- collide and slide --------------------------------------------------
  const height = h.moveState === MoveState.Slide ? ENTITY.SLIDE_HEIGHT_M : ENTITY.CAPSULE_HEIGHT_M;
  const r = moveAndSlide(
    x, y, z, vx, vy, vz,
    vx * DT, vy * DT, vz * DT,
    ENTITY.CAPSULE_RADIUS_M, height,
    boxes, MOVEMENT.MAX_GROUND_SLOPE_COS,
  );

  h.grounded = r.grounded ||
    groundProbe(r.x, r.y, r.z, ENTITY.CAPSULE_RADIUS_M, height, 0.08, boxes, MOVEMENT.MAX_GROUND_SLOPE_COS);

  if (h.grounded && h.moveState === MoveState.Air) h.moveState = MoveState.Ground;

  // ---- float → integer state. THIS is the determinism boundary. ------------
  h.px = Math.round(r.x * MM);
  h.py = Math.round(r.y * MM);
  h.pz = Math.round(r.z * MM);
  h.vx = Math.round(r.vx * MM);
  h.vy = Math.round(r.vy * MM);
  h.vz = Math.round(r.vz * MM);
}

// ---------------------------------------------------------------------------

function findZipline(
  x: number, y: number, z: number,
  ziplines: readonly Zipline[],
): { id: number; t: number; dir: number } | null {
  for (let i = 0; i < ziplines.length; i++) {
    const zl = ziplines[i]!;
    const dx = zl.bx - zl.ax, dy = zl.by - zl.ay, dz = zl.bz - zl.az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = ((x - zl.ax) * dx + (y - zl.ay) * dy + (z - zl.az) * dz) / len2;
    t = clamp(t, 0, 1);
    const cx = zl.ax + dx * t, cy2 = zl.ay + dy * t, cz = zl.az + dz * t;
    const ex = x - cx, ey = y - cy2, ez = z - cz;
    const d2 = ex * ex + ey * ey + ez * ez;
    const R = MOVEMENT.ZIPLINE_ATTACH_RANGE_M;
    if (d2 <= R * R) return { id: zl.id, t, dir: t < 0.5 ? 1 : -1 };
  }
  return null;
}

/**
 * Ledge probe. Casts forward at chest height to find a wall, then down from
 * above it to find a standable top. Replaces PRD v1.0's "4 mantle points":
 * scripted mantle locations are a level-design liability, and the MID PIT
 * already needed a fifth one the document never listed.
 */
function probeMantle(
  x: number, y: number, z: number,
  dirX: number, dirZ: number,
  boxes: readonly Aabb[],
): { x: number; y: number; z: number } | null {
  const reach = MOVEMENT.MANTLE_REACH_M;
  const wall = rayVsBoxes(x, y + 1.0, z, dirX, 0, dirZ, reach, boxes);
  if (!wall.hit) return null;

  const probeX = x + dirX * (reach + ENTITY.CAPSULE_RADIUS_M);
  const probeZ = z + dirZ * (reach + ENTITY.CAPSULE_RADIUS_M);
  const top = rayVsBoxes(
    probeX, y + MOVEMENT.MANTLE_MAX_HEIGHT_M + 0.5, probeZ,
    0, -1, 0, MOVEMENT.MANTLE_MAX_HEIGHT_M + 0.5, boxes,
  );
  if (!top.hit || top.ny < 0.7) return null;

  const ledgeH = top.y - y;
  if (ledgeH < MOVEMENT.MANTLE_MIN_HEIGHT_M || ledgeH > MOVEMENT.MANTLE_MAX_HEIGHT_M) return null;

  // Headroom: refuse to mantle into a ceiling.
  const clear = rayVsBoxes(probeX, top.y + 0.05, probeZ, 0, 1, 0, ENTITY.CAPSULE_HEIGHT_M, boxes);
  if (clear.hit) return null;

  return { x: probeX, y: top.y + 0.02, z: probeZ };
}
