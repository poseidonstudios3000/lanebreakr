/**
 * rng — stateless, derived, replayable randomness.
 *
 * WHY NOT A SEEDED STREAM OBJECT
 * The obvious design is one seeded xorshift advanced by every consumer. It is
 * also unusable here, and the reason is client prediction (PRD §10.4): a
 * predicting client does not know how many draws the other five players' shots
 * consumed this tick, because it only receives 20Hz area-of-interest-culled
 * snapshots. Its stream position diverges from the server's immediately and
 * permanently.
 *
 * The damage shows up on exactly one hero. BULWARK's shotgun draws 8 pellet
 * samples per trigger pull; the client paints 8 hitmarkers from its stream and
 * the server resolves a different 8 from its own. Reconciliation never catches
 * it, because §10.4 tests a *position* mismatch and spread does not move
 * anyone. It just quietly feels broken for the hero whose pitch is "walks at
 * you and there is nothing you can do about it".
 *
 * So: every draw is a pure function of (matchSeed, tick, entityId, salt, index).
 * Any participant can reproduce any draw with no knowledge of global ordering,
 * rewind-and-replay is free, and the client's predicted pellet pattern is
 * bit-identical to the server's.
 *
 * Uses only Math.imul and bitwise ops, all of which ECMAScript specifies
 * exactly — see mathd.ts for why that matters.
 */

/** Stream ids. Distinct salts keep unrelated systems from aliasing. */
export const RNG_STREAM = {
  RECOIL: 1,
  PELLET: 2,
  ABILITY: 3,
  AI: 4,
  ANNOUNCER: 5,
  CRIT_TIEBREAK: 6,
} as const;

export type RngStream = (typeof RNG_STREAM)[keyof typeof RNG_STREAM];

/** murmur3 32-bit finalizer — strong avalanche, exact integer ops only. */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The whole generator. Pure: same arguments always yield the same u32,
 * on any engine, in any order, forever.
 */
export function rngU32(
  matchSeed: number,
  tick: number,
  entityId: number,
  salt: RngStream | number,
  index: number,
): number {
  let h = matchSeed | 0;
  h = mix32(h ^ Math.imul(tick | 0, 0x9e3779b1));
  h = mix32(h ^ Math.imul(entityId | 0, 0x85ebca6b));
  h = mix32(h ^ Math.imul(salt | 0, 0xc2b2ae35));
  h = mix32(h ^ Math.imul(index | 0, 0x27d4eb2f));
  return h >>> 0;
}

/**
 * A cursor over one (tick, entity, stream) triple. Holds only its own draw
 * index, so two cursors over the same triple produce the same sequence no
 * matter what else the sim did in between. This is the property that makes
 * rewind-and-replay exact.
 */
export class Rng {
  private index = 0;

  constructor(
    private readonly matchSeed: number,
    private readonly tick: number,
    private readonly entityId: number,
    private readonly salt: RngStream | number,
  ) {}

  u32(): number {
    return rngU32(this.matchSeed, this.tick, this.entityId, this.salt, this.index++);
  }

  /** [0, 1) with 24 bits of mantissa — the exact division is bit-stable. */
  unit(): number {
    return (this.u32() >>> 8) / 16777216;
  }

  /** [-1, 1) — the sampling shape COMBAT's RNG draw contract specifies. */
  signed(): number {
    return ((this.u32() >>> 8) * 2) / 16777216 - 1;
  }

  /** Integer in [0, n). Modulo bias is accepted: n is always tiny here. */
  below(n: number): number {
    return this.u32() % n;
  }

  /** How many draws this cursor has taken — asserted in determinism tests. */
  get drawn(): number {
    return this.index;
  }
}

export function rngFor(
  matchSeed: number,
  tick: number,
  entityId: number,
  salt: RngStream | number,
): Rng {
  return new Rng(matchSeed, tick, entityId, salt);
}
