import { describe, it, expect } from 'vitest';
import { createWorld, tick, createHero, type World } from '../src/world.js';
import { Btn, MoveState, CameraMode, Team, type PlayerInput } from '../src/types.js';
import { currentSpreadDeg } from '../src/systems/combat.js';
import { MOVEMENT, COMBAT, CAMERA, SPINE, M0 } from '../src/balance.js';

/**
 * A firing lane with no geometry in it, running from x = −38 to x = 0.
 *
 * The grey box is deliberately dense — cover at z = ±6 and ±12, the peek
 * corner spanning z ∈ [−5, 5], the pit at |x|,|z| < 12, the mantle stack at
 * z ∈ [−19, −13], and the zipline towers at z ∈ [19.5, 24.5]. A combat test
 * that picks a lane by eye ends up measuring a wall instead of a weapon, which
 * has now happened twice — hence assertLaneClear() below, so the next time it
 * happens the failure says so instead of reporting zero damage.
 */
const LANE_Z = 15;

/**
 * PRD §12/M0 acceptance criteria, as executable assertions.
 *
 * The fun gate itself is human — it has to be — but everything around it is
 * mechanically checkable, and §13 says a milestone never advances until every
 * criterion passes programmatically.
 */

const MM = 1000;

function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, action: 0, fireSubTick: 0, ...over };
}

function run(w: World, n: number, mk: (t: number) => PlayerInput): void {
  for (let t = 0; t < n; t++) tick(w, [mk(t)]);
}

/** Fails loudly, and with the offending box, if the firing lane is obstructed. */
function assertLaneClear(w: World, fromX: number, toX: number, y = 1.45): void {
  for (const b of w.map.boxes) {
    const blocks =
      b.minY <= y && b.maxY >= y &&
      b.minZ <= LANE_Z && b.maxZ >= LANE_Z &&
      b.maxX >= fromX && b.minX <= toX;
    expect(
      blocks,
      `firing lane z=${LANE_Z}, x∈[${fromX}, ${toX}] is blocked by box ` +
        `x[${b.minX}, ${b.maxX}] y[${b.minY}, ${b.maxY}] z[${b.minZ}, ${b.maxZ}]`,
    ).toBe(false);
  }
}

function settled(): World {
  const w = createWorld(1);
  run(w, 90, () => input()); // let it fall and settle
  return w;
}

describe('M0 — movement', () => {
  it('settles on the ground and stops falling', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    expect(h.grounded).toBe(true);
    expect(h.moveState).toBe(MoveState.Ground);
    expect(Math.abs(h.vy)).toBeLessThan(200); // < 0.2 m/s residual
  });

  it('reaches base speed within ~0.15s of holding forward', () => {
    const w = settled();
    run(w, 12, () => input({ moveZ: 1 }));
    const h = w.state.heroes[0]!;
    const speed = Math.sqrt((h.vx / MM) ** 2 + (h.vz / MM) ** 2);
    expect(speed).toBeGreaterThan(MOVEMENT.BASE_SPEED_MPS * 0.97);
    expect(speed).toBeLessThanOrEqual(MOVEMENT.BASE_SPEED_MPS + 0.01);
  });

  it('dash covers its stated distance and grants i-frames', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    const x0 = h.px, z0 = h.pz;
    const before = h.dashCharges;

    tick(w, [input({ moveZ: 1, buttons: Btn.Dash })]);
    expect(h.dashCharges).toBe(before - 1);
    expect(h.iframeTicksLeft).toBeGreaterThan(0);
    expect(h.moveState).toBe(MoveState.Dash);

    run(w, MOVEMENT.DASH_DURATION_TICKS, () => input({ moveZ: 1, buttons: Btn.Dash }));
    const travelled = Math.sqrt(((h.px - x0) / MM) ** 2 + ((h.pz - z0) / MM) ** 2);
    // Within 10%: the last tick blends into ground movement.
    expect(travelled).toBeGreaterThan(MOVEMENT.DASH_DISTANCE_M * 0.9);
    expect(travelled).toBeLessThan(MOVEMENT.DASH_DISTANCE_M * 1.15);
  });

  it('dash charges recharge, and never exceed the cap', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    tick(w, [input({ buttons: Btn.Dash })]);
    expect(h.dashCharges).toBe(MOVEMENT.DASH_CHARGES - 1);
    run(w, MOVEMENT.DASH_RECHARGE_TICKS + 2, () => input());
    expect(h.dashCharges).toBe(MOVEMENT.DASH_CHARGES);
    run(w, MOVEMENT.DASH_RECHARGE_TICKS * 2, () => input());
    expect(h.dashCharges).toBe(MOVEMENT.DASH_CHARGES);
  });

  it('slide requires entry speed and preserves >=80% of it', () => {
    const w = settled();
    const h = w.state.heroes[0]!;

    // Standing still: refused.
    tick(w, [input({ buttons: Btn.Slide })]);
    expect(h.moveState).not.toBe(MoveState.Slide);

    run(w, 20, () => input({ moveZ: 1 }));
    const entry = Math.sqrt((h.vx / MM) ** 2 + (h.vz / MM) ** 2);
    tick(w, [input({ moveZ: 1, buttons: Btn.Slide })]);
    expect(h.moveState).toBe(MoveState.Slide);

    run(w, 36, () => input({ moveZ: 1 })); // 0.6s in
    const after = Math.sqrt((h.vx / MM) ** 2 + (h.vz / MM) ** 2);
    expect(after).toBeGreaterThanOrEqual(entry * 0.8);
  });

  it('mantles the 1.2m ledge and ends up standing on top of it', () => {
    const w = createWorld(1);
    const h = w.state.heroes[0]!;
    // Approach the 1.2m cover block at (0, 0, -12), 6×3 footprint, from −X.
    h.px = Math.round(-4.2 * MM); h.py = Math.round(0.05 * MM); h.pz = Math.round(-12 * MM);
    h.vx = 0; h.vy = 0; h.vz = 0;
    run(w, 40, () => input({ yaw: 2048, moveZ: 1 })); // yaw 2048/8192 = 90° → +X

    const wasMantle = h.moveState === MoveState.Mantle;
    run(w, 60, () => input({ yaw: 2048, moveZ: 1, buttons: Btn.Jump }));
    run(w, 60, () => input({ yaw: 2048 }));

    expect(wasMantle || h.py / MM > 1.0).toBe(true);
    expect(h.py / MM).toBeGreaterThan(1.0);
  });

  it('zipline attaches and traverses the full line', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    const zl = w.map.ziplines[0]!;
    h.px = Math.round(zl.ax * MM);
    h.py = Math.round((zl.ay - 1.2) * MM);
    h.pz = Math.round(zl.az * MM);

    tick(w, [input({ buttons: Btn.Zipline })]);
    expect(h.moveState).toBe(MoveState.Zipline);

    const maxTicks = Math.ceil((zl.length / MOVEMENT.ZIPLINE_SPEED_MPS) * SPINE.SIM_HZ * 3.5);
    let travelled = 0;
    for (let t = 0; t < maxTicks && h.moveState === MoveState.Zipline; t++) {
      tick(w, [input()]);
      travelled = Math.abs(h.px / MM - zl.ax);
    }
    expect(travelled).toBeGreaterThan(zl.length * 0.95);
  });
});

describe('M0 — combat', () => {
  /** Fire at the target directly in front, counting ticks to the kill. */
  function ttkAgainstTarget(): { ticks: number; shots: number } | null {
    const w = createWorld(7);
    const h = w.state.heroes[0]!;
    const t = w.state.targets[0]!;

    // Stand still 15m away (the SMG bench distance) on the target's −X side,
    // looking straight at it. Spread still applies; that is the point.
    assertLaneClear(w, -16, 1);
    t.px = 0; t.py = 0; t.pz = LANE_Z * MM; t.vx = 0;
    h.px = -15 * MM;
    h.py = Math.round(0.05 * MM);
    h.pz = LANE_Z * MM;
    h.vx = 0; h.vy = 0; h.vz = 0;
    run(w, 30, () => input({ yaw: 2048 }));
    h.shotsFired = 0;

    let firstDamageTick = -1;
    for (let i = 0; i < 600; i++) {
      tick(w, [input({ yaw: 2048, buttons: Btn.Fire })]);
      if (firstDamageTick < 0 && h.hitsLanded > 0) firstDamageTick = w.state.tick;
      if (!t.alive) return { ticks: w.state.tick - firstDamageTick, shots: h.shotsFired };
    }
    return null;
  }

  it('kills a 700 HP target, and lands inside the TTK band', () => {
    const r = ttkAgainstTarget();
    expect(r).not.toBeNull();
    const seconds = r!.ticks / SPINE.SIM_HZ;

    // The band is a body-shot number at the bench distance. Spread means some
    // shots miss, so real TTK sits at or slightly above the analytic figure.
    expect(seconds).toBeGreaterThan(COMBAT.TTK_BENCH.BAND_MIN_S * 0.9);
    expect(seconds).toBeLessThan(COMBAT.TTK_BENCH.BAND_MAX_S * 1.35);
  });

  it('analytic TTK is inside the band at the 700 HP reference', () => {
    // This is the assertion M3 actually gates on: measured TTK is dominated by
    // bot aim error, so it can be hit by tuning bots instead of weapons.
    for (const [name, w] of Object.entries({
      SMG: COMBAT.SMG, RIFLE: COMBAT.RIFLE, SHOTGUN: COMBAT.SHOTGUN, LAUNCHER: COMBAT.LAUNCHER,
    })) {
      const perShot = name === 'SHOTGUN' ? w.DAMAGE * COMBAT.SHOTGUN.PELLET_COUNT : w.DAMAGE;
      const shots = Math.ceil(COMBAT.TTK_BENCH.TARGET_HP_PRIMARY / perShot);
      const ttk = ((shots - 1) * w.FIRE_INTERVAL_TICKS) / SPINE.SIM_HZ;
      expect(ttk, `${name} TTK ${ttk.toFixed(3)}s`).toBeGreaterThanOrEqual(COMBAT.TTK_BENCH.BAND_MIN_S);
      expect(ttk, `${name} TTK ${ttk.toFixed(3)}s`).toBeLessThanOrEqual(COMBAT.TTK_BENCH.BAND_MAX_S);
    }
  });

  it('every fire interval is an integer tick count at 60Hz', () => {
    for (const w of [COMBAT.SMG, COMBAT.RIFLE, COMBAT.SHOTGUN, COMBAT.LAUNCHER]) {
      expect(Number.isInteger(w.FIRE_INTERVAL_TICKS)).toBe(true);
      expect(Number.isInteger(w.RELOAD_TICKS)).toBe(true);
    }
  });

  it('falloff reduces damage past the start distance and clamps at the end', () => {
    const w = createWorld(3);
    const h = w.state.heroes[0]!;
    const t = w.state.targets[0]!;

    assertLaneClear(w, -39, 1);
    t.px = 0; t.py = 0; t.pz = LANE_Z * MM; t.vx = 0;

    const damageAt = (dist: number): number => {
      t.hp = t.maxHp; t.alive = true;
      h.px = -dist * MM; h.py = Math.round(0.05 * MM); h.pz = LANE_Z * MM;
      h.vx = 0; h.vy = 0; h.vz = 0;
      h.spreadMilliDeg = 0; h.fireCooldownTicks = 0; h.ammo = 32;
      const before = t.hp;
      for (let i = 0; i < 40 && t.hp === before; i++) {
        tick(w, [input({ yaw: 2048, buttons: Btn.Fire })]);
      }
      return before - t.hp;
    };

    const near = damageAt(10); // inside FALLOFF_START_M
    const far = damageAt(38); // near FALLOFF_END_M
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near);
  });

  it('reloading is a commitment: a cancelled reload yields no ammo', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    h.ammo = 5;
    tick(w, [input({ buttons: Btn.Reload })]);
    expect(h.reloadTicksLeft).toBeGreaterThan(0);

    run(w, 20, () => input());
    tick(w, [input({ buttons: Btn.Dash })]); // dash cancels
    expect(h.reloadTicksLeft).toBe(0);
    expect(h.ammo).toBe(5); // zero partial credit
  });

  it('targets respawn so the range is self-serving', () => {
    const w = createWorld(9);
    const t = w.state.targets[0]!;
    t.hp = 0; t.alive = false; t.respawnTicksLeft = M0.TARGET_RESPAWN_TICKS;
    run(w, M0.TARGET_RESPAWN_TICKS + 2, () => input());
    expect(t.alive).toBe(true);
    expect(t.hp).toBe(t.maxHp);
  });
});

describe('M0 — camera', () => {
  it('toggles, and the transition is <= 0.15s', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    const start = h.camera;
    tick(w, [input({ buttons: Btn.CameraToggle })]);
    expect(h.camera).not.toBe(start);
    expect(h.cameraLerp).toBeLessThanOrEqual(Math.ceil(0.15 * SPINE.SIM_HZ));
  });

  it('is never blocked — not mid-dash, not mid-air', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    tick(w, [input({ moveZ: 1, buttons: Btn.Dash })]);
    expect(h.moveState).toBe(MoveState.Dash);
    const before = h.camera;
    tick(w, [input({ moveZ: 1, buttons: Btn.Dash | Btn.CameraToggle })]);
    expect(h.camera).not.toBe(before);
  });

  it('TPS carries no hipfire accuracy penalty (§5.1 rework)', () => {
    expect(CAMERA.TPS_HIPFIRE_SPREAD_MULT).toBe(1.0);
  });

  it('§5.2: holding ADS from TPS auto-enters FPS, releasing restores TPS', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    expect(h.camera).toBe(CameraMode.TPS);

    tick(w, [input({ buttons: Btn.Ads })]);
    expect(h.camera).toBe(CameraMode.FPS);

    run(w, 20, () => input({ buttons: Btn.Ads }));
    expect(h.camera).toBe(CameraMode.FPS);
    expect(h.adsTicks).toBeGreaterThan(0);

    tick(w, [input()]); // release
    expect(h.camera).toBe(CameraMode.TPS);
  });

  it('§5.2: holding ADS from FPS leaves you in FPS on release', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    tick(w, [input({ buttons: Btn.CameraToggle })]);
    expect(h.camera).toBe(CameraMode.FPS);

    tick(w, [input({ buttons: Btn.Ads })]);
    run(w, 10, () => input({ buttons: Btn.Ads }));
    tick(w, [input()]);
    expect(h.camera).toBe(CameraMode.FPS);
  });

  it('a V press during ADS wins over the release restore', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    tick(w, [input({ buttons: Btn.Ads })]);
    expect(h.camera).toBe(CameraMode.FPS);
    // Player explicitly toggles back to TPS while still holding the mouse.
    tick(w, [input({ buttons: Btn.Ads | Btn.CameraToggle })]);
    expect(h.camera).toBe(CameraMode.TPS);
    expect(h.adsPriorCamera).toBe(-1); // the pending restore is discarded

    run(w, 5, () => input({ buttons: Btn.Ads }));
    tick(w, [input()]); // release must NOT drag them back to FPS
    expect(h.camera).toBe(CameraMode.TPS);
  });

  it('ADS actually narrows the spread cone', () => {
    const w = settled();
    const h = w.state.heroes[0]!;
    const hip = currentSpreadDeg(h);
    tick(w, [input({ buttons: Btn.Ads })]);
    run(w, CAMERA.ADS_ENTER_TICKS + 2, () => input({ buttons: Btn.Ads }));
    expect(currentSpreadDeg(h)).toBeLessThan(hip * 0.6);
  });
});

describe('M0 — map reachability', () => {
  it('the pit is actually a hole, not filled-in floor', () => {
    // The first build laid a solid floor across the arena and *then* built rim
    // slabs around a hole, so the hole was filled in and the pit target was
    // embedded in ground.
    const w = createWorld(5);
    const h = w.state.heroes[0]!;
    h.px = 0; h.py = 6 * MM; h.pz = 0; h.vx = 0; h.vy = 0; h.vz = 0;
    run(w, 200, () => input());
    expect(h.py / MM).toBeLessThan(-1.0); // came to rest on the pit floor
    expect(h.grounded).toBe(true);
  });

  it('every zipline anchor is reachable by mantling from the ground', () => {
    // Anchors sit at 7.5m with a 3m attach radius against a 1.18m jump apex.
    // Without an access route they are decorative — which is what shipped.
    const w = createWorld(5);
    for (const zl of w.map.ziplines) {
      for (const [ax, az] of [[zl.ax, zl.az], [zl.bx, zl.bz]] as const) {
        // Something standable must exist within the attach radius, directly
        // under the anchor, at a height a mantle chain can reach.
        const support = w.map.boxes.some(
          (b) =>
            ax >= b.minX - 0.4 && ax <= b.maxX + 0.4 &&
            az >= b.minZ - 0.4 && az <= b.maxZ + 0.4 &&
            b.maxY >= zl.ay - MOVEMENT.ZIPLINE_ATTACH_RANGE_M &&
            b.maxY < zl.ay,
        );
        expect(support, `no access under anchor (${ax}, ${az})`).toBe(true);
      }
    }
  });

  it('the access stack climbs in steps a mantle can take', () => {
    const w = createWorld(5);
    const zl = w.map.ziplines[0]!;
    const near = w.map.boxes
      .filter((b) => Math.abs((b.minX + b.maxX) / 2 - zl.ax) < 9 && Math.abs((b.minZ + b.maxZ) / 2 - zl.az) < 4)
      .map((b) => b.maxY)
      .filter((y) => y > 0.1)
      .sort((a, b) => a - b);
    expect(near.length).toBeGreaterThanOrEqual(3);
    let prev = 0;
    for (const y of near) {
      expect(y - prev, `step of ${(y - prev).toFixed(2)}m exceeds mantle height`).toBeLessThanOrEqual(MOVEMENT.MANTLE_MAX_HEIGHT_M);
      prev = y;
    }
  });
});

describe('M0 — spawn sanity', () => {
  it('the hero never falls out of the world', () => {
    const w = createWorld(11);
    run(w, 2000, (t) => input({ moveX: (t % 5) - 2, moveZ: (t % 3) - 1, yaw: (t * 37) % 8192, buttons: t % 40 === 0 ? Btn.Dash : 0 }));
    expect(w.state.heroes[0]!.py / MM).toBeGreaterThan(-15);
  });

  it('createHero produces only integer state', () => {
    const h = createHero(0, Team.A, 1.234, 5.678, -9.012, 100);
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'number') expect(Number.isInteger(v), `${k}=${v}`).toBe(true);
    }
  });
});
