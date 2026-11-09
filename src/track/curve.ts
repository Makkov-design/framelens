import type { EasingFamily } from "../style/motion.js";

export type Bezier = [number, number, number, number];

/** A timing curve that maps progress through a move (0..1 of its duration) to progress of the value (0..1). */
export type Curve =
  | { kind: "bezier"; bezier: Bezier }
  | { kind: "linear" }
  /** CSS steps(n, jump-end): the value jumps at the end of each of n equal intervals. */
  | { kind: "steps"; steps: number }
  /**
   * A damped spring released at rest from 0 towards 1, with mass 1: stiffness = omega², damping = 2·zeta·omega.
   * `duration` is how long it takes to settle within 0.5 % of the travel (the move's length on the timeline);
   * `perceptualDuration` = 2π/omega and `bounce` = 1 − zeta are the SwiftUI / Motion style parameters.
   */
  | { kind: "spring"; stiffness: number; damping: number; mass: 1; omega: number; zeta: number; duration: number; perceptualDuration: number; bounce: number };

export const SETTLE = 0.005;

const sampleX = (s: number, a: number, c: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * c + s ** 3;
const slopeX = (s: number, a: number, c: number) => 3 * (1 - s) ** 2 * a + 6 * (1 - s) * s * (c - a) + 3 * s ** 2 * (1 - c);

/** CSS cubic-bezier value at input progress u (0..1). x1 and x2 must be in [0, 1] (they are clamped). */
export function bezierAt(b: Bezier, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const x1 = Math.min(1, Math.max(0, b[0]));
  const x2 = Math.min(1, Math.max(0, b[2]));
  // Newton from the input, then bisection when the slope is too flat to trust.
  let s = u;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(s, x1, x2) - u;
    if (Math.abs(err) < 1e-7) return sampleX(s, b[1], b[3]);
    const d = slopeX(s, x1, x2);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
    if (s < 0 || s > 1) break;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let i = 0; i < 40; i++) {
    const x = sampleX(s, x1, x2);
    if (Math.abs(x - u) < 1e-7) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleX(s, b[1], b[3]);
}

/** Spring progress after `tau` seconds (mass 1, released at rest). */
export function springAt(omega: number, zeta: number, tau: number): number {
  if (tau <= 0) return 0;
  if (zeta < 1 - 1e-6) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + ((zeta * omega) / wd) * Math.sin(wd * tau));
  }
  if (zeta <= 1 + 1e-6) return 1 - Math.exp(-omega * tau) * (1 + omega * tau);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r2 - r1);
}

/** Seconds until the spring stays within SETTLE of its target. */
export function springSettle(omega: number, zeta: number): number {
  const step = 1 / 240;
  const limit = 60;
  let last = 0;
  for (let tau = 0; tau < limit; tau += step) {
    if (Math.abs(1 - springAt(omega, zeta, tau)) > SETTLE) last = tau + step;
    else if (tau - last > Math.max(0.5, 4 / omega)) break;
  }
  return Math.min(limit, last);
}

export function springCurve(omega: number, zeta: number): Extract<Curve, { kind: "spring" }> {
  const r = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    kind: "spring",
    stiffness: r(omega * omega, 2),
    damping: r(2 * zeta * omega, 3),
    mass: 1,
    omega: r(omega, 4),
    zeta: r(zeta, 4),
    duration: r(springSettle(omega, zeta), 4),
    perceptualDuration: r((2 * Math.PI) / omega, 4),
    bounce: r(1 - zeta, 4),
  };
}

/** Value progress at move progress u (0..1 of the curve's duration). */
export function curveAt(curve: Curve, u: number): number {
  if (u <= 0) return 0;
  if (curve.kind === "spring") return u >= 1 ? 1 : springAt(curve.omega, curve.zeta, u * curve.duration);
  if (u >= 1) return 1;
  if (curve.kind === "linear") return u;
  if (curve.kind === "steps") return Math.floor(u * curve.steps) / curve.steps;
  return bezierAt(curve.bezier, u);
}

const n4 = (x: number) => String(Math.round(x * 10000) / 10000);

/** How far straight segments between a spring's points may stray from the spring, as a share of the travel. */
export const SPRING_TOLERANCE = 0.005;

/**
 * Points [progress through the move, value] of a spring for CSS linear() or a piecewise-linear ease: as few as keep
 * straight segments within SPRING_TOLERANCE of the spring (dense where it turns, sparse where it settles).
 */
export function springPoints(curve: Extract<Curve, { kind: "spring" }>, tolerance = SPRING_TOLERANCE): [number, number][] {
  const n = 2000;
  const u = Array.from({ length: n + 1 }, (_, i) => i / n);
  const v = u.map((x) => curveAt(curve, x));
  const keep = new Uint8Array(n + 1);
  keep[0] = 1;
  keep[n] = 1;
  // Douglas–Peucker on the dense samples.
  const stack: [number, number][] = [[0, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const line = v[a]! + ((v[b]! - v[a]!) * (u[i]! - u[a]!)) / (u[b]! - u[a]!);
      const d = Math.abs(v[i]! - line);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance * 0.8 && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const r5 = (x: number) => Math.round(x * 100000) / 100000;
  return u.flatMap((x, i) => (keep[i] ? [[r5(x), i === n ? 1 : r5(v[i]!)] as [number, number]] : []));
}

/** The curve as a CSS easing function: cubic-bezier(), linear() for springs, steps() or linear. */
export function cssEasing(curve: Curve): string {
  if (curve.kind === "bezier") return `cubic-bezier(${curve.bezier.map(n4).join(", ")})`;
  if (curve.kind === "linear") return "linear";
  if (curve.kind === "steps") return `steps(${curve.steps}, end)`;
  const pct = (x: number) => `${Math.round(x * 100000) / 1000}%`;
  return `linear(${springPoints(curve).map(([x, y], i, all) => (i === 0 || i === all.length - 1 ? n4(y) : `${n4(y)} ${pct(x)}`)).join(", ")})`;
}

/** Short human label: "cubic-bezier(…)", "spring(stiffness 170, damping 26, mass 1)", "steps(4)", "linear". */
export function curveLabel(curve: Curve): string {
  if (curve.kind === "spring") return `spring(stiffness ${curve.stiffness}, damping ${curve.damping}, mass 1; duration ${curve.perceptualDuration} s, bounce ${curve.bounce})`;
  return cssEasing(curve);
}

/** The easing family of a curve, for places that only keep a family. */
export function curveFamily(curve: Curve): EasingFamily {
  if (curve.kind === "linear") return "linear";
  if (curve.kind === "steps") return "unclear";
  if (curve.kind === "spring") return "ease-out";
  const [x1, y1, x2, y2] = curve.bezier;
  if (Math.abs(x1 - y1) < 0.05 && Math.abs(x2 - y2) < 0.05) return "linear";
  const startSlope = x1 > 1e-6 ? y1 / x1 : Infinity;
  const endSlope = 1 - x2 > 1e-6 ? (1 - y2) / (1 - x2) : Infinity;
  const slowStart = startSlope < 0.6;
  const slowEnd = endSlope < 0.6;
  if (slowStart && slowEnd) return "ease-in-out";
  if (slowEnd) return "ease-out";
  if (slowStart) return "ease-in";
  return "unclear";
}

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The curve with every number checked, or undefined. Curves end up inside generated code (GSAP, Remotion,
 * ExtendScript), and a spec file can be edited by anyone: only plain, bounded numbers pass.
 */
export function safeCurve(value: unknown): Curve | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  if (c.kind === "linear") return { kind: "linear" };
  if (c.kind === "steps") return finite(c.steps, 1, 1000) ? { kind: "steps", steps: Math.round(c.steps) } : undefined;
  if (c.kind === "bezier") {
    const b = c.bezier;
    if (!Array.isArray(b) || b.length !== 4) return undefined;
    const [x1, y1, x2, y2] = b;
    if (!finite(x1, 0, 1) || !finite(x2, 0, 1) || !finite(y1, -5, 5) || !finite(y2, -5, 5)) return undefined;
    return { kind: "bezier", bezier: [x1, y1, x2, y2] };
  }
  if (c.kind === "spring") {
    if (!finite(c.omega, 0.1, 1000) || !finite(c.zeta, 0.01, 20)) return undefined;
    return springCurve(c.omega, c.zeta);
  }
  return undefined;
}
