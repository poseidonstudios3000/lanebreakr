/**
 * mathd — deterministic math for packages/sim.
 *
 * WHY THIS FILE EXISTS
 * ECMAScript specifies Math.sin/cos/tan/atan2/pow/exp/log as
 * "implementation-approximated". V8, SpiderMonkey and JSC each ship their own
 * kernels, and V8 has changed its own across major versions — so a Node 22
 * server and a user's Chrome are not guaranteed to agree, let alone Firefox.
 * PRD §10.3 stakes the whole architecture on tick() being reproducible, and a
 * 1-ULP difference is not a slow drift here: capsule collide-and-slide is dense
 * in `if (t < eps)` tests, so one flipped branch changes which face you slide
 * along and the divergence is macroscopic inside a single tick.
 *
 * What IS portable, and is therefore all this file uses:
 *   +  -  *  /  %   — spec-mandated IEEE-754 round-to-nearest-even. FMA
 *                     contraction is spec-illegal (each op must round), so JIT
 *                     tier-up cannot change a result.
 *   Math.sqrt        — nominally in the same "approximated" list, but every
 *                     shipping engine lowers it to the hardware sqrtsd/vsqrtsd
 *                     instruction, which IEEE-754 requires to be correctly
 *                     rounded. Safe in practice, and there is no cheap
 *                     alternative.
 *   Math.floor/ceil/round/trunc/abs/min/max/sign — exact.
 *
 * Kernels below are the fdlibm minimax polynomials (Sun Microsystems, 1993),
 * transcribed to straight-line arithmetic. Evaluation order is written out
 * explicitly and must not be "simplified" — the ordering is what makes the
 * result bit-stable.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const TWO_OVER_PI = 0.6366197723675814;

// __kernel_sin coefficients, valid on |x| <= pi/4
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

// __kernel_cos coefficients, valid on |x| <= pi/4
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x: number): number {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + x * z * (S1 + z * r);
}

function kernelCos(x: number): number {
  const z = x * x;
  const r = C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)));
  return 1.0 - 0.5 * z + z * z * (C1 + z * r);
}

/**
 * Range reduction to a quadrant. Cody-Waite two-part subtraction of pi/2 keeps
 * the reduced argument accurate for the magnitudes a game sim ever sees
 * (|x| well under 2^20 radians). Both halves are exactly representable
 * doubles, so the subtraction itself introduces no error of its own.
 */
const PIO2_HI = 1.57079632673412561417e0;
const PIO2_LO = 6.07710050650619224932e-11;

function reduce(x: number): { q: number; r: number } {
  const n = Math.round(x * TWO_OVER_PI);
  const r = x - n * PIO2_HI - n * PIO2_LO;
  // q is the quadrant index, always a non-negative small integer
  const q = ((n % 4) + 4) % 4;
  return { q, r };
}

export function sin(x: number): number {
  const { q, r } = reduce(x);
  switch (q) {
    case 0: return kernelSin(r);
    case 1: return kernelCos(r);
    case 2: return -kernelSin(r);
    default: return -kernelCos(r);
  }
}

export function cos(x: number): number {
  const { q, r } = reduce(x);
  switch (q) {
    case 0: return kernelCos(r);
    case 1: return -kernelSin(r);
    case 2: return -kernelCos(r);
    default: return kernelSin(r);
  }
}

// __kernel_atan coefficients (fdlibm), for |x| <= 7/16 after reduction
const A0 = 3.33333333333329318027e-1;
const A1 = -1.99999999998764832476e-1;
const A2 = 1.42857142725034663711e-1;
const A3 = -1.11111104054623557880e-1;
const A4 = 9.09088713343650656196e-2;
const A5 = -7.69187620504482999495e-2;
const A6 = 6.66107313738753120669e-2;
const A7 = -5.83357013379057348645e-2;
const A8 = 4.97687799461593236017e-2;
const A9 = -3.65315727442169155270e-2;
const A10 = 1.62858201153657823623e-2;

/** The correction term x·(s1+s2); atan(x) = x − atanPoly(x) on |x| ≤ 7/16. */
function atanPoly(x: number): number {
  const z = x * x;
  const w = z * z;
  const s1 = z * (A0 + w * (A2 + w * (A4 + w * (A6 + w * (A8 + w * A10)))));
  const s2 = w * (A1 + w * (A3 + w * (A5 + w * (A7 + w * A9))));
  return x * (s1 + s2);
}

/**
 * Four-way argument reduction, exactly as fdlibm does it. Two branches is not
 * enough: the polynomial is only valid on |x| ≤ 7/16, so anything in roughly
 * [0.44, 2.44] must be folded onto a nearby exact atan value first. Each
 * anchor is stored as a hi/lo pair so the subtraction does not lose the low
 * bits — which is the whole reason this reaches 1e-16 instead of 1e-5.
 */
const ATAN_HI = [
  4.63647609000806093515e-1, // atan(0.5)
  7.85398163397448278999e-1, // atan(1.0)
  9.82793723247329054082e-1, // atan(1.5)
  1.57079632679489655800e0, // atan(inf)
];
const ATAN_LO = [
  2.26987774529616870924e-17,
  3.06161699786838301793e-17,
  1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];

export function atan(x: number): number {
  const ax = x < 0 ? -x : x;

  if (ax < 0.4375) {
    const r = ax - atanPoly(ax);
    return x < 0 ? -r : r;
  }

  let id: number;
  let t: number;
  if (ax < 0.6875) {
    id = 0;
    t = (2.0 * ax - 1.0) / (2.0 + ax);
  } else if (ax < 1.1875) {
    id = 1;
    t = (ax - 1.0) / (ax + 1.0);
  } else if (ax < 2.4375) {
    id = 2;
    t = (ax - 1.5) / (1.0 + 1.5 * ax);
  } else {
    id = 3;
    t = -1.0 / ax;
  }

  const r = ATAN_HI[id]! - (atanPoly(t) - ATAN_LO[id]! - t);
  return x < 0 ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (x === 0) {
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    return 0;
  }
  const a = atan(y / x);
  if (x > 0) return a;
  return y >= 0 ? a + PI : a - PI;
}

/** Integer exponent power by squaring — exact, unlike Math.pow. */
export function powi(base: number, exp: number): number {
  let e = exp < 0 ? -exp : exp;
  let b = base;
  let acc = 1;
  while (e > 0) {
    if (e & 1) acc = acc * b;
    b = b * b;
    e >>= 1;
  }
  return exp < 0 ? 1 / acc : acc;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  // (1-t)*a + t*b, not a + t*(b-a): the former is monotonic and exact at t=1.
  return (1 - t) * a + t * b;
}

/** Shortest signed angular difference, result in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > PI) d -= TAU;
  if (d <= -PI) d += TAU;
  return d;
}

export { Math_sqrt as sqrt };
const Math_sqrt = Math.sqrt;
