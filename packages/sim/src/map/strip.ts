/**
 * THE STRIP — PRD §4.1. 220m × 35m, mirrored about x=0.
 *
 * Every dimension comes from WORLD.MAP rather than a literal, so the map and
 * the numbers cannot drift apart. §4.1's design constraint is that the whole
 * thing must be understandable from a single top-down image; the three layers
 * are the reason it can be:
 *
 *   LANE (y=0)      where creeps walk. Cover every 15m, alternating sides so a
 *                   sightline is never open for more than one spacing.
 *   ROOFS (y=6)     full sightlines, zero cover, reachable by mantle chain or
 *                   zipline. High ground that makes you visible to everyone.
 *   TUNNELS (y=−4)  no LOS to lane, pop out behind the enemy T1.
 *
 * MID PIT is a 22m square sunk 3m at map centre, crossed at grade by a 6m
 * catwalk so creeps march straight over it. The rim is exactly one standard
 * mantle (3.0m ≤ MANTLE_MAX 3.2), which is what makes dropping in committal:
 * getting out costs a mantle you cannot shoot through.
 */

import { type Aabb, aabb } from '../collision.js';
import { WORLD, ENTITY } from '../balance.js';
import { Team, StructureKind } from '../types.js';

export interface Zipline {
  id: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  length: number;
}

export interface StructureSite {
  team: Team;
  kind: StructureKind;
  x: number;
  z: number;
}

export interface GameMap {
  boxes: Aabb[];
  ziplines: Zipline[];
  structures: StructureSite[];
  heroSpawn: { [team: number]: { x: number; y: number; z: number; yaw: number } };
  trooperSpawn: { [team: number]: { x: number; z: number } };
  pitBoss: { x: number; y: number; z: number };
  /** greybox compatibility — THE STRIP has no shooting-range targets */
  targets: { x: number; y: number; z: number; minX: number; maxX: number; speed: number }[];
  spawn: { x: number; y: number; z: number; yaw: number };
}

const M = WORLD.MAP;
const HALF_L = M.LANE_LENGTH_M / 2; // 110
const HALF_W = M.LANE_WIDTH_M / 2; // 17.5
const PIT = M.PIT_HALF_EXTENT_M; // 11
const CAT = M.PIT_CATWALK_WIDTH_M / 2; // 3
const WALL_H = 14;
const FLOOR_T = 4; // floor slab thickness — nothing tunnels through it at any speed

function dedupe(v: number[]): number[] {
  const out = [...v].sort((a, b) => a - b);
  return out.filter((x, i) => i === 0 || Math.abs(x - out[i - 1]!) > 1e-6);
}

/** Floor tile that stops at the pit and the tunnel trenches. */
function floorSlab(boxes: Aabb[], x0: number, x1: number, z0: number, z1: number): void {
  if (x1 - x0 <= 0 || z1 - z0 <= 0) return;
  boxes.push(aabb(x0, -FLOOR_T, z0, x1, 0, z1));
}

export function buildStrip(): GameMap {
  const boxes: Aabb[] = [];
  const T_Z = M.TUNNEL_Z_ABS_M; // 16
  const T_HW = M.TUNNEL_WIDTH_M / 2; // 2
  const T_X = M.TUNNEL_EXIT_X_ABS_M; // 58 — tunnels span [−58, +58]
  const T_Y = M.TUNNEL_FLOOR_Y_M; // −4

  // ---- floor ---------------------------------------------------------------
  // Built as explicit rectangle subtraction rather than hand-written bands.
  // Writing the bands by hand is how the grey box ended up with a pit that was
  // filled in by its own floor, and how the first version of this map did the
  // same thing: the "keep the floor outside the catwalk" band silently covered
  // the pit as well. A grid plus two predicates cannot make that mistake.
  //
  // The trench also has to be clamped: TUNNEL_Z_ABS 16 with TUNNEL_WIDTH 4
  // spans z ∈ [14, 18] against a ±17.5 lane, so it pokes through the wall.
  const trenchLo = T_Z - T_HW;
  const trenchHi = Math.min(T_Z + T_HW, HALF_W);

  const xs = dedupe([-HALF_L, -PIT, PIT, HALF_L]);
  const zs = dedupe([
    -HALF_W, -trenchHi, -trenchLo, -PIT, -CAT, CAT, PIT, trenchLo, trenchHi, HALF_W,
  ]);

  const inTrench = (z0: number, z1: number): boolean => {
    const mid = (z0 + z1) / 2;
    return Math.abs(mid) >= trenchLo && Math.abs(mid) <= trenchHi;
  };
  const inPitHole = (x0: number, x1: number, z0: number, z1: number): boolean => {
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    if (Math.abs(mx) > PIT || Math.abs(mz) > PIT) return false;
    return Math.abs(mz) > CAT; // the catwalk stays at grade
  };

  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const x0 = xs[i]!, x1 = xs[i + 1]!, z0 = zs[j]!, z1 = zs[j + 1]!;
      if (inTrench(z0, z1)) continue;
      if (inPitHole(x0, x1, z0, z1)) continue;
      floorSlab(boxes, x0, x1, z0, z1);
    }
  }

  // Pit floor.
  boxes.push(aabb(-PIT, -M.PIT_DEPTH_M - FLOOR_T, -PIT, PIT, -M.PIT_DEPTH_M, PIT));

  // ---- tunnels ------------------------------------------------------------
  // A trench per wall, spanning [−58, +58], with a ramp at each end. Both teams
  // use both lines; §4.1's "2 per side" is satisfied by each team having two
  // mouths, which is cheaper geometry than four overlapping trenches.
  for (const sz of [-1, 1]) {
    const cz = sz * T_Z;
    const lo = sz < 0 ? -Math.min(T_Z + T_HW, HALF_W) : T_Z - T_HW;
    const hi = sz < 0 ? -(T_Z - T_HW) : Math.min(T_Z + T_HW, HALF_W);
    boxes.push(aabb(-T_X, T_Y - FLOOR_T, lo, T_X, T_Y, hi)); // trench floor
    // Ramps: 3.5m of run from grade down to the trench at each mouth.
    const RAMP = 3.5;
    for (const sx of [-1, 1]) {
      const mouth = sx * T_X;
      const steps = 7;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const y = -t * -T_Y; // 0 → 4
        const x0 = mouth + sx * (RAMP * t);
        boxes.push(aabb(
          Math.min(x0, x0 + sx * (RAMP / steps)), T_Y - FLOOR_T, cz - T_HW,
          Math.max(x0, x0 + sx * (RAMP / steps)), T_Y + (M.TUNNEL_FLOOR_Y_M + y === 0 ? 0 : y), cz + T_HW,
        ));
      }
    }
    // Roof over the trench so it genuinely has no LOS to lane.
    boxes.push(aabb(-T_X, T_Y + M.TUNNEL_HEIGHT_M, cz - T_HW - 0.4, T_X, T_Y + M.TUNNEL_HEIGHT_M + 0.6, cz + T_HW + 0.4));
  }

  // ---- perimeter ----------------------------------------------------------
  boxes.push(aabb(-HALF_L - 3, -FLOOR_T, -HALF_W - 3, HALF_L + 3, WALL_H, -HALF_W));
  boxes.push(aabb(-HALF_L - 3, -FLOOR_T, HALF_W, HALF_L + 3, WALL_H, HALF_W + 3));
  boxes.push(aabb(-HALF_L - 3, -FLOOR_T, -HALF_W - 3, -HALF_L, WALL_H, HALF_W + 3));
  boxes.push(aabb(HALF_L, -FLOOR_T, -HALF_W - 3, HALF_L + 3, WALL_H, HALF_W + 3));

  // ---- cover: sightline breakers every 15m, alternating sides -------------
  // §4.1. Cover is COVER_BLOCK_HEIGHT (3.0m) so it is a true sightline break
  // for a 1.8m hero, and exactly one mantle below the 6.0m roof deck — the
  // cover block IS the route up.
  const H = M.COVER_BLOCK_HEIGHT_M;
  let side = 1;
  for (let x = -HALF_L + M.COVER_BLOCK_SPACING_M; x < HALF_L; x += M.COVER_BLOCK_SPACING_M) {
    if (Math.abs(x) < PIT + 4) { side = -side; continue; } // the pit is its own arena
    const cz = side * 6.5;
    boxes.push(aabb(x - 3, 0, cz - 2, x + 3, H, cz + 2));
    // A low block opposite, so neither side of the lane is a free run.
    boxes.push(aabb(x - 2, 0, -cz - 1.5, x + 2, 1.1, -cz + 1.5));
    side = -side;
  }

  // ---- roof decks ---------------------------------------------------------
  // Two strips along the walls at 6.0m, reachable from cover by one mantle.
  for (const sz of [-1, 1]) {
    const cz = sz * (HALF_W - 3);
    boxes.push(aabb(-M.ZIPLINE_X_ABS_END_M, M.ROOF_HEIGHT_M, cz - 3, M.ZIPLINE_X_ABS_END_M, M.ROOF_HEIGHT_M + 0.4, cz + 3));
  }

  // ---- structures ---------------------------------------------------------
  const structures: StructureSite[] = [];
  for (const team of [Team.A, Team.B]) {
    const s = team === Team.A ? -1 : 1;
    structures.push({ team, kind: StructureKind.TowerT1, x: s * M.TOWER_T1_X_ABS_M, z: 0 });
    structures.push({ team, kind: StructureKind.TowerT2, x: s * M.TOWER_T2_X_ABS_M, z: 0 });
    structures.push({ team, kind: StructureKind.Core, x: s * M.CORE_X_ABS_M, z: 0 });
  }
  // Structures are solid: they block bullets and movement, so diving one is a
  // geometry problem as well as a damage one.
  for (const st of structures) {
    const dim = st.kind === StructureKind.Core ? WORLD.STRUCTURES.CORE_COLLIDER_M : WORLD.STRUCTURES.TOWER_COLLIDER_M;
    boxes.push(aabb(st.x - dim[0]! / 2, 0, st.z - dim[2]! / 2, st.x + dim[0]! / 2, dim[1]!, st.z + dim[2]! / 2));
  }

  // ---- ziplines -----------------------------------------------------------
  const ziplines: Zipline[] = [];
  const ZX = M.ZIPLINE_X_ABS_END_M;
  for (let i = 0; i < M.ZIPLINE_COUNT; i++) {
    const cz = (i === 0 ? -1 : 1) * M.ZIPLINE_Z_ABS_M;
    ziplines.push({ id: i, ax: -ZX, ay: M.ZIPLINE_Y_M, az: cz, bx: ZX, by: M.ZIPLINE_Y_M, bz: cz, length: ZX * 2 });
  }

  /**
   * Heroes spawn IN FRONT of their core, not behind it.
   *
   * §4.1 puts the spawn room 6m behind the core, which is the right fiction —
   * but the core is a solid 8m-wide collider sitting on the lane centreline, so
   * spawning behind it means every hero has to path around their own base to
   * leave. Bots have no pathfinder (§10.5 specifies a behaviour tree), so they
   * ground themselves against it: a diagnostic run had team B pinned at the far
   * wall for six straight minutes and every structure at 100%, which reads as a
   * balance problem and is actually a geometry one.
   *
   * The spawn room itself belongs in the map later, with a mouth that opens
   * forward. Until then the spawn point sits between the core and T2.
   */
  const spawnX = M.CORE_X_ABS_M - 6; // 94: clear of the core, behind T2
  const spawnA = { x: -spawnX, y: 0.05, z: 0, yaw: 2048 }; // facing +X
  const spawnB = { x: spawnX, y: 0.05, z: 0, yaw: 6144 }; // facing −X

  return {
    boxes,
    ziplines,
    structures,
    heroSpawn: { [Team.A]: spawnA, [Team.B]: spawnB },
    trooperSpawn: { [Team.A]: { x: -M.TROOPER_SPAWN_X_ABS_M, z: 0 }, [Team.B]: { x: M.TROOPER_SPAWN_X_ABS_M, z: 0 } },
    pitBoss: { x: 0, y: -M.PIT_DEPTH_M, z: -6 },
    targets: [],
    spawn: spawnA,
  };
}

/** Where a trooper of this team walks toward, given the structures still alive. */
export function laneAdvanceDir(team: Team): number {
  return team === Team.A ? 1 : -1;
}

export const HERO_EYE = ENTITY.EYE_HEIGHT_M;
