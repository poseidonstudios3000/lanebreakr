import { describe, it, expect } from 'vitest';
import {
  SPINE, ENTITY, MOVEMENT, CAMERA, COMBAT, ECONOMY, WORLD,
  waveScale, mantleDurationTicks, deathPenalty, respawnTicks, orbSouls,
  suddenDeathDecayPerTick,
} from '../src/balance.js';

/**
 * Balance invariants.
 *
 * Two independent cross-verifiers found eleven blocking contradictions across
 * the five derived domains — every one a case where two files both landed a
 * value and one silently won. These tests are the guard against that class of
 * failure recurring: they assert the properties the resolutions depend on, so
 * a future tuning pass that breaks one fails loudly instead of quietly.
 */

const WEAPONS = { SMG: COMBAT.SMG, RIFLE: COMBAT.RIFLE, SHOTGUN: COMBAT.SHOTGUN, LAUNCHER: COMBAT.LAUNCHER } as const;

describe('tick integrality — the 60Hz rule', () => {
  it('every *_TICKS constant is a non-negative integer', () => {
    const walk = (obj: unknown, path: string): void => {
      if (obj === null || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        if (typeof v === 'number' && /_TICKS?$/.test(k)) {
          expect(Number.isInteger(v), `${p} = ${v} is not an integer tick count`).toBe(true);
          expect(v, `${p} = ${v} is negative`).toBeGreaterThanOrEqual(0);
        } else if (typeof v === 'object') {
          walk(v, p);
        }
      }
    };
    for (const [name, root] of Object.entries({ SPINE, MOVEMENT, CAMERA, COMBAT, ECONOMY, WORLD })) {
      walk(root, name);
    }
  });

  it('every weapon fire interval divides evenly into 60Hz', () => {
    for (const [name, w] of Object.entries(WEAPONS)) {
      expect(Number.isInteger(w.FIRE_INTERVAL_TICKS), name).toBe(true);
      const rpm = (SPINE.SIM_HZ / w.FIRE_INTERVAL_TICKS) * 60;
      expect(Number.isInteger(rpm), `${name} → ${rpm} RPM is not a whole number`).toBe(true);
    }
  });

  it('the snapshot and visibility rates divide the sim rate', () => {
    expect(SPINE.SIM_HZ % SPINE.SNAPSHOT_INTERVAL_TICKS).toBe(0);
    expect(SPINE.SIM_HZ % SPINE.VISIBILITY_INTERVAL_TICKS).toBe(0);
  });

  it('mantle duration is an integer for every legal ledge height', () => {
    for (let h = MOVEMENT.MANTLE_MIN_HEIGHT_M; h <= MOVEMENT.MANTLE_MAX_HEIGHT_M + 1; h += 0.05) {
      const t = mantleDurationTicks(h);
      expect(Number.isInteger(t), `h=${h.toFixed(2)} → ${t}`).toBe(true);
      expect(t).toBeLessThanOrEqual(MOVEMENT.MANTLE_MAX_DURATION_TICKS);
    }
  });
});

describe('TTK band — §6.1, restated as a base-kit reference', () => {
  const perShot = (name: string, w: { DAMAGE: number }): number =>
    name === 'SHOTGUN' ? w.DAMAGE * COMBAT.SHOTGUN.PELLET_COUNT : w.DAMAGE;

  it('every weapon lands in band at the 700 HP reference', () => {
    for (const [name, w] of Object.entries(WEAPONS)) {
      const shots = Math.ceil(COMBAT.TTK_BENCH.TARGET_HP_PRIMARY / perShot(name, w));
      const ttk = ((shots - 1) * w.FIRE_INTERVAL_TICKS) / SPINE.SIM_HZ;
      expect(ttk, `${name} ${ttk.toFixed(3)}s`).toBeGreaterThanOrEqual(COMBAT.TTK_BENCH.BAND_MIN_S);
      expect(ttk, `${name} ${ttk.toFixed(3)}s`).toBeLessThanOrEqual(COMBAT.TTK_BENCH.BAND_MAX_S);
    }
  });

  it('no weapon exceeds the ceiling at the 1000 HP itemized cap', () => {
    for (const [name, w] of Object.entries(WEAPONS)) {
      const shots = Math.ceil(COMBAT.TTK_BENCH.TARGET_HP_CEILING / perShot(name, w));
      const ttk = ((shots - 1) * w.FIRE_INTERVAL_TICKS) / SPINE.SIM_HZ;
      expect(ttk, `${name} @1000HP ${ttk.toFixed(3)}s`).toBeLessThanOrEqual(COMBAT.TTK_BENCH.BAND_MAX_S_AT_CEILING);
    }
  });

  it('a fully-stacked shooter still cannot reach CoD TTK', () => {
    // The band is a base-kit reference; buffs and items are *supposed* to break
    // it downward — a power spike that does not spike is not one. This is the
    // floor that stops that becoming CoD's 0.3s.
    //
    // OVERPRESSURE is conditional (+20% only below 40% target HP), so the worst
    // case must be modelled in two segments. Modelling it as a flat +34% across
    // the whole bar overstates the stack and was my first mistake here.
    const flat = 0.14; // HOLLOWPOINT, always on
    const conditional = ECONOMY.ITEM_MAX_ADDITIVE_DAMAGE_SUM; // + OVERPRESSURE below 40%
    const hp = COMBAT.TTK_BENCH.TARGET_HP_PRIMARY;
    const rateBonus = 0.12 + 0.25; // HAIR TRIGGER + VOLT Overcharge, additive

    for (const [name, w] of Object.entries(WEAPONS)) {
      const base = perShot(name, w);
      const hiDmg = Math.trunc(base * (1 + flat));
      const loDmg = Math.trunc(base * (1 + conditional));
      const upper = hp * 0.6;
      const shotsUpper = Math.ceil(upper / hiDmg);
      const shotsLower = Math.ceil((hp - shotsUpper * hiDmg) / loDmg);
      const shots = shotsUpper + Math.max(0, shotsLower);
      const interval = w.FIRE_INTERVAL_TICKS / (1 + (name === 'SMG' ? rateBonus : 0.12));
      const ttk = ((shots - 1) * interval) / SPINE.SIM_HZ;
      expect(ttk, `${name} fully stacked ${ttk.toFixed(3)}s`).toBeGreaterThanOrEqual(COMBAT.TTK_BENCH.BUFFED_ITEMIZED_FLOOR_S);
    }
  });

  it('the shotgun headshot cap holds the 3-shot floor even vs a naked hero', () => {
    const s = COMBAT.SHOTGUN;
    const maxBlast = (s.PELLET_COUNT - s.HEADSHOT_PELLET_CAP) * s.DAMAGE
      + s.HEADSHOT_PELLET_CAP * Math.trunc(s.DAMAGE * s.HEADSHOT_MULT_OVERRIDE);
    expect(maxBlast).toBe(s.MAX_SHOT_DAMAGE_ALL_HEAD);
    // Two blasts must not kill 550, or the TTK is 0.667s — the CoD TTK §6.1 rejects.
    expect(2 * maxBlast).toBeLessThan(COMBAT.TTK_BENCH.TARGET_HP_FLOOR);
  });
});

describe('economy — Pillar P2 is enforced numerically', () => {
  it('passive income is at most 25% of the per-player target', () => {
    const grantsPerMatch = Math.floor(SPINE.MATCH_TARGET_TICKS / ECONOMY.PASSIVE_GRANT_INTERVAL_TICKS);
    const passive = grantsPerMatch * ECONOMY.PASSIVE_GRANT_SOULS;
    expect(passive).toBeCloseTo(ECONOMY.PASSIVE_TOTAL_PER_PLAYER, -1);
    expect(passive / ECONOMY.TARGET_GROSS_PER_PLAYER).toBeLessThanOrEqual(0.25);
  });

  it('all orbs in a match out-earn all passive income, by team', () => {
    // This is the property PRD v1.0 got backwards by a factor of ~2.6.
    const waves = Math.floor((SPINE.MATCH_TARGET_TICKS - WORLD.TROOPERS.FIRST_WAVE_TICK) / WORLD.TROOPERS.WAVE_INTERVAL_TICKS) + 1;
    const orbsPerTeam = waves * WORLD.TROOPERS.UNITS_PER_WAVE;
    const midMinute = Math.floor(waves / 2 / (60 / (WORLD.TROOPERS.WAVE_INTERVAL_TICKS / SPINE.SIM_HZ)));
    const avgClaim = ECONOMY.ORB_CLAIM_BY_MINUTE[Math.min(midMinute, ECONOMY.ORB_VALUE_MINUTE_CLAMP)]!;
    const orbTeamTotal = orbsPerTeam * avgClaim;
    const passiveTeamTotal = ECONOMY.PASSIVE_TOTAL_PER_PLAYER * 3;
    expect(orbTeamTotal).toBeGreaterThan(passiveTeamTotal);
  });

  it('deny is exactly half of claim at every minute', () => {
    for (let m = 0; m <= ECONOMY.ORB_VALUE_MINUTE_CLAMP; m++) {
      const c = ECONOMY.ORB_CLAIM_BY_MINUTE[m]!;
      const d = ECONOMY.ORB_DENY_BY_MINUTE[m]!;
      expect(c % 2, `claim ${c} at minute ${m} is odd — halving is not exact`).toBe(0);
      expect(d).toBe(c / 2);
    }
  });

  it('every archetype can claim an orb, and none trivially', () => {
    const shots = {
      SMG: Math.ceil(ECONOMY.ORB_HP / ECONOMY.ORB_DAMAGE_SMG),
      RIFLE: Math.ceil(ECONOMY.ORB_HP / ECONOMY.ORB_DAMAGE_RIFLE),
      SHOTGUN: 1,
      LAUNCHER: 1,
    };
    // The blocking bug: weapons' table against economy's pool left the Launcher
    // (110 < 120) and Shotgun (8×13 = 104 < 120) unable to claim at all.
    expect(ECONOMY.ORB_DAMAGE_LAUNCHER_DIRECT).toBeGreaterThanOrEqual(ECONOMY.ORB_HP);
    expect(ECONOMY.ORB_DAMAGE_SHOTGUN_PER_PELLET * COMBAT.SHOTGUN.PELLET_COUNT).toBeGreaterThanOrEqual(ECONOMY.ORB_HP);
    expect(ECONOMY.ORB_DAMAGE_MELEE).toBeGreaterThanOrEqual(ECONOMY.ORB_HP);

    // Committed time must be a real spread, and every claim must fit the window.
    const committed = {
      SMG: (shots.SMG - 1) * COMBAT.SMG.FIRE_INTERVAL_TICKS,
      RIFLE: (shots.RIFLE - 1) * COMBAT.RIFLE.FIRE_INTERVAL_TICKS,
      SHOTGUN: 0,
      LAUNCHER: 0,
    };
    for (const [name, t] of Object.entries(committed)) {
      expect(t, `${name} claim takes ${t} ticks`).toBeLessThan(ECONOMY.ORB_HOVER_TICKS - ECONOMY.ORB_ARM_DELAY_TICKS);
    }
    expect(committed.RIFLE).toBeGreaterThan(committed.SMG); // slower weapons commit longer
  });

  it('splash cannot claim orbs — §7.1 mini-duel protection', () => {
    expect(ECONOMY.ORB_DAMAGE_LAUNCHER_SPLASH).toBe(0);
    expect(ECONOMY.ORB_DAMAGE_ABILITY).toBe(0);
  });

  it("the shotgun's orb wall is where the falloff curve says it is", () => {
    const s = COMBAT.SHOTGUN;
    const blast = ECONOMY.ORB_DAMAGE_SHOTGUN_PER_PELLET * s.PELLET_COUNT;
    const needed = ECONOMY.ORB_HP / blast; // required falloff multiplier
    const wall = s.FALLOFF_START_M + (needed - 1) / ((s.FALLOFF_END_MULT - 1) / (s.FALLOFF_END_M - s.FALLOFF_START_M));
    expect(wall).toBeCloseTo(ECONOMY.SHOTGUN_ORB_WALL_M, 1);
  });

  it('the death penalty is progressive, never regressive', () => {
    let prevRate = -1;
    for (const unspent of [500, 1000, 1500, 2000, 2600, 3200, 4000]) {
      const rate = deathPenalty(unspent) / unspent;
      expect(rate, `rate fell at ${unspent} unspent`).toBeGreaterThanOrEqual(prevRate);
      prevRate = rate;
    }
    // The cap must not bind inside a reachable balance, or it goes regressive again.
    expect(deathPenalty(ECONOMY.TARGET_GROSS_PER_PLAYER)).toBeLessThan(ECONOMY.DEATH_PENALTY_MAX);
  });

  it('the item ladder is reachable but a full T3 build is not', () => {
    const t = ECONOMY.UPGRADE_TIER_COST;
    expect(t[3]! * ECONOMY.UPGRADE_SLOTS).toBe(ECONOMY.UPGRADE_FULL_T3_BUILD_COST);
    expect(ECONOMY.UPGRADE_FULL_T3_BUILD_COST).toBeGreaterThan(ECONOMY.TARGET_GROSS_PER_PLAYER);
    expect(ECONOMY.UPGRADE_STRONG_GAME_BUILD_COST).toBeLessThan(ECONOMY.TARGET_GROSS_PER_PLAYER);
    // Purchase cadence: 9+ buys across the match, no dead zone.
    expect(ECONOMY.TARGET_GROSS_PER_PLAYER / t[1]!).toBeGreaterThanOrEqual(9);
  });

  it('there are exactly 12 upgrades, 4 per tier, with unique ids', () => {
    expect(ECONOMY.UPGRADES).toHaveLength(ECONOMY.UPGRADE_COUNT);
    for (const tier of [1, 2, 3]) {
      expect(ECONOMY.UPGRADES.filter((u) => u.TIER === tier), `tier ${tier}`).toHaveLength(4);
    }
    const ids = new Set(ECONOMY.UPGRADES.map((u) => u.ID));
    expect(ids.size).toBe(ECONOMY.UPGRADE_COUNT);
    for (const u of ECONOMY.UPGRADES) {
      expect(u.COST, u.ID).toBe(ECONOMY.UPGRADE_TIER_COST[u.TIER]);
    }
  });

  it('the HP ceiling is exactly reachable, and no higher', () => {
    const hpItems = ECONOMY.UPGRADES.filter((u) => 'MAX_HP_FLAT' in u.MODS);
    expect(hpItems).toHaveLength(ECONOMY.UPGRADE_SLOTS); // one per tier, so a full HP build is legal
    const stack = hpItems.reduce((s, u) => s + (u.MODS as { MAX_HP_FLAT: number }).MAX_HP_FLAT, 0);
    expect(SPINE.HERO_BASE_HP + stack).toBe(SPINE.HERO_ITEMIZED_HP_CEILING);
    expect(SPINE.HERO_BASE_HP + stack).toBe(ECONOMY.ITEM_MAX_HP_STACK);
  });

  it('bounty thresholds are reachable in a 12-minute match', () => {
    const killsForCap = ECONOMY.BOUNTY_CAP / ECONOMY.BOUNTY_PER_KILL;
    const killsForReveal = ECONOMY.BOUNTY_MINIMAP_REVEAL_AT / ECONOMY.BOUNTY_PER_KILL;
    expect(killsForCap).toBeLessThanOrEqual(6); // §7.4 needed 12 straight
    expect(killsForReveal).toBeLessThanOrEqual(2); // §7.4 needed 8
  });

  it('SURGE can reach its own exit condition', () => {
    // §9.5's +15% produced ~1,031 souls against a 1,300 swing it needed, so it
    // armed only in stomps and could never disarm.
    const swingNeeded = ECONOMY.SURGE_ARM_GAP - ECONOMY.SURGE_DISARM_GAP;
    const remainingS = SPINE.MATCH_TARGET_S - ECONOMY.SURGE_ARM_EARLIEST_TICK / SPINE.SIM_HZ;
    const contestableRate = (ECONOMY.TARGET_GROSS_PER_PLAYER - ECONOMY.PASSIVE_TOTAL_PER_PLAYER) * 3 / SPINE.MATCH_TARGET_S;
    const bonusFrac = ECONOMY.SURGE_INCOME_BONUS_NUM / ECONOMY.SURGE_INCOME_BONUS_DEN - 1;
    const generated = contestableRate * bonusFrac * remainingS;
    expect(generated, `SURGE generates ${generated.toFixed(0)} against a ${swingNeeded} swing`).toBeGreaterThan(swingNeeded);
  });
});

describe('structures and match length', () => {
  it('structure damage has exactly one source of truth', () => {
    // The global multiplier is deleted; only per-weapon values remain.
    expect('HERO_DAMAGE_MULT' in WORLD.STRUCTURES).toBe(false);
    for (const w of Object.values(WEAPONS)) expect(typeof w.STRUCTURE_DAMAGE_MULT).toBe('number');
    expect(COMBAT.FALLOFF_APPLIES_TO_STRUCTURES).toBe(false);
  });

  it('a 3-hero siege clears the structure pool inside the target window', () => {
    const s = COMBAT.TTK_BENCH.SUSTAINED_DPS;
    const m = WEAPONS;
    const perHero = [
      s.SMG * m.SMG.STRUCTURE_DAMAGE_MULT,
      s.RIFLE * m.RIFLE.STRUCTURE_DAMAGE_MULT,
      s.SHOTGUN * m.SHOTGUN.STRUCTURE_DAMAGE_MULT,
      s.LAUNCHER * m.LAUNCHER.STRUCTURE_DAMAGE_MULT,
    ];
    const mean = perHero.reduce((a, b) => a + b, 0) / perHero.length;
    expect(mean).toBeCloseTo(WORLD.MATCH_MODEL.MEAN_SUSTAINED_SIEGE_DPS, 0);

    const pool = WORLD.STRUCTURES.TOWER_T1_HP + WORLD.STRUCTURES.TOWER_T2_HP + WORLD.STRUCTURES.CORE_HP;
    const heroShare = pool * (1 - WORLD.MATCH_MODEL.EXPECTED_TROOPER_SIEGE_SHARE);
    const seconds = heroShare / (mean * 3) / WORLD.MATCH_MODEL.TARGET_HERO_SIEGE_UPTIME_FRAC;
    const [lo, hi] = WORLD.MATCH_MODEL.ACCEPT_BAND_S;
    expect(seconds, `predicted ${(seconds / 60).toFixed(1)} min`).toBeGreaterThan(lo!);
    expect(seconds, `predicted ${(seconds / 60).toFixed(1)} min`).toBeLessThan(hi!);
  });

  it('sudden death terminates: decay alone deletes a full core by the ceiling', () => {
    let hp = 1.0;
    let t = WORLD.SUDDEN_DEATH.START_TICK;
    while (hp > 0 && t < WORLD.SUDDEN_DEATH.START_TICK + SPINE.SIM_HZ * 600) {
      hp -= suddenDeathDecayPerTick(t, false);
      t++;
    }
    expect(hp).toBeLessThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(WORLD.SUDDEN_DEATH.HARD_CEILING_TICK);
  });

  it('the pit rim is exactly one mantle, and a pitched dash clears it', () => {
    expect(WORLD.MAP.PIT_DEPTH_M).toBeLessThanOrEqual(MOVEMENT.MANTLE_MAX_HEIGHT_M);
    const lift = MOVEMENT.DASH_DISTANCE_M * Math.sin((MOVEMENT.DASH_PITCH_CLAMP_DEG * Math.PI) / 180);
    expect(lift).toBeGreaterThan(WORLD.MAP.PIT_DEPTH_M);
  });

  it('wave 1 clashes over the MID PIT', () => {
    const gap = 2 * WORLD.MAP.TROOPER_SPAWN_X_ABS_M;
    const closingSpeed = 2 * WORLD.TROOPERS.MOVE_SPEED_MPS;
    const clashS = WORLD.TROOPERS.FIRST_WAVE_TICK / SPINE.SIM_HZ + gap / closingSpeed;
    expect(clashS).toBeCloseTo(54, 0);
    // …and before the boss spawns, so the first fight is over ground, not the objective itself.
    expect(clashS * SPINE.SIM_HZ).toBeLessThan(WORLD.PIT_BOSS.FIRST_SPAWN_TICK);
  });
});

describe('derived functions', () => {
  it('respawn is capped, floored by minute, and SURGE applies after the cap', () => {
    expect(respawnTicks(0, false, false)).toBe(480);
    expect(respawnTicks(SPINE.MINUTE_TICKS * 9, false, false)).toBe(1500);
    expect(respawnTicks(SPINE.MINUTE_TICKS * 20, false, false)).toBe(1500); // clamps past the table
    expect(respawnTicks(SPINE.MINUTE_TICKS * 9, true, false)).toBe(975); // 1500 × 13/20
    for (const m of [0, 3, 7, 9, 14]) {
      expect(Number.isInteger(respawnTicks(SPINE.MINUTE_TICKS * m, true, false)), `minute ${m}`).toBe(true);
    }
  });

  it('sudden-death respawn escalates uncapped', () => {
    expect(respawnTicks(SPINE.SUDDEN_DEATH_TICK, false, true, 0)).toBe(1800);
    expect(respawnTicks(SPINE.SUDDEN_DEATH_TICK, false, true, 3)).toBe(1800 + 3 * 360);
  });

  it('orb value ramps, clamps, and stays an integer under SURGE', () => {
    expect(orbSouls(0, false, false)).toBe(32);
    expect(orbSouls(0, true, false)).toBe(16);
    expect(orbSouls(SPINE.MINUTE_TICKS * 30, false, false)).toBe(88); // clamped
    for (let m = 0; m <= 14; m++) {
      const v = orbSouls(SPINE.MINUTE_TICKS * m, false, true);
      expect(Number.isInteger(v), `minute ${m} surged → ${v}`).toBe(true);
    }
  });

  it('wave scaling caps', () => {
    expect(waveScale(0)).toBe(1);
    expect(waveScale(100)).toBe(waveScale(WORLD.TROOPERS.SCALE_CAP_WAVE));
  });
});

describe('cross-domain invariants the verifiers caught', () => {
  it('the head hitbox is consistent with the capsule it sits in', () => {
    expect(ENTITY.HEAD_SPHERE_CENTER_M + ENTITY.HEAD_SPHERE_RADIUS_M).toBeLessThanOrEqual(ENTITY.CAPSULE_HEIGHT_M);
    expect(ENTITY.EYE_HEIGHT_M).toBeLessThanOrEqual(ENTITY.CAPSULE_HEIGHT_M);
  });

  it("the Rifle's ADS cone is smaller than a head at max range — a skill check, not a gift", () => {
    const r = COMBAT.RIFLE;
    const coneRadiusAtFalloffEnd = r.FALLOFF_END_M * Math.tan((r.ADS_SPREAD_DEG * Math.PI) / 180);
    expect(coneRadiusAtFalloffEnd).toBeGreaterThan(ENTITY.HEAD_SPHERE_RADIUS_M * 0.5);
  });

  it('slide entry speed is unreachable from ADS', () => {
    expect(MOVEMENT.BASE_SPEED_MPS * MOVEMENT.ADS_SPEED_MULT).toBeLessThan(MOVEMENT.SLIDE_MIN_ENTRY_SPEED_MPS);
  });

  it('vault and mantle bands are contiguous with no gap or overlap', () => {
    expect(MOVEMENT.VAULT_MAX_HEIGHT_M).toBe(MOVEMENT.MANTLE_MIN_HEIGHT_M);
    expect(MOVEMENT.VAULT_MIN_HEIGHT_M).toBe(MOVEMENT.STEP_HEIGHT_M);
  });

  it('TPS carries no accuracy penalty (§5.1 rework)', () => {
    expect(CAMERA.TPS_HIPFIRE_SPREAD_MULT).toBe(1.0);
  });
});
