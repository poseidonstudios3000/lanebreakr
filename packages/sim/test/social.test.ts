import { describe, it, expect } from 'vitest';
import { createWorld, tick, makeApplyDamage, hashState, type World } from '../src/world.js';
import { Action, Btn, Team, isEmote, isPing, type PlayerInput } from '../src/types.js';
import { SPINE } from '../src/balance.js';
import { applyAction, stepSocial, visiblePings, SOCIAL, cancelEmote } from '../src/systems/social.js';

/**
 * Emotes and pings.
 *
 * The stated goal is "a mix of fun with friends", with communication and emotes
 * called out as very important — so this is the first system built for the
 * social layer rather than for the match. The tests that matter here are the
 * three rules, not the feature: one shared budget, pings are team-only, and
 * emoting must never cost you the fight.
 */

const MM = 1000;

function strip(): World {
  return createWorld(0x50c1a1, 'strip');
}

function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 2048, pitch: 0, buttons: 0, action: 0, fireSubTick: 0, ...over };
}

describe('emotes', () => {
  it('play, then expire', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    expect(applyAction(w.state, h, input({ action: Action.EmoteDance }), w.map.boxes)).toBe(true);
    expect(h.emote).toBe(Action.EmoteDance);
    expect(h.emoteTicksLeft).toBe(SOCIAL.EMOTE_TICKS);

    for (let i = 0; i < SOCIAL.EMOTE_TICKS + 1; i++) stepSocial(w.state);
    expect(h.emote).toBe(Action.None);
  });

  it('do NOT root you — emoting must never cost you the fight', () => {
    // A rooted emote is a death sentence, and people simply stop using the
    // feature, which defeats the entire point of having it.
    expect(SOCIAL.EMOTE_BLOCKS_MOVEMENT).toBe(false);

    const w = strip();
    const h = w.state.heroes[0]!;
    h.px = 0; h.py = Math.round(0.05 * MM); h.pz = 40 * MM; h.vx = 0; h.vz = 0;
    for (let i = 0; i < 90; i++) tick(w, [input({ moveZ: 1, action: i === 0 ? Action.EmoteDance : 0 })]);
    expect(Math.abs(h.px / MM), 'a dancing hero should still be able to run').toBeGreaterThan(3);
  });

  it('cancel when you take damage', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    applyAction(w.state, h, input({ action: Action.EmoteTaunt }), w.map.boxes);
    expect(h.emoteTicksLeft).toBeGreaterThan(0);
    makeApplyDamage(w)(h.id, 1000, Team.B, 3);
    expect(h.emoteTicksLeft).toBe(0);
  });

  it('cancel when you shoot', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    applyAction(w.state, h, input({ action: Action.EmoteTaunt }), w.map.boxes);
    tick(w, [input({ buttons: Btn.Fire })]);
    expect(h.emoteTicksLeft).toBe(0);
  });

  it('are visible to everyone — taunting is the point', () => {
    // Deliberately NOT team-gated, unlike pings.
    const w = strip();
    const h = w.state.heroes[0]!;
    applyAction(w.state, h, input({ action: Action.EmoteTaunt }), w.map.boxes);
    // Anyone reading hero state sees it; there is no per-team filter to apply.
    expect(w.state.heroes[0]!.emote).toBe(Action.EmoteTaunt);
  });
});

describe('pings', () => {
  it('land where you are looking, not on your own feet', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.px = 0; h.py = 0; h.pz = 40 * MM; h.yaw = 2048; h.pitch = 0;
    expect(applyAction(w.state, h, input({ action: Action.PingEnemy }), w.map.boxes)).toBe(true);
    const p = w.state.pings[0]!;
    expect(Math.abs(p.px - h.px) / MM, 'a ping on your own feet communicates nothing').toBeGreaterThan(5);
  });

  it('are TEAM-ONLY — they are information, and information must not leak', () => {
    // §1.4 removes fog of war and makes pings the replacement, which makes an
    // enemy-visible ping a bug rather than a social feature.
    const w = strip();
    const a = w.state.heroes[0]!; // team A
    applyAction(w.state, a, input({ action: Action.PingEnemy }), w.map.boxes);
    expect(visiblePings(w.state, Team.A)).toHaveLength(1);
    expect(visiblePings(w.state, Team.B)).toHaveLength(0);
  });

  it('expire', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    applyAction(w.state, h, input({ action: Action.PingDanger }), w.map.boxes);
    for (let i = 0; i < SOCIAL.PING_TICKS + 2; i++) stepSocial(w.state);
    expect(visiblePings(w.state, Team.A)).toHaveLength(0);
  });
});

describe('the shared budget — one spam surface, one limit', () => {
  it('emotes and pings draw from the SAME budget', () => {
    // Two separate rate limits means the sum of both is the real limit and
    // nobody computed it.
    const w = strip();
    const h = w.state.heroes[0]!;
    let used = 0;
    for (let i = 0; i < SOCIAL.WHEEL_BUDGET * 3; i++) {
      const act = i % 2 === 0 ? Action.EmoteWave : Action.PingHelp;
      if (applyAction(w.state, h, input({ action: act }), w.map.boxes)) used++;
      for (let k = 0; k < SOCIAL.WHEEL_COOLDOWN_TICKS; k++) stepSocial(w.state);
    }
    // The budget refills during the cooldowns, so this is bounded rather than
    // exact — the assertion is that it is BOUNDED at all.
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(SOCIAL.WHEEL_BUDGET * 3);
  });

  it('enforces a cooldown between any two wheel uses', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    expect(applyAction(w.state, h, input({ action: Action.EmoteWave }), w.map.boxes)).toBe(true);
    expect(applyAction(w.state, h, input({ action: Action.PingHelp }), w.map.boxes)).toBe(false);
  });

  it('refills over time', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.wheelBudget = 0;
    h.wheelRefillIn = SOCIAL.WHEEL_REFILL_TICKS;
    for (let i = 0; i < SOCIAL.WHEEL_REFILL_TICKS + 2; i++) stepSocial(w.state);
    expect(h.wheelBudget).toBe(1);
  });

  it('refuses everything from a dead player', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.alive = false;
    expect(applyAction(w.state, h, input({ action: Action.EmoteDance }), w.map.boxes)).toBe(false);
  });
});

describe('wire and determinism', () => {
  it('emote and ping ids do not overlap', () => {
    for (let a = 0; a < 40; a++) {
      expect(isEmote(a) && isPing(a), `action ${a} is both`).toBe(false);
    }
    expect(isEmote(Action.EmoteWave)).toBe(true);
    expect(isEmote(Action.EmoteSit)).toBe(true);
    expect(isPing(Action.PingEnemy)).toBe(true);
    expect(isPing(Action.PingHelp)).toBe(true);
    expect(isEmote(Action.None)).toBe(false);
    expect(isPing(Action.None)).toBe(false);
  });

  it('every action id fits in one byte', () => {
    // The whole reason this is an `action` field rather than more button bits.
    for (const a of Object.values(Action).filter((v) => typeof v === 'number') as number[]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(256);
    }
  });

  it('social traffic keeps the world deterministic', () => {
    const go = (): number => {
      const w = strip();
      for (let t = 0; t < 3000; t++) {
        tick(w, [
          input({ seq: t, entityId: 0, moveZ: 1, action: t % 97 === 0 ? Action.EmoteDance : 0 }),
          input({ seq: t, entityId: 3, moveZ: 1, action: t % 131 === 0 ? Action.PingEnemy : 0 }),
        ]);
      }
      return hashState(w.state);
    };
    expect(go()).toBe(go());
  });

  it('cancelEmote is idempotent', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    cancelEmote(h);
    cancelEmote(h);
    expect(h.emote).toBe(Action.None);
    expect(h.emoteTicksLeft).toBe(0);
    void SPINE;
  });
});
