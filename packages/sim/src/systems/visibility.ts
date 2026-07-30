/**
 * visibility — `canSee()`, the head-authoritative line-of-sight query.
 *
 * PRD §5.3 describes this as a *rendering* rule. It is not, and putting it in
 * the renderer is one of the more expensive mistakes available here: bots read
 * `WorldState` directly and have no perception of their own, so a render-side
 * gate means every bot sees through every wall. Since M3's TTK, §8's hero win
 * rates and the whole M8 tuning loop are measured bot-vs-bot, an omniscient
 * bench measures a *different game* than humans play — and `tools/peek-test`
 * ends up comparing two omniscient agents and passing forever.
 *
 * So it lives in sim, pure, and three callers get the identical answer: the
 * renderer, the bot AI, and the headless peek test.
 *
 * Three rays, not one — §4.1 puts a sightline breaker every 15m, and a single
 * chest ray flickers against cover in a way that reads as a bug. Tick-locked to
 * VISIBILITY_INTERVAL_TICKS with hysteresis, and it fails CLOSED on a stale
 * sample: showing an enemy who is not there is worse than briefly missing one.
 */

import { SPINE, ENTITY, CAMERA } from '../balance.js';
import { type Aabb, rayVsBoxes } from '../collision.js';
import type { WorldState, HeroState } from '../types.js';

const MM = 1000;

/** Sample heights along the target capsule, as a fraction of its height. */
const RAY_FRACTIONS = [0.9, 0.55, 0.12]; // head, chest, feet

/**
 * Raw geometric test: is any part of `target` visible from `viewer`'s HEAD?
 * Not the camera — that distinction is the whole anti-peek mechanism.
 */
export function canSeeRaw(
  viewer: HeroState,
  targetX: number,
  targetY: number,
  targetZ: number,
  targetHeight: number,
  boxes: readonly Aabb[],
): boolean {
  const ox = viewer.px / MM;
  const oy = viewer.py / MM + ENTITY.EYE_HEIGHT_M;
  const oz = viewer.pz / MM;

  for (let i = 0; i < RAY_FRACTIONS.length; i++) {
    const ty = targetY + targetHeight * RAY_FRACTIONS[i]!;
    const dx = targetX - ox;
    const dy = ty - oy;
    const dz = targetZ - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return true;
    const hit = rayVsBoxes(ox, oy, oz, dx / len, dy / len, dz / len, len - 0.05, boxes);
    if (!hit.hit) return true;
  }
  return false;
}

export function canSeeHero(viewer: HeroState, target: HeroState, boxes: readonly Aabb[]): boolean {
  if (!target.alive) return false;
  return canSeeRaw(viewer, target.px / MM, target.py / MM, target.pz / MM, ENTITY.CAPSULE_HEIGHT_M, boxes);
}

/**
 * Hysteresis wrapper. Two consecutive occluded samples before hiding, and a
 * minimum visible dwell — without both, an enemy strafing behind a pillar
 * strobes, and a strobing enemy is unshootable in a way that feels like
 * netcode rather than like cover.
 */
export interface VisibilityMemory {
  /** key = viewerId * 64 + targetId */
  visible: Map<number, number>;
  missCount: Map<number, number>;
}

export function newVisibilityMemory(): VisibilityMemory {
  return { visible: new Map(), missCount: new Map() };
}

export function updateVisibility(
  s: WorldState,
  mem: VisibilityMemory,
  boxes: readonly Aabb[],
): void {
  if (s.tick % SPINE.VISIBILITY_INTERVAL_TICKS !== 0) return;

  // Fixed iteration order over ascending ids — never Map order.
  for (let i = 0; i < s.heroes.length; i++) {
    const viewer = s.heroes[i]!;
    for (let j = 0; j < s.heroes.length; j++) {
      const target = s.heroes[j]!;
      if (target.id === viewer.id || target.team === viewer.team) continue;
      const key = viewer.id * 64 + target.id;

      const raw = canSeeHero(viewer, target, boxes);
      if (raw) {
        mem.missCount.set(key, 0);
        mem.visible.set(key, s.tick + CAMERA.VIS_MIN_DWELL_TICKS);
      } else {
        const misses = (mem.missCount.get(key) ?? 0) + 1;
        mem.missCount.set(key, misses);
        if (misses < CAMERA.VIS_HYSTERESIS_SAMPLES) {
          mem.visible.set(key, s.tick + CAMERA.VIS_MIN_DWELL_TICKS);
        }
      }
    }
  }
}

/** The gated answer. Fails closed when there is no sample yet. */
export function canSee(s: WorldState, mem: VisibilityMemory, viewerId: number, targetId: number): boolean {
  const until = mem.visible.get(viewerId * 64 + targetId);
  return until !== undefined && until >= s.tick;
}
