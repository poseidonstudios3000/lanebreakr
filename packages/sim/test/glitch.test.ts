import { describe, it, expect } from 'vitest';
import { createWorld, tick, makeApplyDamage, hashState, type World } from '../src/world.js';
import { Btn, Team, type PlayerInput } from '../src/types.js';
import { SPINE, GLITCH } from '../src/balance.js';
import { castGlitch, stepGlitch, scrambleInput, isGlitched } from '../src/systems/glitch.js';

/**
 * GLITCH BOMB.
 *
 * These tests are mostly not about whether it works — they are about whether it
 * stays inside the bar in docs/DIRECTION.md §0. Removing a player's control is
 * beloved when it is short, telegraphed, survivable and scrambling, and hated
 * when it is long, silent, lethal or freezing. Each of those four is a test,
 * because each is a line someone will cross later while "making it feel
 * stronger".
 */

const MM = 1000;

function strip(): World {
  return createWorld(0x9117c4, 'strip');
}

function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 2048, pitch: 0, buttons: 0, action: 0, fireSubTick: 0, ...over };
}

describe('glitch bomb — the mechanic', () => {
  it('throws, arms on a fuse, then detonates', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    expect(castGlitch(w.state, h, w.map.boxes)).toBe(true);
    expect(w.state.glitches).toHaveLength(1);
    expect(w.state.glitches[0]!.armTicksLeft).toBe(GLITCH.ARM_TICKS);

    const apply = makeApplyDamage(w);
    for (let i = 0; i < GLITCH.ARM_TICKS; i++) stepGlitch(w.state, apply);
    expect(w.state.glitches[0]!.armTicksLeft).toBe(0);
  });

  it('glitches enemies in radius and never allies', () => {
    const w = strip();
    const thrower = w.state.heroes[0]!; // team A
    const ally = w.state.heroes[1]!;
    const enemy = w.state.heroes[3]!; // team B
    // Aim DOWN, so the bomb lands at your feet rather than flying its full 28m
    // — which is also how you use it defensively when someone is on top of you.
    thrower.px = 0; thrower.py = 0; thrower.pz = 0; thrower.yaw = 2048; thrower.pitch = -1024;
    enemy.px = 2 * MM; enemy.py = 0; enemy.pz = 0;
    ally.px = 2 * MM; ally.py = 0; ally.pz = 1 * MM;

    castGlitch(w.state, thrower, w.map.boxes);
    const apply = makeApplyDamage(w);
    for (let i = 0; i <= GLITCH.ARM_TICKS; i++) stepGlitch(w.state, apply);

    expect(isGlitched(enemy), 'enemy in radius should be glitched').toBe(true);
    expect(isGlitched(ally), 'ally must never be glitched').toBe(false);
    expect(isGlitched(thrower)).toBe(false);
  });

  it('misses enemies outside the radius', () => {
    const w = strip();
    const thrower = w.state.heroes[0]!;
    const enemy = w.state.heroes[3]!;
    thrower.px = 0; thrower.py = 0; thrower.pz = 0; thrower.yaw = 2048; thrower.pitch = -1024;
    enemy.px = Math.round((GLITCH.RADIUS_M + 6) * MM); enemy.py = 0; enemy.pz = 0;

    castGlitch(w.state, thrower, w.map.boxes);
    const apply = makeApplyDamage(w);
    for (let i = 0; i <= GLITCH.ARM_TICKS; i++) stepGlitch(w.state, apply);
    expect(isGlitched(enemy)).toBe(false);
  });

  it('respects its cooldown', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    expect(castGlitch(w.state, h, w.map.boxes)).toBe(true);
    expect(castGlitch(w.state, h, w.map.boxes), 'second cast should be refused').toBe(false);
    expect(h.abilityQCooldown).toBe(GLITCH.COOLDOWN_TICKS);
  });

  it('refreshes rather than stacks', () => {
    // Two bombs must not mean 3.6s of flailing.
    const w = strip();
    const enemy = w.state.heroes[3]!;
    enemy.glitchTicksLeft = 40;
    const thrower = w.state.heroes[0]!;
    thrower.px = 0; thrower.py = 0; thrower.pz = 0; thrower.yaw = 2048; thrower.pitch = -1024;
    enemy.px = 2 * MM; enemy.py = 0; enemy.pz = 0;

    castGlitch(w.state, thrower, w.map.boxes);
    const apply = makeApplyDamage(w);
    for (let i = 0; i <= GLITCH.ARM_TICKS; i++) stepGlitch(w.state, apply);
    // Refreshed to full (minus the tick it was applied on), never 40 + 108.
    expect(enemy.glitchTicksLeft).toBeGreaterThan(GLITCH.DURATION_TICKS - 3);
    expect(enemy.glitchTicksLeft).toBeLessThanOrEqual(GLITCH.DURATION_TICKS);
  });
});

describe('glitch bomb — the design bar it must not cross', () => {
  it('is SHORT: under two seconds', () => {
    // Long enough to lose a duel, short enough not to resent.
    expect(GLITCH.DURATION_TICKS / SPINE.SIM_HZ).toBeLessThanOrEqual(2.0);
    expect(GLITCH.DURATION_TICKS / SPINE.SIM_HZ).toBeGreaterThanOrEqual(1.2);
  });

  it('is TELEGRAPHED: a real fuse, not an instant hit', () => {
    // Being hit has to be a read you lost, not a thing that happened to you.
    expect(GLITCH.ARM_TICKS / SPINE.SIM_HZ).toBeGreaterThanOrEqual(0.5);
  });

  it('is NON-LETHAL alone: it cannot kill from any survivable HP', () => {
    // It creates the opening; someone still has to take it.
    const bombsInOneLife = Math.ceil(SPINE.HERO_BASE_HP / Math.max(1, GLITCH.DAMAGE));
    expect(bombsInOneLife).toBeGreaterThan(20);
    expect(GLITCH.DAMAGE * SPINE.DAMAGE_SCALE).toBeLessThan(SPINE.HERO_BASE_HP * SPINE.DAMAGE_SCALE * 0.05);
  });

  it('SCRAMBLES rather than freezes — you can still move and still shoot', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.glitchTicksLeft = GLITCH.DURATION_TICKS;
    h.glitchSeed = 12345;

    let anyMovement = false;
    let firePreserved = true;
    for (let t = 0; t < GLITCH.DURATION_TICKS; t++) {
      w.state.tick = t;
      const out = scrambleInput(w.state, h, input({ moveX: 1, moveZ: 1, buttons: Btn.Fire }));
      if (out.moveX !== 0 || out.moveZ !== 0) anyMovement = true;
      if ((out.buttons & Btn.Fire) === 0) firePreserved = false;
    }
    expect(anyMovement, 'a glitched player must never be frozen').toBe(true);
    expect(firePreserved, 'being unable to shoot back is the un-fun version').toBe(true);
    expect(GLITCH.BLOCKS_FIRE).toBe(false);
  });

  it('denies the dash — that is the counterplay being taken away', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.glitchTicksLeft = GLITCH.DURATION_TICKS;
    const out = scrambleInput(w.state, h, input({ buttons: Btn.Dash | Btn.Fire }));
    expect(out.buttons & Btn.Dash).toBe(0);
    expect(out.buttons & Btn.Fire).toBe(Btn.Fire);
  });

  it('actually changes the controls — the mapping is not the identity', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.glitchTicksLeft = GLITCH.DURATION_TICKS;
    h.glitchSeed = 777;
    let changed = 0;
    for (let t = 0; t < GLITCH.DURATION_TICKS; t++) {
      w.state.tick = t;
      h.glitchTicksLeft = GLITCH.DURATION_TICKS - t;
      const src = input({ moveX: 1, moveZ: 0 });
      const out = scrambleInput(w.state, h, src);
      if (out.moveX !== src.moveX || out.moveZ !== src.moveZ) changed++;
    }
    expect(changed, 'the scramble never altered the input').toBeGreaterThan(GLITCH.DURATION_TICKS * 0.5);
  });

  it('does nothing at all to a player who is not glitched', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    const src = input({ moveX: 1, moveZ: -1, buttons: Btn.Dash | Btn.Fire });
    expect(scrambleInput(w.state, h, src)).toEqual(src);
  });

  it('the scramble is deterministic — the flailing reproduces in a replay', () => {
    // The flailing IS the clip, and a clip that does not reproduce is not one.
    const sample = (): string => {
      const w = strip();
      const h = w.state.heroes[0]!;
      h.glitchSeed = 4242;
      const out: string[] = [];
      for (let t = 0; t < 60; t++) {
        w.state.tick = t;
        h.glitchTicksLeft = GLITCH.DURATION_TICKS - t;
        const o = scrambleInput(w.state, h, input({ moveX: 1, moveZ: 1 }));
        out.push(`${o.moveX},${o.moveZ},${o.yaw}`);
      }
      return out.join('|');
    };
    expect(sample()).toBe(sample());
  });

  it('keeps the whole world deterministic when bombs are flying', () => {
    const go = (): number => {
      const w = strip();
      for (let t = 0; t < 4000; t++) {
        const buttons = t % 400 === 0 ? Btn.AbilityQ : (t % 9 === 0 ? Btn.Fire : 0);
        tick(w, [
          { seq: t, entityId: 0, moveX: (t % 7) - 3, moveZ: 1, yaw: (t * 11) % 8192, pitch: 0, buttons, fireSubTick: 0 },
          { seq: t, entityId: 3, moveX: 0, moveZ: 1, yaw: (t * 5) % 8192, pitch: 0, buttons: t % 500 === 0 ? Btn.AbilityQ : 0, action: 0, fireSubTick: 0 },
        ]);
      }
      return hashState(w.state);
    };
    expect(go()).toBe(go());
  });

  it('accessibility: the mechanical penalty is separable from the visuals', () => {
    // Input scramble and heavy screen distortion cause real problems for
    // motion-sensitive and motor-impaired players. "Turn off the effect" must
    // not mean "turn off the game", so the sim owns the mechanic and the client
    // owns the distortion.
    expect(GLITCH.REDUCED_EFFECTS_KEEPS_MECHANIC).toBe(true);
  });

  it('abilities never touch soul orbs', () => {
    // §7's contest is a gunplay mechanic or it is nothing.
    const w = strip();
    const before = w.state.orbs.length;
    const h = w.state.heroes[0]!;
    h.pitch = -1024;
    castGlitch(w.state, h, w.map.boxes);
    const apply = makeApplyDamage(w);
    for (let i = 0; i <= GLITCH.ARM_TICKS; i++) stepGlitch(w.state, apply);
    expect(w.state.orbs.length).toBe(before);
  });

  it('a glitched player is measurably worse at going where they meant to', () => {
    // The whole point, expressed as a number: same input, different outcome.
    const clean = createWorld(5, 'strip');
    const dirty = createWorld(5, 'strip');
    const ch = clean.state.heroes[0]!;
    const dh = dirty.state.heroes[0]!;
    for (const h of [ch, dh]) { h.px = 0; h.py = Math.round(0.05 * MM); h.pz = 0; h.vx = 0; h.vz = 0; }
    dh.glitchTicksLeft = 100000;
    dh.glitchSeed = 99;

    const drive: PlayerInput = input({ moveZ: 1, yaw: 2048 });
    for (let t = 0; t < 120; t++) { tick(clean, [drive]); tick(dirty, [drive]); }

    const cleanX = ch.px / MM;
    const dirtyX = dh.px / MM;
    expect(cleanX, 'clean run should travel +X').toBeGreaterThan(5);
    expect(Math.abs(dirtyX), 'glitched run should not track the intent').toBeLessThan(Math.abs(cleanX));
    void Team;
  });
});
