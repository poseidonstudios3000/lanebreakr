/**
 * glitch — the GLITCH BOMB.
 *
 * The first mechanic written to the tone in docs/DIRECTION.md §0: not fantasy,
 * not military realism. The world is synthetic and knows it, and this is the
 * thing that tampers with the rules.
 *
 * The design bar, restated here because every constant in GLITCH exists to hold
 * it: **it has to be funny to be hit by, not only funny to land.** Losing
 * control is among the most hated mechanics in games when it is long, unclear
 * or lethal, and among the most beloved when it is short, telegraphed and
 * survivable. So:
 *
 *   - it is thrown, with a 0.7s fuse, at a visible point with a visible radius
 *   - it deals almost no damage; it makes you killable, it does not kill you
 *   - it SCRAMBLES rather than freezes, because a player who can still flail
 *     can still get lucky, and that near-miss is the clip
 *   - you can still shoot back
 *
 * The scramble is a remap of the movement axes that re-rolls a few times per
 * glitch, plus aim jitter. Both are derived from `rngFor`, so a replay
 * reproduces the exact flailing — which matters, because the flailing IS the
 * clip and a clip that does not reproduce is not a clip.
 */

import { SPINE, GLITCH, ECONOMY } from '../balance.js';
import { rngFor, RNG_STREAM } from '../rng.js';
import {
  type WorldState, type HeroState, type PlayerInput,
  Team, MatchPhase, YAW_STEPS,
} from '../types.js';
import { type Aabb, rayVsBoxes } from '../collision.js';
import { aimDir } from './movement.js';

const MM = 1000;

/** Throw one. Returns false if it was refused (cooldown, dead, no ability). */
export function castGlitch(s: WorldState, h: HeroState, boxes: readonly Aabb[]): boolean {
  if (!h.alive || h.abilityQCooldown > 0) return false;
  h.abilityQCooldown = GLITCH.COOLDOWN_TICKS;

  // Land it where you are looking, capped at range — a ground-target reticle
  // rather than a projectile, so the telegraph is the fuse rather than flight
  // time. §5.1 gives TPS the full arc preview; this is the same aim source.
  const [dx, dy, dz] = aimDir(h.yaw, h.pitch);
  const ox = h.px / MM;
  const oy = h.py / MM + 1.5;
  const oz = h.pz / MM;
  const hit = rayVsBoxes(ox, oy, oz, dx, dy, dz, GLITCH.MAX_RANGE_M, boxes);
  const t = hit.hit ? hit.t : GLITCH.MAX_RANGE_M;

  s.glitches.push({
    id: s.nextEntityId++,
    team: h.team,
    ownerId: h.id,
    px: Math.round((ox + dx * t) * MM),
    py: Math.round((oy + dy * t) * MM),
    pz: Math.round((oz + dz * t) * MM),
    armTicksLeft: GLITCH.ARM_TICKS,
  });
  return true;
}

export function stepGlitch(
  s: WorldState,
  applyDamage: (targetId: number, milliDamage: number, sourceTeam: Team, attackerId?: number) => void,
): void {
  if (s.phase === MatchPhase.Over) return;

  for (const h of s.heroes) {
    if (h.abilityQCooldown > 0) h.abilityQCooldown--;
    if (h.glitchTicksLeft > 0) h.glitchTicksLeft--;
  }

  for (let i = 0; i < s.glitches.length; i++) {
    const g = s.glitches[i]!;
    if (g.armTicksLeft <= 0) continue;
    g.armTicksLeft--;
    if (g.armTicksLeft > 0) continue;

    // Detonate. Fixed iteration order over ascending hero id.
    const r2 = GLITCH.RADIUS_M * GLITCH.RADIUS_M;
    for (const h of s.heroes) {
      if (!h.alive || h.team === g.team) continue;
      const dx = (h.px - g.px) / MM;
      const dy = (h.py - g.py) / MM;
      const dz = (h.pz - g.pz) / MM;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      // Refresh rather than stack: two bombs should not mean 3.6s of flailing.
      h.glitchTicksLeft = GLITCH.DURATION_TICKS;
      h.glitchSeed = (h.glitchSeed + s.tick + h.id) | 0;
      if (GLITCH.DAMAGE > 0) applyDamage(h.id, GLITCH.DAMAGE * SPINE.DAMAGE_SCALE, g.team, g.ownerId);
    }
  }

  if (s.glitches.length > 24) s.glitches = s.glitches.filter((g) => g.armTicksLeft > 0);
}

/**
 * Apply the scramble to an input, in the sim, before movement consumes it.
 *
 * Doing it here rather than client-side is deliberate: it has to be
 * server-authoritative or a modified client simply ignores it, and it has to be
 * deterministic or the replay shows different flailing than the match did.
 */
export function scrambleInput(s: WorldState, h: HeroState, input: PlayerInput): PlayerInput {
  if (h.glitchTicksLeft <= 0) return input;

  const phase = Math.floor(h.glitchTicksLeft / GLITCH.REMAP_INTERVAL_TICKS);
  const rng = rngFor(s.matchSeed, phase, h.id ^ h.glitchSeed, RNG_STREAM.ABILITY);

  // One of four axis remaps, re-rolled every REMAP_INTERVAL. Rotation and
  // mirroring, never zero — the point is that the controls lie to you, not
  // that they stop working.
  const mode = rng.below(4);
  let mx = input.moveX;
  let mz = input.moveZ;
  if (mode === 0) { mx = -input.moveX; mz = -input.moveZ; }
  else if (mode === 1) { mx = input.moveZ; mz = -input.moveX; }
  else if (mode === 2) { mx = -input.moveZ; mz = input.moveX; }
  else { mx = input.moveX; mz = -input.moveZ; }

  // Aim jitter, per tick, so the crosshair drifts rather than teleporting.
  const jitter = rngFor(s.matchSeed, s.tick, h.id ^ h.glitchSeed, RNG_STREAM.ABILITY);
  const yawOff = Math.round((jitter.signed() * GLITCH.AIM_JITTER_MILLIDEG) / 1000 / 360 * YAW_STEPS);

  let buttons = input.buttons;
  if (GLITCH.BLOCKS_DASH) buttons &= ~(1 << 3); // Btn.Dash — the denied counterplay
  if (GLITCH.BLOCKS_FIRE) buttons &= ~(1 << 0);

  return {
    ...input,
    moveX: mx,
    moveZ: mz,
    yaw: ((input.yaw + yawOff) % YAW_STEPS + YAW_STEPS) % YAW_STEPS,
    buttons,
  };
}

export function isGlitched(h: HeroState): boolean {
  return h.glitchTicksLeft > 0;
}

export const GLITCH_ORB_NOTE = ECONOMY.ORB_DAMAGE_ABILITY; // abilities never touch orbs
