import { describe, it, expect } from 'vitest';
import { createWorld, tick, hashState } from '../src/world.js';
import { Btn, YAW_STEPS, type PlayerInput } from '../src/types.js';
import { rngU32 } from '../src/rng.js';
import * as mathd from '../src/mathd.js';

/**
 * PRD §12/M1: "same seed + same input log -> identical 10,000-tick state hash".
 * The cross-engine half of that criterion runs in CI via Playwright; this is
 * the same-engine gate the RALPH loop runs every iteration.
 */

/** A deterministic, varied input log — movement, look, fire, dash, jump, slide. */
function scriptedInput(t: number): PlayerInput {
  const buttons =
    (t % 7 === 0 ? Btn.Fire : 0) |
    (t % 97 === 0 ? Btn.Dash : 0) |
    (t % 53 === 0 ? Btn.Jump : 0) |
    (t % 211 === 0 ? Btn.Slide : 0) |
    (t % 401 === 0 ? Btn.Reload : 0) |
    (t % 631 === 0 ? Btn.CameraToggle : 0) |
    (t % 29 < 14 ? Btn.Ads : 0);
  return {
    seq: t,
    entityId: 0,
    moveX: ((t / 31) | 0) % 3 - 1,
    moveZ: ((t / 17) | 0) % 3 - 1,
    yaw: (t * 13) % YAW_STEPS,
    pitch: ((t * 7) % 800) - 400,
    buttons,
    fireSubTick: t % 32,
  };
}

function runTo(ticks: number, seed: number): number {
  const w = createWorld(seed);
  for (let t = 0; t < ticks; t++) tick(w, [scriptedInput(t)]);
  return hashState(w.state);
}

describe('determinism', () => {
  it('produces an identical 10,000-tick state hash across runs', () => {
    const a = runTo(10_000, 0xc0ffee);
    const b = runTo(10_000, 0xc0ffee);
    expect(b).toBe(a);
  });

  it('diverges on a different seed (the test can actually fail)', () => {
    // A determinism test that passes for a constant is not a test.
    const a = runTo(2_000, 1);
    const b = runTo(2_000, 2);
    expect(b).not.toBe(a);
  });

  it('keeps every state field integral', () => {
    const w = createWorld(42);
    for (let t = 0; t < 3_000; t++) tick(w, [scriptedInput(t)]);
    const h = w.state.heroes[0]!;
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'number') {
        expect(Number.isInteger(v), `hero.${k} = ${v} is not an integer`).toBe(true);
        expect(Number.isFinite(v), `hero.${k} = ${v} is not finite`).toBe(true);
      }
    }
  });

  it('rng is stateless: draw order never affects a draw', () => {
    const forward = [0, 1, 2, 3, 4].map((i) => rngU32(7, 100, 3, 2, i));
    const backward = [4, 3, 2, 1, 0].map((i) => rngU32(7, 100, 3, 2, i)).reverse();
    expect(backward).toEqual(forward);
  });
});

describe('mathd', () => {
  it('agrees with Math.sin/cos to 1e-12 over a full turn', () => {
    let worst = 0;
    for (let i = 0; i < 4096; i++) {
      const x = (i / 4096) * mathd.TAU * 3 - mathd.TAU;
      worst = Math.max(worst, Math.abs(mathd.sin(x) - Math.sin(x)));
      worst = Math.max(worst, Math.abs(mathd.cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('agrees with Math.atan2 to 1e-12', () => {
    let worst = 0;
    for (let i = -32; i <= 32; i++) {
      for (let j = -32; j <= 32; j++) {
        if (i === 0 && j === 0) continue;
        worst = Math.max(worst, Math.abs(mathd.atan2(i, j) - Math.atan2(i, j)));
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('powi is exact where Math.pow need not be', () => {
    expect(mathd.powi(2, 10)).toBe(1024);
    expect(mathd.powi(3, 5)).toBe(243);
    expect(mathd.powi(2, -2)).toBe(0.25);
  });
});
