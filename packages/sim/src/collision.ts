/**
 * collision — capsule collide-and-slide, ray primitives, swept sphere.
 *
 * Only + − × ÷ and Math.sqrt appear here, which is what makes it portable
 * (see mathd.ts). Iteration counts are FIXED, never "until converged": a
 * convergence loop is a place where one engine takes 3 passes and another
 * takes 4, and that is a determinism bug that will not reproduce on your
 * machine.
 *
 * PRD §10.1 originally enumerated "capsule collide-and-slide, raycasts, sphere
 * overlaps. That's it." Swept tests are the missing primitive: a 45 m/s
 * projectile advances 0.75m per tick at 60Hz against a ~0.80m-wide hero
 * capsule, so a discrete per-tick position test lets RIFT's rockets pass
 * cleanly through people.
 */

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface Hit {
  hit: boolean;
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

const NO_HIT: Readonly<Hit> = {
  hit: false, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
};

export function aabb(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): Aabb {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Box centred on (cx, cy+height/2, cz). The shape most level data is authored as. */
export function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Aabb {
  const hx = sx / 2;
  const hz = sz / 2;
  return { minX: cx - hx, minY: cy, minZ: cz - hz, maxX: cx + hx, maxY: cy + sy, maxZ: cz + hz };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Capsule vs AABB
// ---------------------------------------------------------------------------

export interface Penetration {
  depth: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Deepest penetration of a vertical capsule against one box.
 * The capsule's foot is at (x, y, z); its axis runs from y+r to y+h−r.
 */
export function capsuleVsBox(
  x: number, y: number, z: number,
  radius: number, height: number,
  b: Aabb,
): Penetration | null {
  const ay = y + radius;
  const by = y + height - radius;

  // Point on the capsule axis closest to the box's Y span.
  let cy: number;
  if (ay > b.maxY) cy = ay;
  else if (by < b.minY) cy = by;
  else cy = clamp((Math.max(ay, b.minY) + Math.min(by, b.maxY)) * 0.5, ay, by);

  const qx = clamp(x, b.minX, b.maxX);
  const qy = clamp(cy, b.minY, b.maxY);
  const qz = clamp(z, b.minZ, b.maxZ);

  let dx = x - qx;
  let dy = cy - qy;
  let dz = z - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 >= radius * radius) return null;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    return { depth: radius - d, nx: dx / d, ny: dy / d, nz: dz / d };
  }

  // Deep inside: push out along the axis with the least overlap. Ties resolve
  // in a fixed order (X, then Y, then Z) so the choice is reproducible.
  const ox = Math.min(x - b.minX, b.maxX - x);
  const oy = Math.min(cy - b.minY, b.maxY - cy);
  const oz = Math.min(z - b.minZ, b.maxZ - z);
  if (ox <= oy && ox <= oz) {
    dx = x - (b.minX + b.maxX) * 0.5;
    return { depth: radius + ox, nx: dx >= 0 ? 1 : -1, ny: 0, nz: 0 };
  }
  if (oy <= oz) {
    dy = cy - (b.minY + b.maxY) * 0.5;
    return { depth: radius + oy, nx: 0, ny: dy >= 0 ? 1 : -1, nz: 0 };
  }
  dz = z - (b.minZ + b.maxZ) * 0.5;
  return { depth: radius + oz, nx: 0, ny: 0, nz: dz >= 0 ? 1 : -1 };
}

export interface SlideResult {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  hitWall: boolean;
}

const SLIDE_ITERATIONS = 4; // FIXED. Never "while (penetrating)".
const SKIN = 0.001;

/**
 * Move a capsule by (dx,dy,dz), depenetrating and projecting velocity onto
 * every surface it touches.
 */
export function moveAndSlide(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  dx: number, dy: number, dz: number,
  radius: number, height: number,
  boxes: readonly Aabb[],
  groundSlopeCos: number,
): SlideResult {
  let px = x + dx;
  let py = y + dy;
  let pz = z + dz;
  let grounded = false;
  let hitWall = false;

  for (let iter = 0; iter < SLIDE_ITERATIONS; iter++) {
    let deepest: Penetration | null = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const p = capsuleVsBox(px, py, pz, radius, height, b);
      if (p !== null && (deepest === null || p.depth > deepest.depth)) deepest = p;
    }
    if (deepest === null) break;

    const push = deepest.depth + SKIN;
    px += deepest.nx * push;
    py += deepest.ny * push;
    pz += deepest.nz * push;

    if (deepest.ny >= groundSlopeCos) {
      grounded = true;
      if (vy < 0) vy = 0;
    } else if (deepest.ny <= -0.7) {
      if (vy > 0) vy = 0; // head bonk
    } else {
      hitWall = true;
    }

    // Project velocity onto the contact plane.
    const dot = vx * deepest.nx + vy * deepest.ny + vz * deepest.nz;
    if (dot < 0) {
      vx -= deepest.nx * dot;
      vy -= deepest.ny * dot;
      vz -= deepest.nz * dot;
    }
  }

  return { x: px, y: py, z: pz, vx, vy, vz, grounded, hitWall };
}

/** Is there ground within `probe` metres below the capsule? */
export function groundProbe(
  x: number, y: number, z: number,
  radius: number, height: number,
  probe: number,
  boxes: readonly Aabb[],
  groundSlopeCos: number,
): boolean {
  for (let i = 0; i < boxes.length; i++) {
    const p = capsuleVsBox(x, y - probe, z, radius, height, boxes[i]!);
    if (p !== null && p.ny >= groundSlopeCos) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rays
// ---------------------------------------------------------------------------

/** Slab method. `dir` must be unit length. */
export function rayVsBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  b: Aabb,
): Hit {
  const ix = dx !== 0 ? 1 / dx : 1e30;
  const iy = dy !== 0 ? 1 / dy : 1e30;
  const iz = dz !== 0 ? 1 / dz : 1e30;

  let t1 = (b.minX - ox) * ix;
  let t2 = (b.maxX - ox) * ix;
  let tmin = Math.min(t1, t2);
  let tmax = Math.max(t1, t2);
  let axis = 0;
  let sign = t1 > t2 ? 1 : -1;

  t1 = (b.minY - oy) * iy;
  t2 = (b.maxY - oy) * iy;
  const ymin = Math.min(t1, t2);
  if (ymin > tmin) { tmin = ymin; axis = 1; sign = t1 > t2 ? 1 : -1; }
  tmax = Math.min(tmax, Math.max(t1, t2));

  t1 = (b.minZ - oz) * iz;
  t2 = (b.maxZ - oz) * iz;
  const zmin = Math.min(t1, t2);
  if (zmin > tmin) { tmin = zmin; axis = 2; sign = t1 > t2 ? 1 : -1; }
  tmax = Math.min(tmax, Math.max(t1, t2));

  if (tmax < 0 || tmin > tmax || tmin > maxT) return { ...NO_HIT };
  const t = tmin < 0 ? 0 : tmin;

  return {
    hit: true,
    t,
    x: ox + dx * t,
    y: oy + dy * t,
    z: oz + dz * t,
    nx: axis === 0 ? sign : 0,
    ny: axis === 1 ? sign : 0,
    nz: axis === 2 ? sign : 0,
  };
}

export function rayVsBoxes(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  boxes: readonly Aabb[],
): Hit {
  let best: Hit = { ...NO_HIT, t: maxT };
  let found = false;
  for (let i = 0; i < boxes.length; i++) {
    const h = rayVsBox(ox, oy, oz, dx, dy, dz, maxT, boxes[i]!);
    if (h.hit && h.t <= best.t) { best = h; found = true; }
  }
  return found ? best : { ...NO_HIT };
}

/** Ray vs sphere — the head hitbox, and the soul orb. */
export function rayVsSphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  cx: number, cy: number, cz: number, r: number,
): Hit {
  const ex = cx - ox;
  const ey = cy - oy;
  const ez = cz - oz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b < 0) return { ...NO_HIT };
  const disc = b * b - c;
  if (disc < 0) return { ...NO_HIT };
  const sq = Math.sqrt(disc);
  let t = b - sq;
  if (t < 0) t = b + sq;
  if (t < 0 || t > maxT) return { ...NO_HIT };
  const hx = ox + dx * t;
  const hy = oy + dy * t;
  const hz = oz + dz * t;
  return { hit: true, t, x: hx, y: hy, z: hz, nx: (hx - cx) / r, ny: (hy - cy) / r, nz: (hz - cz) / r };
}

/**
 * Ray vs vertical capsule — the body hitbox. Cylinder body plus two end caps;
 * the caps matter, because "I shot his feet and it missed" is the kind of bug
 * that reads as netcode and is actually geometry.
 */
export function rayVsCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  bx: number, by: number, bz: number,
  radius: number, height: number,
): Hit {
  const y0 = by + radius;
  const y1 = by + height - radius;

  // Infinite cylinder in XZ.
  const ex = ox - bx;
  const ez = oz - bz;
  const a = dx * dx + dz * dz;
  const bq = ex * dx + ez * dz;
  const cq = ex * ex + ez * ez - radius * radius;

  let best = maxT;
  let hitAny = false;
  let hx = 0, hy = 0, hz = 0, nx = 0, ny = 0, nz = 0;

  if (a > 1e-12) {
    const disc = bq * bq - a * cq;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-bq - sq) / a;
      if (t < 0) t = (-bq + sq) / a;
      if (t >= 0 && t <= best) {
        const py = oy + dy * t;
        if (py >= y0 && py <= y1) {
          hx = ox + dx * t; hy = py; hz = oz + dz * t;
          nx = (hx - bx) / radius; ny = 0; nz = (hz - bz) / radius;
          best = t; hitAny = true;
        }
      }
    }
  }

  const capLow = rayVsSphere(ox, oy, oz, dx, dy, dz, best, bx, y0, bz, radius);
  if (capLow.hit && capLow.t <= best) {
    best = capLow.t; hx = capLow.x; hy = capLow.y; hz = capLow.z;
    nx = capLow.nx; ny = capLow.ny; nz = capLow.nz; hitAny = true;
  }
  const capHigh = rayVsSphere(ox, oy, oz, dx, dy, dz, best, bx, y1, bz, radius);
  if (capHigh.hit && capHigh.t <= best) {
    best = capHigh.t; hx = capHigh.x; hy = capHigh.y; hz = capHigh.z;
    nx = capHigh.nx; ny = capHigh.ny; nz = capHigh.nz; hitAny = true;
  }

  return hitAny
    ? { hit: true, t: best, x: hx, y: hy, z: hz, nx, ny, nz }
    : { ...NO_HIT };
}

/**
 * Swept sphere vs AABB — the primitive PRD v1.0 omitted. Conservative: expands
 * the box by the sphere radius and rays through it. Slightly generous at the
 * corners, which is the correct direction to err for a projectile.
 */
export function sweptSphereVsBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  r: number,
  b: Aabb,
): Hit {
  return rayVsBox(ox, oy, oz, dx, dy, dz, maxT, {
    minX: b.minX - r, minY: b.minY - r, minZ: b.minZ - r,
    maxX: b.maxX + r, maxY: b.maxY + r, maxZ: b.maxZ + r,
  });
}
