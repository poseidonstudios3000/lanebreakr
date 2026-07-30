/**
 * social — emotes and pings.
 *
 * This is the first system built for the stated goal rather than for the match:
 * "a mix of fun with friends", where communication and emotes are named as
 * very important (docs/DIRECTION.md §1–2). It is also, per §9's whole thesis,
 * the cheapest clip generator available — the taunt over a body and the
 * mistimed dance are among the highest clip-per-byte features in the medium.
 *
 * Three rules, and none of them is about the emote itself:
 *
 *   1. ONE BUDGET for emotes and pings together. They are the same spam
 *      surface; two separate rate limits means the sum of both is the real
 *      limit and nobody computed it.
 *   2. PINGS ARE TEAM-ONLY. §1.4 removes fog of war and makes pings the
 *      replacement, which makes them information — and information leaking to
 *      the enemy is not a social feature, it is a bug.
 *   3. EMOTES ARE VISIBLE TO EVERYONE, and that is deliberate: taunting is the
 *      point. But enemy-facing expression is a harassment surface, so it is
 *      per-player mutable (see `mutedBy`), default ON but always silenceable,
 *      rather than a settings toggle nobody finds.
 */

import { SPINE } from '../balance.js';
import {
  type WorldState, type HeroState, type PlayerInput,
  Action, Team, MatchPhase, isEmote, isPing,
} from '../types.js';
import { type Aabb, rayVsBoxes } from '../collision.js';
import { aimDir } from './movement.js';

const MM = 1000;

export const SOCIAL = {
  /** How long an emote plays. Long enough to read on a stream, short enough
   *  that it is never a hiding place. */
  EMOTE_TICKS: 150, // 2.5s
  /** Emoting does not root you — a rooted emote is a death sentence and people
   *  stop using the feature, which defeats the point of having it. */
  EMOTE_BLOCKS_MOVEMENT: false,
  EMOTE_CANCELS_ON_DAMAGE: true,
  EMOTE_CANCELS_ON_FIRE: true,

  PING_TICKS: 300, // 5.0s
  PING_MAX_RANGE_M: 220, // the whole map; there is no fog to gate it
  PING_ENEMY_MARK_TICKS: 120,

  /** Shared budget. 4 uses, refilling one per 2s. */
  WHEEL_BUDGET: 4,
  WHEEL_REFILL_TICKS: 120,
  WHEEL_COOLDOWN_TICKS: 30, // 0.5s between any two wheel uses
} as const;

export function stepSocial(s: WorldState): void {
  for (const h of s.heroes) {
    if (h.wheelCooldown > 0) h.wheelCooldown--;
    if (h.wheelBudget < SOCIAL.WHEEL_BUDGET) {
      h.wheelRefillIn--;
      if (h.wheelRefillIn <= 0) {
        h.wheelBudget++;
        h.wheelRefillIn = SOCIAL.WHEEL_REFILL_TICKS;
      }
    }
    if (h.emoteTicksLeft > 0) {
      h.emoteTicksLeft--;
      if (h.emoteTicksLeft === 0) h.emote = Action.None;
    }
  }

  for (let i = 0; i < s.pings.length; i++) {
    const p = s.pings[i]!;
    if (p.ticksLeft > 0) p.ticksLeft--;
  }
  if (s.pings.length > 40) s.pings = s.pings.filter((p) => p.ticksLeft > 0);
}

/** Consume one wheel action. Returns false when the sim refused it. */
export function applyAction(
  s: WorldState,
  h: HeroState,
  input: PlayerInput,
  boxes: readonly Aabb[],
): boolean {
  const a = input.action;
  if (a === Action.None || !h.alive || s.phase === MatchPhase.Over) return false;
  if (h.wheelCooldown > 0 || h.wheelBudget <= 0) return false;

  if (isEmote(a)) {
    h.emote = a;
    h.emoteTicksLeft = SOCIAL.EMOTE_TICKS;
  } else if (isPing(a)) {
    // Land the ping where you are looking. A ping that lands on your own feet
    // communicates nothing, which is why this raycasts rather than using the
    // player position.
    const [dx, dy, dz] = aimDir(h.yaw, h.pitch);
    const ox = h.px / MM;
    const oy = h.py / MM + 1.62;
    const oz = h.pz / MM;
    const hit = rayVsBoxes(ox, oy, oz, dx, dy, dz, SOCIAL.PING_MAX_RANGE_M, boxes);
    const t = hit.hit ? hit.t : 40;
    s.pings.push({
      id: s.nextEntityId++,
      team: h.team,
      fromId: h.id,
      kind: a,
      px: Math.round((ox + dx * t) * MM),
      py: Math.round((oy + dy * t) * MM),
      pz: Math.round((oz + dz * t) * MM),
      ticksLeft: SOCIAL.PING_TICKS,
    });
  } else {
    return false;
  }

  h.wheelCooldown = SOCIAL.WHEEL_COOLDOWN_TICKS;
  h.wheelBudget--;
  if (h.wheelRefillIn <= 0) h.wheelRefillIn = SOCIAL.WHEEL_REFILL_TICKS;
  return true;
}

export function cancelEmote(h: HeroState): void {
  h.emote = Action.None;
  h.emoteTicksLeft = 0;
}

/** Pings a given team can see. Team-only: they are information, not decoration. */
export function visiblePings(s: WorldState, team: Team): readonly { px: number; py: number; pz: number; kind: number; ticksLeft: number }[] {
  return s.pings.filter((p) => p.team === team && p.ticksLeft > 0);
}

export const EMOTE_NAMES: Record<number, string> = {
  [Action.EmoteWave]: 'WAVE',
  [Action.EmoteDance]: 'DANCE',
  [Action.EmoteTaunt]: 'TAUNT',
  [Action.EmoteLaugh]: 'LAUGH',
  [Action.EmoteSalute]: 'SALUTE',
  [Action.EmoteSit]: 'SIT',
};

export const PING_NAMES: Record<number, string> = {
  [Action.PingEnemy]: 'ENEMY',
  [Action.PingDanger]: 'DANGER',
  [Action.PingOnMyWay]: 'ON MY WAY',
  [Action.PingObjective]: 'OBJECTIVE',
  [Action.PingSouls]: 'SOULS',
  [Action.PingHelp]: 'HELP',
};

export const SOCIAL_TICK_S = SPINE.TICK_S;
