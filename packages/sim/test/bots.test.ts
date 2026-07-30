import { describe, it, expect } from 'vitest';
import { createWorld, tick, fillWithBots, hashState, BOT_TIERS, type World } from '../src/world.js';
import { Team, MatchPhase, StructureKind, type PlayerInput } from '../src/types.js';
import { SPINE, WORLD } from '../src/balance.js';
import { canSeeRaw, newVisibilityMemory, updateVisibility, canSee } from '../src/systems/visibility.js';

/**
 * Bots and perception.
 *
 * The load-bearing assertion in this file is the omniscience one. PRD §10.5's
 * bots produce every balance number the project has — M3's TTK, §8's win rates,
 * the whole M8 loop — so a bot that reads WorldState directly means the bench
 * measures a game nobody plays, and §5.3's peek test degenerates into comparing
 * two omniscient agents.
 */

const MM = 1000;

function botMatch(tier = BOT_TIERS.normal): World {
  const w = createWorld(0x5eed, 'strip');
  fillWithBots(w, [], tier); // all six slots
  return w;
}

function run(w: World, ticks: number, inputs: PlayerInput[] = []): void {
  for (let i = 0; i < ticks; i++) tick(w, inputs);
}

describe('visibility — the gate bots must obey', () => {
  it('a wall blocks line of sight', () => {
    const w = createWorld(1, 'strip');
    const a = w.state.heroes[0]!;
    // Put a hero on each side of a cover block. Cover sits at |z| = 6.5,
    // 3m tall, 6m wide, at 15m intervals from the lane ends.
    const cover = w.map.boxes.find((b) => b.maxY === WORLD.MAP.COVER_BLOCK_HEIGHT_M)!;
    const cx = (cover.minX + cover.maxX) / 2;
    const cz = (cover.minZ + cover.maxZ) / 2;
    a.px = Math.round(cx * MM); a.py = 0; a.pz = Math.round((cz - 6) * MM);

    const behind = canSeeRaw(a, cx, 0, cz + 6, 1.8, w.map.boxes);
    const clear = canSeeRaw(a, cx, 0, cz - 20, 1.8, w.map.boxes);
    expect(behind, 'should NOT see through a 3m cover block').toBe(false);
    expect(clear, 'should see down an open lane').toBe(true);
  });

  it('fails closed before the first sample', () => {
    const w = createWorld(1, 'strip');
    const mem = newVisibilityMemory();
    expect(canSee(w.state, mem, 0, 3)).toBe(false);
  });

  it('hysteresis keeps a briefly-occluded enemy visible', () => {
    const w = createWorld(1, 'strip');
    const mem = newVisibilityMemory();
    const a = w.state.heroes[0]!;
    const b = w.state.heroes[3]!;
    a.px = 0; a.py = 0; a.pz = 0;
    b.px = 20 * MM; b.py = 0; b.pz = 0;

    w.state.tick = 0;
    updateVisibility(w.state, mem, w.map.boxes);
    expect(canSee(w.state, mem, a.id, b.id)).toBe(true);

    // One occluded sample must not immediately hide them.
    b.py = -50 * MM; // under the floor: definitely occluded
    w.state.tick = SPINE.VISIBILITY_INTERVAL_TICKS;
    updateVisibility(w.state, mem, w.map.boxes);
    expect(canSee(w.state, mem, a.id, b.id), 'one miss should not hide').toBe(true);

    w.state.tick = SPINE.VISIBILITY_INTERVAL_TICKS * 2;
    updateVisibility(w.state, mem, w.map.boxes);
    w.state.tick += SPINE.VISIBILITY_INTERVAL_TICKS * 4; // outrun the dwell
    expect(canSee(w.state, mem, a.id, b.id), 'sustained occlusion should hide').toBe(false);
  });

  it('is tick-locked, not free-running', () => {
    const w = createWorld(1, 'strip');
    const mem = newVisibilityMemory();
    w.state.tick = 1; // not a multiple of the interval
    updateVisibility(w.state, mem, w.map.boxes);
    expect(mem.visible.size).toBe(0);
  });
});

describe('bots', () => {
  it('are not omniscient — they do not act on an enemy they cannot see', () => {
    const w = botMatch(BOT_TIERS.hard);
    const bot = w.bots.get(0)!;
    const self = w.state.heroes[0]!;
    const enemy = w.state.heroes[3]!;

    // Bury the enemy under the floor: in range, but with no line of sight.
    self.px = 0; self.py = 0; self.pz = 0;
    enemy.px = 10 * MM; enemy.py = -40 * MM; enemy.pz = 0;
    run(w, 40);
    expect(bot.targetHeroId, 'acquired a target it cannot see').toBe(-1);
  });

  it('acquire a visible enemy, but only after their reaction time', () => {
    const w = botMatch(BOT_TIERS.easy);
    const bot = w.bots.get(0)!;
    const self = w.state.heroes[0]!;
    const enemy = w.state.heroes[3]!;
    self.px = 0; self.py = 0; self.pz = 0;
    enemy.px = 14 * MM; enemy.py = 0; enemy.pz = 0;

    run(w, SPINE.VISIBILITY_INTERVAL_TICKS + 1);
    expect(bot.targetHeroId).toBe(enemy.id);
    expect(bot.reactionLeft, 'should still be reacting').toBeGreaterThan(0);

    run(w, BOT_TIERS.easy.reactionTicks + 2);
    expect(bot.reactionLeft).toBe(0);
  });

  it('harder tiers react faster and aim tighter — difficulty is two numbers', () => {
    expect(BOT_TIERS.hard.reactionTicks).toBeLessThan(BOT_TIERS.normal.reactionTicks);
    expect(BOT_TIERS.normal.reactionTicks).toBeLessThan(BOT_TIERS.easy.reactionTicks);
    expect(BOT_TIERS.hard.aimErrorDeg).toBeLessThan(BOT_TIERS.easy.aimErrorDeg);
  });

  it('advance out of spawn and reach the lane', () => {
    // Regression for two real ones: heroes spawned 6m BEHIND their own core
    // (a solid 8m-wide collider) with no pathfinder to route around it, and
    // two of the three spawn slots landed inside a cover block.
    const w = botMatch();
    run(w, SPINE.SIM_HZ * 60);
    const deepestA = Math.max(...w.state.heroes.filter((h) => h.team === Team.A).map((h) => h.px / MM));
    const deepestB = Math.min(...w.state.heroes.filter((h) => h.team === Team.B).map((h) => h.px / MM));
    expect(deepestA, 'team A never left its own half').toBeGreaterThan(-40);
    expect(deepestB, 'team B never left its own half').toBeLessThan(40);
  });

  it('fight each other — a bot match produces kills', () => {
    const w = botMatch(BOT_TIERS.hard);
    let deaths = 0;
    const alive = new Map(w.state.heroes.map((h) => [h.id, true]));
    for (let i = 0; i < SPINE.SIM_HZ * 300; i++) {
      tick(w, []);
      for (const h of w.state.heroes) {
        if (alive.get(h.id) === true && !h.alive) { deaths++; alive.set(h.id, false); }
        if (h.alive) alive.set(h.id, true);
      }
    }
    expect(deaths, 'no hero died in five minutes of bot-vs-bot').toBeGreaterThan(0);
  });

  it('contest soul orbs — the economy actually turns over', () => {
    const w = botMatch();
    run(w, SPINE.SIM_HZ * 150);
    const earned = w.state.teams[Team.A]!.contestableEarned + w.state.teams[Team.B]!.contestableEarned;
    expect(earned, 'no contestable souls earned in 2.5 minutes').toBeGreaterThan(0);
  });

  it('a full bot match always terminates', () => {
    /**
     * KNOWN LIMITATION, recorded rather than papered over: two symmetric
     * behaviour-tree bot teams hold the wave equilibrium at mid indefinitely.
     * Neither side gains the trooper advantage a siege needs, so a bot-vs-bot
     * match currently resolves by sudden-death decay rather than by a core
     * dying. A human breaks the symmetry immediately — which is what M3's gate
     * actually tests — but the M8 bench needs bots with a "push" macro state
     * before its match-length distribution means anything. See STATE.md.
     *
     * What must hold unconditionally is that the match ENDS.
     */
    const w = botMatch(BOT_TIERS.hard);
    let guard = 0;
    while (w.state.phase !== MatchPhase.Over && guard < SPINE.SIM_HZ * 1200) {
      tick(w, []);
      guard++;
    }
    expect(w.state.phase, `still running after ${(guard / SPINE.SIM_HZ / 60).toFixed(1)} min`).toBe(MatchPhase.Over);
    expect([Team.A, Team.B]).toContain(w.state.winner);
  });

  it('bots damage structures — the siege path is wired end to end', () => {
    // Regression for a real one: structures live in the collision box list, so
    // a shot at a tower resolved as a WALL HIT and dealt zero damage. Twelve
    // minutes of bench read 100% on every structure and looked like pathing.
    const w = botMatch(BOT_TIERS.hard);
    const before = w.state.structures.map((s) => s.hp);
    run(w, SPINE.SIM_HZ * 200);
    expect(w.state.structures.some((s, i) => s.hp < before[i]!)).toBe(true);
  });

  it('bot matches stay deterministic', () => {
    const go = (): number => {
      const w = botMatch(BOT_TIERS.hard);
      for (let i = 0; i < 9000; i++) tick(w, []);
      return hashState(w.state);
    };
    expect(go()).toBe(go());
  });

  it('a human input always wins over the bot on the same slot', () => {
    // This is what makes disconnect-takeover a one-line change rather than a
    // special case: the bot is appended, never substituted.
    const w = botMatch();
    run(w, 120);
    const h = w.state.heroes[0]!;
    const startX = h.px;
    const humanInput: PlayerInput = {
      seq: 0, entityId: 0, moveX: 0, moveZ: -1,
      yaw: 2048, pitch: 0, buttons: 0, fireSubTick: 0,
    };
    for (let i = 0; i < 60; i++) tick(w, [humanInput]);
    // yaw 2048 is +X, moveZ −1 is backwards ⇒ the hero must travel −X.
    expect(h.px).toBeLessThan(startX);
  });
});

describe('bot-vs-bot bench sanity', () => {
  it('heroes regenerate out of combat — §6.2', () => {
    // Its absence was not subtle: a bot below its retreat threshold never
    // recovered, so it walked backwards into its own core and stayed there.
    const w = botMatch();
    const h = w.state.heroes[0]!;
    h.hp = Math.round(h.maxHp * 0.2);
    h.lastDamagedTick = -99999;
    const before = h.hp;
    run(w, SPINE.SIM_HZ * 3);
    expect(h.hp).toBeGreaterThan(before);
  });

  it('death count per match is in a sane range', () => {
    // The economy model assumes roughly 24 deaths across a 12-minute match.
    // A hard-vs-hard bench currently runs hotter than that; this asserts the
    // order of magnitude so a regression that makes it 300 is caught.
    const w = botMatch(BOT_TIERS.hard);
    let deaths = 0;
    const alive = new Map(w.state.heroes.map((h) => [h.id, true]));
    for (let i = 0; i < SPINE.SIM_HZ * 720; i++) {
      tick(w, []);
      for (const h of w.state.heroes) {
        if (alive.get(h.id) === true && !h.alive) { deaths++; alive.set(h.id, false); }
        if (h.alive) alive.set(h.id, true);
      }
    }
    expect(deaths, `${deaths} deaths in 12 min`).toBeGreaterThan(4);
    expect(deaths, `${deaths} deaths in 12 min`).toBeLessThan(140);
    void StructureKind;
  });
});
