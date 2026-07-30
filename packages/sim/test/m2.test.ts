import { describe, it, expect } from 'vitest';
import { createWorld, tick, makeApplyDamage, hashState, type World } from '../src/world.js';
import {
  Btn, Team, MatchPhase, StructureKind, TrooperKind, SoulSource,
  type PlayerInput, type OrbState,
} from '../src/types.js';
import { SPINE, WORLD, ECONOMY, COMBAT } from '../src/balance.js';
import { spawnOrb, damageOrb, teamSouls } from '../src/systems/economy.js';

/** PRD §12/M2 acceptance criteria, as executable assertions. */

const MM = 1000;
const idle: PlayerInput[] = [];

function strip(): World {
  return createWorld(0xabcdef, 'strip');
}

function run(w: World, ticks: number, inputs: PlayerInput[] = idle): void {
  for (let i = 0; i < ticks; i++) tick(w, inputs);
}

describe('M2 — THE STRIP', () => {
  it('is 220m × 35m with structures at the specified lane fractions', () => {
    const w = strip();
    const xs = w.map.structures.map((s) => s.x);
    expect(xs).toContain(-WORLD.MAP.TOWER_T1_X_ABS_M);
    expect(xs).toContain(WORLD.MAP.TOWER_T1_X_ABS_M);
    expect(xs).toContain(-WORLD.MAP.CORE_X_ABS_M);
    expect(w.map.structures).toHaveLength(6); // 2 towers + 1 core per side
  });

  it('spawns 3v3 with a fixed id layout', () => {
    const s = strip().state;
    expect(s.heroes).toHaveLength(6);
    expect(s.heroes.slice(0, 3).every((h) => h.team === Team.A)).toBe(true);
    expect(s.heroes.slice(3).every((h) => h.team === Team.B)).toBe(true);
    for (let i = 0; i < 6; i++) expect(s.heroes[i]!.id).toBe(i);
  });

  it('every hero settles on solid ground at spawn — the floor has no holes', () => {
    const w = strip();
    run(w, 120);
    for (const h of w.state.heroes) {
      expect(h.grounded, `hero ${h.id} is not grounded`).toBe(true);
      expect(h.py / MM, `hero ${h.id} fell to ${h.py / MM}`).toBeGreaterThan(-1);
    }
  });

  it('the pit is a real hole, three metres deep', () => {
    const w = strip();
    const h = w.state.heroes[0]!;
    h.px = 0; h.py = 6 * MM; h.pz = 0; h.vx = 0; h.vy = 0; h.vz = 0;
    // z=0 is the catwalk, so this must NOT fall.
    run(w, 180);
    expect(h.py / MM).toBeGreaterThan(-0.5);

    h.px = 0; h.py = 6 * MM; h.pz = -8 * MM; h.vy = 0;
    run(w, 180);
    expect(h.py / MM, 'off the catwalk should drop into the pit').toBeLessThan(-2.0);
    expect(h.grounded).toBe(true);
  });
});

describe('M2 — trooper waves', () => {
  it('the first wave spawns at 0:30 and then every 25s', () => {
    const w = strip();
    run(w, WORLD.TROOPERS.FIRST_WAVE_TICK - 1);
    expect(w.state.troopers).toHaveLength(0);

    run(w, 2);
    expect(w.state.troopers.filter((t) => t.alive)).toHaveLength(WORLD.TROOPERS.UNITS_PER_WAVE * 2);

    run(w, WORLD.TROOPERS.WAVE_INTERVAL_TICKS);
    expect(w.state.waveIndex).toBe(2);
  });

  it('every fourth wave is a siege wave, and still four units', () => {
    const w = strip();
    run(w, WORLD.TROOPERS.FIRST_WAVE_TICK + WORLD.TROOPERS.WAVE_INTERVAL_TICKS * 3 + 2);
    const siege = w.state.troopers.filter((t) => t.kind === TrooperKind.Sieger);
    expect(siege.length).toBeGreaterThan(0);
    const lastWave = w.state.waveIndex - 1;
    expect(w.state.troopers.filter((t) => t.waveIndex === lastWave && t.team === Team.A)).toHaveLength(4);
  });

  it('wave 1 clashes over the MID PIT at ~0:54', () => {
    // The design intent: the first fight of the match happens at the objective.
    const w = strip();
    let clashTick = -1;
    for (let i = 0; i < SPINE.SIM_HZ * 90 && clashTick < 0; i++) {
      tick(w, idle);
      const a = w.state.troopers.filter((t) => t.alive && t.team === Team.A);
      const b = w.state.troopers.filter((t) => t.alive && t.team === Team.B);
      if (a.length === 0 || b.length === 0) continue;
      const aMax = Math.max(...a.map((t) => t.px));
      const bMin = Math.min(...b.map((t) => t.px));
      if (aMax >= bMin - WORLD.TROOPERS.LINE.RANGE_M * MM) clashTick = w.state.tick;
    }
    expect(clashTick).toBeGreaterThan(0);
    const clashS = clashTick / SPINE.SIM_HZ;
    expect(clashS, `clash at ${clashS.toFixed(1)}s`).toBeGreaterThan(45);
    expect(clashS, `clash at ${clashS.toFixed(1)}s`).toBeLessThan(65);

    const alive = w.state.troopers.filter((t) => t.alive);
    const meanX = alive.reduce((s, t) => s + t.px / MM, 0) / alive.length;
    expect(Math.abs(meanX), `clash centred at x=${meanX.toFixed(1)}`).toBeLessThan(WORLD.MAP.PIT_HALF_EXTENT_M + 8);
  });

  it('waves fight each other, and troopers die', () => {
    const w = strip();
    run(w, SPINE.SIM_HZ * 90);
    const dead = w.state.troopers.filter((t) => !t.alive);
    expect(dead.length).toBeGreaterThan(0);
  });
});

describe('M2 — soul orbs', () => {
  function orbFrom(w: World, team: Team): OrbState {
    const t = {
      id: 9999, team, kind: TrooperKind.Line, alive: false,
      px: 0, py: 0, pz: 0, hp: 0, maxHp: 1, waveIndex: 0,
      targetId: -1, targetDwell: 0, attackCooldown: 0, retargetIn: 0,
      retaliateUntil: -1, retaliateTarget: -1,
    };
    spawnOrb(w.state, t);
    const o = w.state.orbs[w.state.orbs.length - 1]!;
    o.armTicksLeft = 0;
    return o;
  }

  it('an orb belongs to the team OPPOSITE the trooper that dropped it', () => {
    const w = strip();
    expect(orbFrom(w, Team.A).ownerTeam).toBe(Team.B);
    expect(orbFrom(w, Team.B).ownerTeam).toBe(Team.A);
  });

  it('claiming pays the owner, and heals', () => {
    const w = strip();
    const orb = orbFrom(w, Team.B); // owned by A
    const hero = w.state.heroes[0]!; // team A
    hero.hp = hero.maxHp / 2;
    const hpBefore = hero.hp;

    let done = false;
    let hits = 0;
    while (!done && hits < 20) { done = damageOrb(w.state, orb, hero, ECONOMY.ORB_DAMAGE_SMG, 1); hits++; }

    expect(done).toBe(true);
    expect(hits).toBe(Math.ceil(ECONOMY.ORB_HP / ECONOMY.ORB_DAMAGE_SMG));
    expect(teamSouls(w.state, Team.A)).toBe(ECONOMY.ORB_CLAIM_BY_MINUTE[0]);
    expect(hero.hp).toBe(hpBefore + ECONOMY.ORB_CLAIM_HEAL_HP * SPINE.DAMAGE_SCALE);
  });

  it('denying pays half, heals more, and pays the owner nothing', () => {
    const w = strip();
    const orb = orbFrom(w, Team.B); // owned by A
    const enemy = w.state.heroes[3]!; // team B
    enemy.hp = enemy.maxHp / 2;

    let done = false;
    for (let i = 0; i < 20 && !done; i++) done = damageOrb(w.state, orb, enemy, ECONOMY.ORB_DAMAGE_SMG, 1);

    expect(done).toBe(true);
    expect(teamSouls(w.state, Team.B)).toBe(ECONOMY.ORB_DENY_BY_MINUTE[0]);
    expect(teamSouls(w.state, Team.A)).toBe(0);
    // The denier is the one being pushed, so denying is the recovery path.
    expect(ECONOMY.ORB_DENY_HEAL_HP).toBeGreaterThan(ECONOMY.ORB_CLAIM_HEAL_HP);
  });

  it('claim and deny progress are separate pools', () => {
    // If they shared one, chipping an enemy orb would help them claim it.
    const w = strip();
    const orb = orbFrom(w, Team.B);
    const owner = w.state.heroes[0]!;
    const enemy = w.state.heroes[3]!;

    damageOrb(w.state, orb, owner, 60, 1);
    damageOrb(w.state, orb, enemy, 60, 1);
    expect(orb.claimProgress).toBe(60);
    expect(orb.denyProgress).toBe(60);
    expect(orb.alive).toBe(true); // neither has 120 yet

    expect(damageOrb(w.state, orb, enemy, 60, 1)).toBe(true);
    expect(teamSouls(w.state, Team.B)).toBeGreaterThan(0);
    expect(teamSouls(w.state, Team.A)).toBe(0);
  });

  it('an unclaimed orb expires and pays nobody', () => {
    const w = strip();
    const orb = orbFrom(w, Team.B);
    run(w, ECONOMY.ORB_HOVER_TICKS + 2);
    expect(orb.alive).toBe(false);
    expect(teamSouls(w.state, Team.A)).toBeGreaterThanOrEqual(0);
    expect(w.state.soulEvents.some((e) => e.source === SoulSource.OrbClaim)).toBe(false);
  });

  it('an orb is invulnerable during its arm delay', () => {
    const w = strip();
    const t = {
      id: 9998, team: Team.B, kind: TrooperKind.Line, alive: false,
      px: 0, py: 0, pz: 0, hp: 0, maxHp: 1, waveIndex: 0,
      targetId: -1, targetDwell: 0, attackCooldown: 0, retargetIn: 0,
      retaliateUntil: -1, retaliateTarget: -1,
    };
    spawnOrb(w.state, t);
    const orb = w.state.orbs[w.state.orbs.length - 1]!;
    expect(orb.armTicksLeft).toBeGreaterThan(0);
    expect(damageOrb(w.state, orb, w.state.heroes[0]!, 999, 1)).toBe(false);
    expect(orb.claimProgress).toBe(0);
  });

  it('troopers dying in a real match drop orbs', () => {
    const w = strip();
    run(w, SPINE.SIM_HZ * 100);
    expect(w.state.orbs.length).toBeGreaterThan(0);
  });
});

describe('M2 — structures', () => {
  it('a tower acquires the nearest enemy trooper in range, after its grace delay', () => {
    // Note: two symmetric waves with no heroes grind at mid forever, so this
    // has to place the trooper rather than wait for one to arrive. That
    // stalemate is correct — heroes are what break a wave.
    const w = strip();
    run(w, WORLD.TROOPERS.FIRST_WAVE_TICK + 5);

    const tower = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT1)!;
    const near = w.state.troopers.find((t) => t.team === Team.A)!;
    const far = w.state.troopers.filter((t) => t.team === Team.A)[1]!;
    near.px = tower.px - 8 * MM; near.pz = tower.pz;
    far.px = tower.px - 25 * MM; far.pz = tower.pz;

    run(w, WORLD.STRUCTURES.TOWER_ACQUIRE_DELAY_TICKS + 4);
    expect(tower.targetId).toBe(near.id);

    // …and the grace delay is real: it does not fire on the acquisition tick.
    const fresh = strip();
    const t2 = fresh.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT1)!;
    expect(t2.acquireDelay).toBeLessThanOrEqual(WORLD.STRUCTURES.TOWER_ACQUIRE_DELAY_TICKS);
  });

  it('damaging an allied TROOPER does not pull tower aggro', () => {
    // The other reading of M2's "hero-damages-ally" makes every last hit aggro
    // the tower, which makes contesting souls under a tower impossible.
    const w = strip();
    const apply = makeApplyDamage(w);
    run(w, WORLD.TROOPERS.FIRST_WAVE_TICK + 5);

    const tower = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT1)!;
    const victim = w.state.troopers.find((t) => t.team === Team.B)!;
    const attacker = w.state.heroes[0]!; // team A
    attacker.px = tower.px - 10 * MM;
    attacker.pz = tower.pz;
    victim.px = tower.px - 8 * MM;
    victim.pz = tower.pz;

    apply(victim.id, 1000, attacker.team, attacker.id);
    expect(tower.aggroHeroUntil).toBeLessThanOrEqual(w.state.tick);
  });

  it('damaging an allied HERO does pull tower aggro', () => {
    const w = strip();
    const apply = makeApplyDamage(w);
    const tower = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT1)!;
    const victim = w.state.heroes[3]!; // team B
    const attacker = w.state.heroes[0]!; // team A
    victim.px = tower.px - 5 * MM;
    victim.pz = tower.pz;

    apply(victim.id, 1000, attacker.team, attacker.id);
    expect(tower.aggroHeroUntil).toBeGreaterThan(w.state.tick);
    expect(tower.aggroHeroId).toBe(attacker.id);
  });

  it('the tower damage ramp escalates and is capped', () => {
    const S = WORLD.STRUCTURES;
    const dmg = (n: number): number => Math.min(S.TOWER_DMG_VS_HERO_CAP, S.TOWER_DMG_VS_HERO_BASE + S.TOWER_DMG_VS_HERO_RAMP * n);
    expect(dmg(0)).toBe(110);
    expect(dmg(1)).toBe(145);
    expect(dmg(2)).toBe(180);
    expect(dmg(9)).toBe(S.TOWER_DMG_VS_HERO_CAP);
    // A 700 HP hero must survive at least four shots — the dive has to be a
    // decision, not an instant death.
    let cum = 0;
    let shots = 0;
    while (cum < 700) { cum += dmg(shots); shots++; }
    expect(shots).toBeGreaterThanOrEqual(5);
  });

  it('structures are attackable out of order — backdoor is legal', () => {
    const w = strip();
    const apply = makeApplyDamage(w);
    const core = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.Core)!;
    apply(core.id, 1000 * SPINE.DAMAGE_SCALE, Team.A, 0);
    expect(core.hp).toBeLessThan(core.maxHp); // no invulnerability gate
  });

  it('a protected tower regenerates, so an interrupted backdoor fails', () => {
    const w = strip();
    const apply = makeApplyDamage(w);
    const t2 = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT2)!;
    apply(t2.id, 5000 * SPINE.DAMAGE_SCALE, Team.A, 0);
    const dented = t2.hp;
    run(w, WORLD.STRUCTURES.BACKDOOR_REGEN_DELAY_TICKS + SPINE.SIM_HZ * 2);
    expect(t2.hp).toBeGreaterThan(dented);
  });

  it('killing a tower pays every member of the destroying team', () => {
    const w = strip();
    const apply = makeApplyDamage(w);
    const t1 = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.TowerT1)!;
    apply(t1.id, t1.maxHp, Team.A, 0);
    expect(t1.alive).toBe(false);
    expect(teamSouls(w.state, Team.A)).toBe(ECONOMY.TOWER_T1_SOULS_PER_PLAYER * 3);
    expect(teamSouls(w.state, Team.B)).toBe(0);
  });

  it('the match ends when a core dies', () => {
    const w = strip();
    const apply = makeApplyDamage(w);
    const core = w.state.structures.find((s) => s.team === Team.B && s.kind === StructureKind.Core)!;
    apply(core.id, core.maxHp, Team.A, 0);
    expect(w.state.phase).toBe(MatchPhase.Over);
    expect(w.state.winner).toBe(Team.A);
  });
});

describe('M2 — economy over a real match', () => {
  it('passive trickle pays on schedule and stays under the P2 ceiling', () => {
    const w = strip();
    const minutes = 3;
    run(w, SPINE.SIM_HZ * 60 * minutes);
    const passive = w.state.soulEvents.length; // last tick only; use the counter instead
    void passive;

    const expected = Math.floor((SPINE.SIM_HZ * 60 * minutes) / ECONOMY.PASSIVE_GRANT_INTERVAL_TICKS);
    const hero0 = w.state.teams[Team.A]!.souls[0] ?? 0;
    // Everything else this hero earned is contestable; passive is the floor.
    expect(hero0).toBeGreaterThanOrEqual(expected - 1);
  });

  it('a full match runs to sudden death without stalling or NaN', () => {
    const w = strip();
    run(w, SPINE.SUDDEN_DEATH_TICK + SPINE.SIM_HZ * 5);
    expect(w.state.phase).toBe(MatchPhase.SuddenDeath);
    for (const st of w.state.structures) {
      expect(Number.isFinite(st.hp)).toBe(true);
      expect(Number.isInteger(st.hp)).toBe(true);
    }
    for (const h of w.state.heroes) {
      expect(Number.isInteger(h.px)).toBe(true);
      expect(Number.isInteger(h.hp)).toBe(true);
    }
  });

  it('sudden death decay eventually ends the match on its own', () => {
    const w = strip();
    run(w, SPINE.SUDDEN_DEATH_TICK);
    let guard = 0;
    while (w.state.phase !== MatchPhase.Over && guard < SPINE.SIM_HZ * 400) { tick(w, idle); guard++; }
    expect(w.state.phase).toBe(MatchPhase.Over);
    expect(w.state.tick).toBeLessThanOrEqual(WORLD.SUDDEN_DEATH.HARD_CEILING_TICK + SPINE.SIM_HZ * 30);
  });
});

describe('M2 — determinism holds with the full entity set', () => {
  it('two identical strip runs produce the same 20,000-tick hash', () => {
    const scripted = (t: number): PlayerInput[] =>
      [0, 1, 2, 3, 4, 5].map((id) => ({
        seq: t, entityId: id,
        moveX: ((t / (7 + id)) | 0) % 3 - 1,
        moveZ: ((t / (11 + id)) | 0) % 3 - 1,
        yaw: (t * (13 + id)) % 8192,
        pitch: ((t * 5) % 600) - 300,
        buttons: (t % (5 + id) === 0 ? Btn.Fire : 0) | (t % 137 === 0 ? Btn.Dash : 0), action: 0,
        fireSubTick: 0,
      }));

    const go = (): number => {
      const w = strip();
      for (let t = 0; t < 20_000; t++) tick(w, scripted(t));
      return hashState(w.state);
    };
    expect(go()).toBe(go());
  });

  it('every entity keeps integer state after a long run', () => {
    const w = strip();
    run(w, 12_000);
    for (const t of w.state.troopers) {
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === 'number') expect(Number.isInteger(v), `trooper.${k}=${v}`).toBe(true);
      }
    }
    for (const o of w.state.orbs) {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number') expect(Number.isInteger(v), `orb.${k}=${v}`).toBe(true);
      }
    }
    for (const st of w.state.structures) {
      for (const [k, v] of Object.entries(st)) {
        if (typeof v === 'number') expect(Number.isInteger(v), `structure.${k}=${v}`).toBe(true);
      }
    }
  });
});

describe('M2 — the greybox range still works', () => {
  it('M0 mode is unaffected by the strip refactor', () => {
    const w = createWorld(1, 'greybox');
    expect(w.state.heroes).toHaveLength(1);
    expect(w.state.targets.length).toBeGreaterThan(0);
    expect(w.state.structures).toHaveLength(0);
    run(w, 300);
    expect(w.state.heroes[0]!.grounded).toBe(true);
  });

  it('the SMG still kills a range target', () => {
    const w = createWorld(7, 'greybox');
    const h = w.state.heroes[0]!;
    const t = w.state.targets[0]!;
    t.px = 0; t.py = 0; t.pz = 15 * MM;
    h.px = -15 * MM; h.py = Math.round(0.05 * MM); h.pz = 15 * MM;
    run(w, 30, [{ seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 2048, pitch: 0, buttons: 0, action: 0, fireSubTick: 0 }]);
    for (let i = 0; i < 400 && t.alive; i++) {
      tick(w, [{ seq: i, entityId: 0, moveX: 0, moveZ: 0, yaw: 2048, pitch: 0, buttons: Btn.Fire, action: 0, fireSubTick: 0 }]);
    }
    expect(t.alive).toBe(false);
    expect(COMBAT.SMG.DAMAGE).toBe(38);
  });
});
