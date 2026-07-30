/**
 * greybox — the M0 arena. Not content: this is the fun gate (PRD §12/M0).
 *
 * Deliberately exercises every M0 acceptance criterion in one space:
 *   - cover blocks at SMG falloff distances, so range actually reads
 *   - a 1.2m and a 2.4m ledge, for the mantle criterion (2.4m is above
 *     MANTLE_MAX_HEIGHT_M — it must be reached by jump-mantle, not walk-up)
 *   - a full-length zipline, for the traverse criterion
 *   - a corner pair, for the peek test
 *   - a sunken pit, standing in for MID PIT commitment
 */

import { type Aabb, aabb, box } from '../collision.js';
import { M0 } from '../balance.js';

export interface Zipline {
  id: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  length: number;
}

export interface GreyboxMap {
  boxes: Aabb[];
  ziplines: Zipline[];
  spawn: { x: number; y: number; z: number; yaw: number };
  targets: { x: number; y: number; z: number; minX: number; maxX: number; speed: number }[];
}

const HX = M0.ARENA_HALF_X_M;
const HZ = M0.ARENA_HALF_Z_M;
const WALL = M0.ARENA_WALL_HEIGHT_M;

export function buildGreybox(): GreyboxMap {
  const boxes: Aabb[] = [];

  // Floor, thick enough that nothing tunnels through it at any speed.
  boxes.push(aabb(-HX - 2, -4, -HZ - 2, HX + 2, 0, HZ + 2));

  // Perimeter walls.
  boxes.push(aabb(-HX - 2, 0, -HZ - 2, -HX, WALL, HZ + 2));
  boxes.push(aabb(HX, 0, -HZ - 2, HX + 2, WALL, HZ + 2));
  boxes.push(aabb(-HX - 2, 0, -HZ - 2, HX + 2, WALL, -HZ));
  boxes.push(aabb(-HX - 2, 0, HZ, HX + 2, WALL, HZ + 2));

  // --- Cover, placed at the SMG's falloff landmarks (18m, 40m) so a player
  //     can feel where damage starts dropping without being told. ---
  boxes.push(box(-18, 0, -6, 4, 2.0, 4));
  boxes.push(box(-18, 0, 6, 4, 2.0, 4));
  boxes.push(box(0, 0, -12, 6, 1.2, 3)); // vaultable — 1.2m ledge criterion
  boxes.push(box(0, 0, 12, 6, 1.2, 3));
  boxes.push(box(18, 0, -6, 4, 2.0, 4));
  boxes.push(box(18, 0, 6, 4, 2.0, 4));

  // --- The peek corner. Two walls forming an L, for tools/peek-test. ---
  boxes.push(box(-8, 0, 0, 0.6, 3.0, 10));
  boxes.push(box(-4.7, 0, 5, 7, 3.0, 0.6));

  // --- Mantle stack: 1.2m step onto a 2.4m platform. The 2.4m face is above
  //     MANTLE_MAX_HEIGHT_M (2.2), so it is only reachable by jumping first —
  //     which is exactly the interaction the criterion is testing. ---
  boxes.push(box(28, 0, -16, 6, 1.2, 6));
  boxes.push(box(34, 0, -16, 6, 2.4, 6));
  boxes.push(box(30, 0, 16, 10, 2.4, 8)); // the roof analogue

  // --- Sunken pit. Committal: you drop in, you mantle or dash out. ---
  // Built as a floor cut-out: four rim boxes leave a 12×12 hole 2.0m deep.
  const P = 12, D = 2.0;
  boxes.push(aabb(-HX - 2, -4, -HZ - 2, -P, 0, HZ + 2));
  boxes.push(aabb(P, -4, -HZ - 2, HX + 2, 0, HZ + 2));
  boxes.push(aabb(-P, -4, -HZ - 2, P, 0, -P));
  boxes.push(aabb(-P, -4, P, P, 0, HZ + 2));
  boxes.push(aabb(-P, -4 - D, -P, P, -D, P)); // pit floor

  const ziplines: Zipline[] = [
    { id: 0, ax: -34, ay: 7.5, az: -22, bx: 34, by: 7.5, bz: -22, length: 68 },
    { id: 1, ax: 34, ay: 7.5, az: 22, bx: -34, by: 7.5, bz: 22, length: 68 },
  ];

  return {
    boxes,
    ziplines,
    spawn: { x: -30, y: 0.05, z: 0, yaw: 0 },
    targets: [
      { x: 6, y: 0, z: -4, minX: 6, maxX: 6, speed: 0 },
      { x: 14, y: 0, z: 3, minX: 14, maxX: 14, speed: 0 },
      { x: 24, y: 0, z: -8, minX: 24, maxX: 24, speed: 0 },
      { x: 38, y: 0, z: 4, minX: 38, maxX: 38, speed: 0 }, // past falloff end
      { x: 0, y: 2.4, z: 16, minX: 0, maxX: 0, speed: 0 }, // elevated
      { x: 10, y: 0, z: 10, minX: 4, maxX: 20, speed: 4.5 }, // strafing
      { x: -6, y: -2.0, z: 0, minX: -9, maxX: 9, speed: 6.0 }, // in the pit
    ],
  };
}
