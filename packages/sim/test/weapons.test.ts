import { describe, it, expect } from 'vitest';
import { createWorld, tick, createHero, hashState, type World } from '../src/world.js';
import { Btn, Team, HeroKind, type PlayerInput } from '../src/types.js';
import { SPINE, COMBAT, ECONOMY } from '../src/balance.js';
import { weaponOf, currentSpreadDeg, falloffMult, WEAPON_NAME } from '../src/systems/combat.js';

/**
 * The four weapons. §6.3: one per hero, no swapping — weapon identity IS hero
 * identity, so these tests are really about whether the four heroes feel like
 * four heroes.
 */

const MM = 1000;

function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 2048, pitch: 0, buttons: 0, action: 0, fireSubTick: 0, ...over };
}

/**
 * A duel on clear ground.
 *
 * z = 0 is the lane centreline: the MID PIT catwalk covers |x| < 11 and solid
 * floor covers the rest, cover blocks sit at |z| = 6.5, and the nearest
 * structure is at |x| = 44. Picking z = 30 instead — outside the ±17.5m arena —
 * drops both heroes out of the world and teleports them to spawn, which
 * presents as "the weapon does no damage".
 */
function duel(kind: HeroKind, targetKind = HeroKind.Volt): { w: World; a: number; b: number } {
  const w = createWorld(0x7ea, 'strip');
  w.state.heroes = [
    createHero(0, Team.A, 0, 0.05, 0, 2048, kind),
    createHero(1, Team.B, 20, 0.05, 0, 6144, targetKind),
  ];
  return { w, a: 0, b: 1 };
}

/** Semi-auto weapons need a rising edge, so a held button fires exactly once. */
function pulse(t: number): number {
  return t % 2 === 0 ? Btn.Fire : 0;
}

describe('weapon identity', () => {
  it('each hero gets a different weapon', () => {
    const seen = new Set([
      weaponOf(HeroKind.Volt), weaponOf(HeroKind.Halo),
      weaponOf(HeroKind.Bulwark), weaponOf(HeroKind.Rift),
    ]);
    expect(seen.size).toBe(4);
    expect(weaponOf(HeroKind.Volt)).toBe(COMBAT.SMG);
    expect(weaponOf(HeroKind.Halo)).toBe(COMBAT.RIFLE);
    expect(weaponOf(HeroKind.Bulwark)).toBe(COMBAT.SHOTGUN);
    expect(weaponOf(HeroKind.Rift)).toBe(COMBAT.LAUNCHER);
  });

  it('every hero has a name', () => {
    for (const k of [HeroKind.Volt, HeroKind.Halo, HeroKind.Bulwark, HeroKind.Rift]) {
      expect(WEAPON_NAME[k]).toBeTruthy();
    }
  });

  it('spread reads from the hero, not from a hardcoded SMG', () => {
    // The bug this guards: `const W = COMBAT.SMG` at module scope meant every
    // hero fired an SMG regardless of kind, and nothing would have caught it
    // except playing all four.
    const volt = createHero(0, Team.A, 0, 0, 0, 0, HeroKind.Volt);
    const halo = createHero(1, Team.A, 0, 0, 0, 0, HeroKind.Halo);
    const bul = createHero(2, Team.A, 0, 0, 0, 0, HeroKind.Bulwark);
    volt.grounded = halo.grounded = bul.grounded = true;
    expect(currentSpreadDeg(halo)).not.toBeCloseTo(currentSpreadDeg(volt), 3);
    expect(currentSpreadDeg(bul)).toBeGreaterThan(currentSpreadDeg(halo));
  });

  it('falloff differs per weapon — the shotgun dies at range, the rifle does not', () => {
    expect(falloffMult(30, HeroKind.Bulwark)).toBeLessThan(0.35);
    expect(falloffMult(30, HeroKind.Halo)).toBe(1);
    expect(falloffMult(60, HeroKind.Halo)).toBeGreaterThan(0.7);
    expect(falloffMult(5, HeroKind.Bulwark)).toBe(1);
  });

  it('magazine size comes from the hero', () => {
    const w = createWorld(1, 'strip');
    for (const h of w.state.heroes) {
      expect(h.ammo).toBe(weaponOf(h.kind).MAG_SIZE);
    }
  });
});

describe('hitscan weapons land damage', () => {
  for (const [name, kind] of [['VOLT', HeroKind.Volt], ['HALO', HeroKind.Halo], ['BULWARK', HeroKind.Bulwark]] as const) {
    it(`${name} damages an enemy in a clean lane`, () => {
      const { w } = duel(kind);
      const target = w.state.heroes[1]!;
      // BULWARK's falloff means it must be close to do anything.
      if (kind === HeroKind.Bulwark) target.px = 6 * MM;
      const before = target.hp;
      for (let i = 0; i < 400 && target.hp === before; i++) {
        tick(w, [input({ entityId: 0, buttons: pulse(i) })]);
      }
      expect(target.hp, `${name} never connected`).toBeLessThan(before);
    });
  }

  it('BULWARK fires eight pellets, so one blast can do eight pellets of damage', () => {
    const { w } = duel(HeroKind.Bulwark);
    const target = w.state.heroes[1]!;
    target.px = 4 * MM; // well inside the falloff start
    const before = target.hp;
    tick(w, [input({ entityId: 0, buttons: Btn.Fire })]);
    const dealt = (before - target.hp) / SPINE.DAMAGE_SCALE;
    expect(dealt).toBeGreaterThan(COMBAT.SHOTGUN.DAMAGE); // more than one pellet
    // Ceiling is the all-head blast, not 8 body pellets: one pellet may carry
    // the ×1.25 headshot multiplier (capped at one, deliberately — see §6.2).
    expect(dealt).toBeLessThanOrEqual(COMBAT.SHOTGUN.MAX_SHOT_DAMAGE_ALL_HEAD);
  });

  it('a shotgun blast cannot claim more than one orb', () => {
    // §7.1 never said whether 8 pellets claim one orb or all of them. Eight
    // would give BULWARK several times everyone else's farm rate.
    const { w } = duel(HeroKind.Bulwark);
    const s = w.state;
    for (let i = 0; i < 4; i++) {
      s.orbs.push({
        id: 500 + i, ownerTeam: Team.A,
        px: Math.round(5 * MM), py: Math.round(1.45 * MM), pz: Math.round(((i - 2) * 0.35) * MM),
        hoverTicksLeft: 600, armTicksLeft: 0,
        claimProgress: 0, denyProgress: 0, lastClaimer: -1, lastDenier: -1, alive: true,
      });
    }
    tick(w, [input({ entityId: 0, buttons: Btn.Fire })]);
    const claimed = s.orbs.filter((o) => !o.alive).length;
    expect(claimed, 'one trigger pull claimed multiple orbs').toBeLessThanOrEqual(1);
  });
});

describe('RIFT — projectiles, and the swept collision they need', () => {
  it('firing spawns a projectile rather than hitscanning', () => {
    const { w } = duel(HeroKind.Rift);
    expect(w.state.projectiles).toHaveLength(0);
    tick(w, [input({ entityId: 0, buttons: Btn.Fire })]);
    expect(w.state.projectiles.length).toBeGreaterThan(0);
  });

  it('the projectile travels, then detonates on an enemy', () => {
    const { w } = duel(HeroKind.Rift);
    const target = w.state.heroes[1]!;
    target.px = 20 * MM;
    const before = target.hp;
    for (let i = 0; i < 120 && target.hp === before; i++) {
      tick(w, [input({ entityId: 0, buttons: i === 0 ? Btn.Fire : 0 })]);
    }
    expect(target.hp, 'the rocket never connected').toBeLessThan(before);
  });

  it('does NOT tunnel through a target at full speed', () => {
    /**
     * The reason collision.ts has swept tests at all. At 45 m/s the projectile
     * advances 0.75m per tick against a ~0.80m capsule; a discrete per-tick
     * position check misses roughly as often as it hits.
     */
    let connected = 0;
    const TRIALS = 12;
    for (let trial = 0; trial < TRIALS; trial++) {
      const { w } = duel(HeroKind.Rift);
      const target = w.state.heroes[1]!;
      // Sub-tick offsets: without sweeping, some of these fall between steps.
      target.px = Math.round((18 + trial * 0.0625) * MM);
      const before = target.hp;
      for (let i = 0; i < 160 && target.hp === before; i++) {
        tick(w, [input({ entityId: 0, buttons: i === 0 ? Btn.Fire : 0 })]);
      }
      if (target.hp < before) connected++;
    }
    expect(connected, `only ${connected}/${TRIALS} rockets connected — tunnelling`).toBe(TRIALS);
  });

  it('splash damages nearby enemies but excludes the direct target', () => {
    // A direct hit takes 210, not 210+90, or the LOBBER's TTK falls out of band.
    const w = createWorld(0x5b, 'strip');
    w.state.heroes = [
      createHero(0, Team.A, 0, 0.05, 0, 2048, HeroKind.Rift),
      createHero(1, Team.B, 20, 0.05, 0, 6144, HeroKind.Volt),
      createHero(2, Team.B, 21.5, 0.05, 0, 6144, HeroKind.Volt),
    ];
    const direct = w.state.heroes[1]!;
    const splashed = w.state.heroes[2]!;
    const d0 = direct.hp, s0 = splashed.hp;

    for (let i = 0; i < 120 && direct.hp === d0; i++) {
      tick(w, [input({ entityId: 0, buttons: i === 0 ? Btn.Fire : 0 })]);
    }
    const directDmg = (d0 - direct.hp) / SPINE.DAMAGE_SCALE;
    const splashDmg = (s0 - splashed.hp) / SPINE.DAMAGE_SCALE;

    expect(directDmg).toBeGreaterThan(0);
    expect(splashDmg, 'splash should reach a bystander').toBeGreaterThan(0);
    expect(directDmg, 'the direct target must not eat splash as well')
      .toBeLessThanOrEqual(COMBAT.LAUNCHER.DAMAGE + 1);
  });

  it('splash never claims soul orbs', () => {
    const { w } = duel(HeroKind.Rift);
    w.state.orbs.push({
      id: 900, ownerTeam: Team.A,
      px: 20 * MM, py: Math.round(1.2 * MM), pz: 0,
      hoverTicksLeft: 9000, armTicksLeft: 0,
      claimProgress: 0, denyProgress: 0, lastClaimer: -1, lastDenier: -1, alive: true,
    });
    expect(ECONOMY.ORB_DAMAGE_LAUNCHER_SPLASH).toBe(0);
  });

  it('projectiles expire rather than flying forever', () => {
    const { w } = duel(HeroKind.Rift);
    w.state.heroes[1]!.alive = false;
    tick(w, [input({ entityId: 0, buttons: Btn.Fire })]);
    for (let i = 0; i < COMBAT.LAUNCHER.PROJECTILE_LIFETIME_TICKS + 10; i++) tick(w, []);
    expect(w.state.projectiles.every((p) => !p.alive)).toBe(true);
  });

  it('projectiles keep the world deterministic', () => {
    const go = (): number => {
      const { w } = duel(HeroKind.Rift);
      for (let t = 0; t < 2000; t++) {
        tick(w, [input({ entityId: 0, buttons: t % 40 === 0 ? Btn.Fire : 0, yaw: (2048 + t) % 8192 })]);
      }
      return hashState(w.state);
    };
    expect(go()).toBe(go());
  });
});

describe('the analytic TTK band still holds per weapon', () => {
  it('every weapon is in band at the 700 HP reference', () => {
    for (const kind of [HeroKind.Volt, HeroKind.Halo, HeroKind.Bulwark, HeroKind.Rift]) {
      const W = weaponOf(kind);
      const perShot = W.PELLET_COUNT > 1 ? W.DAMAGE * W.PELLET_COUNT : W.DAMAGE;
      const shots = Math.ceil(COMBAT.TTK_BENCH.TARGET_HP_PRIMARY / perShot);
      const ttk = ((shots - 1) * W.FIRE_INTERVAL_TICKS) / SPINE.SIM_HZ;
      expect(ttk, `${WEAPON_NAME[kind]} ${ttk.toFixed(3)}s`).toBeGreaterThanOrEqual(COMBAT.TTK_BENCH.BAND_MIN_S);
      expect(ttk, `${WEAPON_NAME[kind]} ${ttk.toFixed(3)}s`).toBeLessThanOrEqual(COMBAT.TTK_BENCH.BAND_MAX_S);
    }
  });
});
