import { bezierAt, curveAt, springAt, springCurve, type Bezier, type Curve } from "./curve.js";

/** Minimises f from x0 with the Nelder–Mead simplex method. `step` is the initial size of the simplex per axis. */
export function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], options: { iterations?: number; tolerance?: number } = {}): { x: number[]; value: number } {
  const n = x0.length;
  const iterations = options.iterations ?? 400 * n;
  const tolerance = options.tolerance ?? 1e-12;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[i]! : v)))];
  let values = simplex.map(f);
  for (let k = 0; k < iterations; k++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    simplex = order.map(([, i]) => simplex[i]!);
    values = order.map(([v]) => v);
    if (Math.abs(values[n]! - values[0]!) <= tolerance * (Math.abs(values[0]!) + 1e-15)) break;
    const centroid = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j]!, 0) / n);
    const worst = simplex[n]!;
    const at = (c: number) => centroid.map((v, j) => v + c * (worst[j]! - v));
    const reflected = at(-1);
    const fr = f(reflected);
    if (fr < values[0]!) {
      const expanded = at(-2);
      const fe = f(expanded);
      [simplex[n], values[n]] = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < values[n - 1]!) {
      [simplex[n], values[n]] = [reflected, fr];
    } else {
      const contracted = fr < values[n]! ? at(-0.5) : at(0.5);
      const fc = f(contracted);
      if (fc < Math.min(fr, values[n]!)) {
        [simplex[n], values[n]] = [contracted, fc];
      } else {
        const best = simplex[0]!;
        simplex = simplex.map((p, i) => (i === 0 ? p : p.map((v, j) => best[j]! + 0.5 * (v - best[j]!))));
        values = simplex.map((p, i) => (i === 0 ? values[0]! : f(p)));
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best]!, value: values[best]! };
}

/** Runs Nelder–Mead again from its own result until it stops improving (escapes collapsed simplices). */
function polish(f: (x: number[]) => number, x0: number[], step: number[], rounds = 4): { x: number[]; value: number } {
  let best = nelderMead(f, x0, step);
  for (let i = 0; i < rounds; i++) {
    const next = nelderMead(f, best.x, step.map((s) => s / (2 + i)));
    if (next.value >= best.value - 1e-15) break;
    best = next;
  }
  return best;
}

export interface PropertyFit {
  /** Resting value before and after the move, in the property's own unit. */
  from: number;
  to: number;
  /** Seconds, on the source timeline. For a spring, `end` is when it settles within 0.5 % of the travel. */
  start: number;
  end: number;
  /** Length of the move in frames (fractional: a curve can start between two frames). */
  frames: number;
  seconds: number;
  curve: Curve;
  /** Root-mean-square and largest error of the fitted curve, as a fraction of the travel. */
  rmse: number;
  maxError: number;
  /** Error of every model that was tried, for the record. */
  alternatives: { kind: Curve["kind"]; rmse: number }[];
  /** How far the value goes past its target, as a fraction of the travel (0 when it does not). */
  overshoot: number;
  /** Times the value swings back across its target after first reaching it. */
  oscillations: number;
  /** Noise of the samples, as a fraction of the travel. */
  noise: number;
  /** Why the chosen model won. */
  reason: string;
  /**
   * The window cuts the move: no resting samples before its start ("start") or after its end ("end"). The curve then
   * describes only the part seen, and its error says nothing about the whole move.
   */
  cut?: "start" | "end" | "both";
  /** False when the move is too short (5 frames or fewer) to tell one curve from another. */
  identifiable: boolean;
  /**
   * `exact`: error within 1 % of the travel (or within the sample noise); `approximate`: within 3 %; `unreliable`:
   * larger, cut by the window, or too short to identify. Exports use only exact and approximate curves.
   */
  quality: "exact" | "approximate" | "unreliable";
}

/** The largest fit error (fraction of the travel) a curve may have to be exported. */
export const EXPORT_MAX_ERROR = 0.03;
/** Moves this short or shorter (frames) fit almost any curve: their shape cannot be identified. */
export const MIN_IDENTIFIABLE_FRAMES = 5;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/**
 * Sample noise from second differences (σ·√6 per difference). Smooth motion barely moves them, but fast or springy
 * motion does: prefer `restNoise` once the resting samples are known.
 */
export function noiseLevel(v: number[]): number {
  const d2: number[] = [];
  for (let i = 1; i < v.length - 1; i++) d2.push(Math.abs(v[i + 1]! - 2 * v[i]! + v[i - 1]!));
  return (1.4826 * median(d2)) / Math.sqrt(6);
}

/** Sample noise from the resting samples alone (σ·√2 per first difference), or undefined with fewer than 3. */
export function restNoise(rest: number[][]): number | undefined {
  const d: number[] = [];
  for (const part of rest) for (let i = 1; i < part.length; i++) d.push(Math.abs(part[i]! - part[i - 1]!));
  return d.length >= 3 ? (1.4826 * median(d)) / Math.SQRT2 : undefined;
}

const BEZIER_STARTS: Bezier[] = [
  [0.25, 0.1, 0.25, 1],
  [0.42, 0, 1, 1],
  [0, 0, 0.58, 1],
  [0.42, 0, 0.58, 1],
  [0.16, 1, 0.3, 1],
  [0.7, 0, 0.84, 0],
  [0.34, 1.56, 0.64, 1],
  [0.33, 0.33, 0.67, 0.67],
  [0.65, 0, 0.35, 1],
  [0.5, 0.5, 0.1, 1],
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const out01 = (x: number) => (x < 0 ? -x : x > 1 ? x - 1 : 0);

/**
 * Fits one property's move: finds where it rests before and after, then fits a cubic-bezier, a spring, a straight
 * line and steps over the samples with the start and length of the move as free parameters, and picks one:
 * - steps when they explain the samples at least twice as well as any smooth curve;
 * - a spring when the value swings back across its target at least once (and the spring fits no worse than 1.5× the
 *   bezier's error), or overshoots and the spring fits better;
 * - linear when it is within 25 % (plus 0.2 % of the travel) of the bezier's error;
 * - otherwise the cubic-bezier.
 * Returns undefined when the property does not go from one resting value to another (flat, or too few samples).
 */
export function fitProperty(times: number[], values: number[], fps: number, options: { minTravel?: number } = {}): PropertyFit | undefined {
  const pairs = times.map((t, i) => [t, values[i]!] as const).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (pairs.length < 4 || !(fps > 0)) return undefined;
  const f = pairs.map(([t]) => t * fps);
  const v = pairs.map(([, x]) => x);
  const n = v.length;
  let sigma = noiseLevel(v);
  const head = Math.min(3, Math.max(1, Math.floor(n / 6)));
  let v0 = median(v.slice(0, head));
  let v1 = median(v.slice(n - head));
  const travel = Math.abs(v1 - v0);
  const minTravel = Math.max(options.minTravel ?? 0, 6 * sigma, 1e-9);
  if (travel < minTravel) return undefined;
  let threshold = Math.max(0.01 * travel, 4 * sigma);
  const findEdges = () => {
    const first = v.findIndex((x) => Math.abs(x - v0) > threshold);
    // A jump between two frames has no sample in between: the move is that one frame.
    const last = Math.max(first, n - 1 - [...v].reverse().findIndex((x) => Math.abs(x - v1) > threshold));
    return [first, last] as const;
  };
  let [onset, offset] = findEdges();
  if (onset < 0) return undefined;
  if (onset > 0) v0 = median(v.slice(0, onset));
  if (offset < n - 1) v1 = median(v.slice(offset + 1));
  // Noise from the resting samples only: second differences read a fast spring as noise.
  const quiet = restNoise([v.slice(0, onset), v.slice(offset + 1)]);
  if (quiet !== undefined) {
    sigma = quiet;
    threshold = Math.max(0.01 * Math.abs(v1 - v0), 4 * sigma);
    [onset, offset] = findEdges();
    if (onset < 0) return undefined;
    if (onset > 0) v0 = median(v.slice(0, onset));
    if (offset < n - 1) v1 = median(v.slice(offset + 1));
  }
  const delta = v1 - v0;
  if (Math.abs(delta) < Math.max(options.minTravel ?? 0, 6 * sigma, 1e-9)) return undefined;
  [onset, offset] = findEdges();
  if (onset < 0) return undefined;
  const lo = Math.max(0, onset - 6);
  const hi = Math.min(n - 1, offset + 6);
  const fs = f.slice(lo, hi + 1);
  const ps = v.slice(lo, hi + 1).map((x) => (x - v0) / delta);
  const m = fs.length;
  const sse = (model: (frame: number) => number) => {
    let s = 0;
    for (let i = 0; i < m; i++) s += (model(fs[i]!) - ps[i]!) ** 2;
    return s;
  };
  const rmse = (value: number) => Math.sqrt(value / m);
  const onsetF = f[onset]!;
  const offsetF = f[Math.min(n - 1, offset + 1)]!;
  const guessStart = onsetF - 1;
  const guessLength = Math.max(1, offsetF - guessStart);

  // Bezier: [start frame, length in frames, x1, y1, x2, y2].
  const bezierLoss = (p: number[]) => {
    const d = Math.max(0.3, p[1]!);
    const b: Bezier = [clamp01(p[2]!), p[3]!, clamp01(p[4]!), p[5]!];
    return sse((fr) => bezierAt(b, (fr - p[0]!) / d)) + 10 * (out01(p[2]!) ** 2 + out01(p[4]!) ** 2) + (p[1]! < 0.3 ? (0.3 - p[1]!) ** 2 : 0);
  };
  const starts: number[][] = [];
  for (const b of BEZIER_STARTS) for (const [ds, dl] of [[0, 0], [-1.5, 1.5], [0.5, -0.5], [-3, 3]] as const) starts.push([guessStart + ds, Math.max(0.5, guessLength + dl), ...b]);
  starts.sort((a, b) => bezierLoss(a) - bezierLoss(b));
  let bez = { x: starts[0]!, value: Infinity };
  for (const s of starts.slice(0, 4)) {
    const r = polish(bezierLoss, s, [1, 1.5, 0.15, 0.2, 0.15, 0.2]);
    if (r.value < bez.value) bez = r;
  }
  const bezier: Bezier = [clamp01(bez.x[2]!), bez.x[3]!, clamp01(bez.x[4]!), bez.x[5]!].map((x) => Math.round(x * 10000) / 10000) as Bezier;
  const bezStart = bez.x[0]!;
  const bezLength = Math.max(0.3, bez.x[1]!);
  const bezRmse = rmse(sse((fr) => bezierAt(bezier, (fr - bezStart) / bezLength)));

  // Linear: [start, length].
  const linearLoss = (p: number[]) => sse((fr) => clamp01((fr - p[0]!) / Math.max(0.3, p[1]!)));
  const lin = polish(linearLoss, [bezStart, bezLength], [1, 1.5]);
  const linRmse = rmse(lin.value);

  // Steps: [start, length] for each count; the jumps are hard edges, so start from a grid of offsets.
  let steps = { count: 0, x: [0, 0], value: Infinity };
  for (let count = 2; count <= Math.min(24, Math.max(2, Math.floor(bezLength))); count++) {
    const loss = (p: number[]) => sse((fr) => {
      const u = (fr - p[0]!) / Math.max(0.3, p[1]!);
      return u <= 0 ? 0 : u >= 1 ? 1 : Math.floor(u * count) / count;
    });
    // The loss is flat between sample times, so search a grid first and polish the best cell. With jump-end steps
    // the first jump (start + length / count) falls between the last resting frame and the first moved one.
    let cell = { x: [bezStart, bezLength], value: Infinity };
    for (let length = Math.max(1, bezLength - 4); length <= bezLength + 4; length += 0.25) {
      for (let d = 0; d < 1; d += 0.125) {
        const x = [onsetF - length / count - d, length];
        const value = loss(x);
        if (value < cell.value) cell = { x, value };
      }
    }
    const r = nelderMead(loss, cell.x, [0.2, 0.2]);
    const best = r.value < cell.value ? r : cell;
    if (best.value < steps.value - 1e-12) steps = { count, x: best.x, value: best.value };
  }
  const stepsRmse = steps.count ? rmse(steps.value) : Infinity;

  // Spring: [start, ln(omega rad/s), zeta]; time runs in seconds so the parameters match CSS / Remotion springs.
  const springLoss = (p: number[]) => {
    const omega = Math.exp(p[1]!);
    const zeta = Math.min(3, Math.max(0.03, p[2]!));
    return sse((fr) => springAt(omega, zeta, (fr - p[0]!) / fps)) + (p[2]! < 0.03 ? (0.03 - p[2]!) ** 2 : 0);
  };
  const springStarts: number[][] = [];
  for (let i = 0; i < 24; i++) for (const zeta of [0.15, 0.25, 0.35, 0.5, 0.7, 0.9, 1.1]) springStarts.push([guessStart, Math.log(2) + (i / 23) * Math.log(60), zeta]);
  springStarts.sort((a, b) => springLoss(a) - springLoss(b));
  let spr = { x: springStarts[0]!, value: Infinity };
  for (const s of springStarts.slice(0, 3)) {
    const r = polish(springLoss, s, [1, 0.15, 0.08]);
    if (r.value < spr.value) spr = r;
  }
  const spring = springCurve(Math.exp(spr.x[1]!), Math.min(3, Math.max(0.03, spr.x[2]!)));
  const springRmse = rmse(spr.value);

  // What the samples do around the target.
  const noise = sigma / Math.abs(delta);
  const band = Math.max(0.02, 3 * noise);
  const progress = v.map((x) => (x - v0) / delta);
  const overshoot = Math.max(0, Math.max(...progress) - 1);
  let oscillations = 0;
  let side = 0;
  let reached = false;
  for (const p of progress) {
    if (!reached) {
      if (p >= 1 - band) reached = true;
      side = p > 1 + band ? 1 : 0;
      continue;
    }
    const now = p > 1 + band ? 1 : p < 1 - band ? -1 : 0;
    if (now !== 0 && side !== 0 && now !== side) oscillations++;
    if (now !== 0) side = now;
  }

  const alternatives = [
    { kind: "bezier" as const, rmse: round(bezRmse) },
    { kind: "spring" as const, rmse: round(springRmse) },
    { kind: "linear" as const, rmse: round(linRmse) },
    ...(steps.count ? [{ kind: "steps" as const, rmse: round(stepsRmse) }] : []),
  ];
  const smooth = Math.min(bezRmse, springRmse, linRmse);
  let curve: Curve;
  let start: number;
  let length: number;
  let error: number;
  let reason: string;
  if (steps.count && stepsRmse * 2 < smooth && stepsRmse < 0.05) {
    curve = { kind: "steps", steps: steps.count };
    start = steps.x[0]!;
    length = Math.max(0.3, steps.x[1]!);
    error = stepsRmse;
    reason = `the value holds and jumps in ${steps.count} steps; steps fit at least twice as well as a smooth curve`;
  } else if ((oscillations >= 1 && springRmse < bezRmse * 1.5) || (overshoot > band && springRmse < bezRmse)) {
    curve = spring;
    start = spr.x[0]!;
    length = spring.duration * fps;
    error = springRmse;
    reason = oscillations >= 1 ? `the value swings back across its target ${oscillations} time(s): a spring` : `the value overshoots its target by ${Math.round(overshoot * 100)} % and a spring fits better than a bezier`;
  } else if (linRmse <= bezRmse * 1.25 + 0.002) {
    curve = { kind: "linear" };
    start = lin.x[0]!;
    length = Math.max(0.3, lin.x[1]!);
    error = linRmse;
    reason = "a straight line fits as well as any bezier";
  } else {
    curve = { kind: "bezier", bezier };
    start = bezStart;
    length = bezLength;
    error = bezRmse;
    reason = overshoot > band ? `the value overshoots once by ${Math.round(overshoot * 100)} %; a bezier with y outside 0–1 fits best` : "a cubic-bezier fits best";
  }
  let maxError = 0;
  for (let i = 0; i < m; i++) maxError = Math.max(maxError, Math.abs(curveAt(curve, (fs[i]! - start) / length) - ps[i]!));
  // The move must be seen resting on both sides, else the window cuts it and the fit only describes a part.
  const before = f.filter((x) => x < start - 0.5).length;
  const after = f.filter((x) => x > start + length + 0.5).length;
  const cutStart = before < 2 || onset < 2;
  const cutEnd = after < 2 || offset > n - 3;
  const cut = cutStart && cutEnd ? "both" : cutStart ? "start" : cutEnd ? "end" : undefined;
  const identifiable = curve.kind === "spring" ? true : length > MIN_IDENTIFIABLE_FRAMES;
  if (cut) reason = `the window cuts the move at its ${cut === "both" ? "start and end" : cut}, so the curve describes only the part seen`;
  else if (!identifiable) reason = `the move lasts only ${round(length, 1)} frames: too short to tell one curve from another`;
  const quality = cut || !identifiable || error > EXPORT_MAX_ERROR ? "unreliable" : error <= Math.max(0.01, 3 * (sigma / Math.abs(delta))) ? "exact" : "approximate";
  return {
    from: round(v0, 4),
    to: round(v1, 4),
    start: round(start / fps, 4),
    end: round((start + length) / fps, 4),
    frames: round(length, 2),
    seconds: round(length / fps, 4),
    curve,
    rmse: round(error),
    maxError: round(maxError),
    alternatives,
    overshoot: round(overshoot, 4),
    oscillations,
    noise: round(noise),
    reason,
    ...(cut && { cut }),
    identifiable,
    quality,
  };
}

function round(x: number, digits = 5): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}
