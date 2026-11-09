/** Grey frames of one window of a video, all the same size, in time order. */
export interface GrayFrames {
  width: number;
  height: number;
  frames: { t: number; data: Uint8Array }[];
}

/** A box in pixels: top-left corner and size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackPoint {
  t: number;
  /** Centre of the element, in pixels of the frames. */
  x: number;
  y: number;
  /** Size relative to the element at the reference frame. */
  scale: number;
  /** Normalised cross-correlation with the template at the match, −1..1. */
  score: number;
  /**
   * How visible the element is next to the reference frame (1 = as seen there, 0 = gone), from its own brightness
   * against its surroundings. NaN when it cannot be measured (the element touches the edge of the frame).
   */
  visibility: number;
  /** How far the element's own brightness moved from the reference, as a share of its contrast there. */
  shift: number;
  /** The element's own mean brightness (NaN when it touches the frame's edge). */
  inner: number;
  /**
   * How opacity was measured: against a uniform surrounding, against the background seen once the element had faded
   * away completely (`estimated`), or against a busy surrounding (`ring`, the least exact).
   */
  basis?: "uniform" | "estimated" | "ring";
  /** The match was too weak to trust (element hidden, faded out or lost): the position is a prediction. */
  lost: boolean;
}

type Pixels = Uint8Array | Float32Array;

/**
 * The frame smoothed by a 5-tap binomial filter (σ ≈ 1 px). Antialiased edges then shift like smooth profiles, which
 * is what subpixel matching assumes; on sharp one-pixel edges an interpolated template is biased by up to 0.3 px.
 */
export function smooth(data: Pixels, w: number, h: number): Float32Array {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -2; i <= 2; i++) sum += k[i + 2]! * data[row + Math.min(w - 1, Math.max(0, x + i))]!;
      tmp[row + x] = sum / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -2; i <= 2; i++) sum += k[i + 2]! * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]!;
      out[y * w + x] = sum / 16;
    }
  }
  return out;
}

/** Bilinear sample with the edges extended. */
function sample(data: Pixels, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1.000001, Math.max(0, x));
  const fy = Math.min(h - 1.000001, Math.max(0, y));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  const top = data[i]! + (data[i + 1]! - data[i]!) * ax;
  const bottom = data[i + w]! + (data[i + w + 1]! - data[i + w]!) * ax;
  return top + (bottom - top) * ay;
}

/** Bilinear sample and its exact derivatives along x and y. */
function sampleGrad(data: Pixels, w: number, h: number, x: number, y: number, out: Float64Array): void {
  const fx = Math.min(w - 1.000001, Math.max(0, x));
  const fy = Math.min(h - 1.000001, Math.max(0, y));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  const a = data[i]!;
  const b = data[i + 1]!;
  const c = data[i + w]!;
  const d = data[i + w + 1]!;
  const top = a + (b - a) * ax;
  const bottom = c + (d - c) * ax;
  out[0] = top + (bottom - top) * ay;
  out[1] = (1 - ay) * (b - a) + ay * (d - c);
  out[2] = bottom - top;
}

interface Template {
  dx: Float64Array;
  dy: Float64Array;
  /** Raw sampled values (kept for blending), and the zero-mean values with their norm. */
  raw: Float64Array;
  zero: Float64Array;
  norm: number;
}

function finishTemplate(dx: Float64Array, dy: Float64Array, raw: Float64Array): Template {
  const n = raw.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += raw[i]!;
  mean /= n;
  const zero = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    zero[i] = raw[i]! - mean;
    norm += zero[i]! ** 2;
  }
  return { dx, dy, raw, zero, norm: Math.sqrt(norm) };
}

/** Sample points over the box plus a thin margin (its edges against the background locate it), at most 32×32. */
function makeTemplate(frame: Pixels, w: number, h: number, cx: number, cy: number, bw: number, bh: number, stride = 1): Template {
  const mw = bw + 2 * Math.max(3, 0.08 * bw);
  const mh = bh + 2 * Math.max(3, 0.08 * bh);
  const nx = Math.max(4, Math.min(32, Math.round(mw)));
  const ny = Math.max(4, Math.min(32, Math.round(mh)));
  const dx: number[] = [];
  const dy: number[] = [];
  for (let j = 0; j < ny; j += stride) for (let i = 0; i < nx; i += stride) {
    dx.push(-mw / 2 + ((i + 0.5) * mw) / nx);
    dy.push(-mh / 2 + ((j + 0.5) * mh) / ny);
  }
  const fdx = Float64Array.from(dx);
  const fdy = Float64Array.from(dy);
  const raw = new Float64Array(fdx.length);
  for (let k = 0; k < raw.length; k++) raw[k] = sample(frame, w, h, cx + fdx[k]!, cy + fdy[k]!);
  return finishTemplate(fdx, fdy, raw);
}

function resample(t: Template, frame: Pixels, w: number, h: number, cx: number, cy: number, s: number): Float64Array {
  const raw = new Float64Array(t.raw.length);
  for (let k = 0; k < raw.length; k++) raw[k] = sample(frame, w, h, cx + s * t.dx[k]!, cy + s * t.dy[k]!);
  return raw;
}

/** Normalised cross-correlation of the template with the frame at centre (cx, cy) and scale s. */
function ncc(t: Template, frame: Pixels, w: number, h: number, cx: number, cy: number, s: number): number {
  const n = t.zero.length;
  let sum = 0;
  let sum2 = 0;
  let cross = 0;
  for (let k = 0; k < n; k++) {
    const v = sample(frame, w, h, cx + s * t.dx[k]!, cy + s * t.dy[k]!);
    sum += v;
    sum2 += v * v;
    cross += v * t.zero[k]!;
  }
  const variance = sum2 - (sum * sum) / n;
  if (variance <= 1e-9 || t.norm <= 1e-9) return 0;
  return cross / (Math.sqrt(variance) * t.norm);
}

function gridSearch(t: Template, frame: Pixels, w: number, h: number, px: number, py: number, s: number, radius: number, step: number) {
  let best = { x: px, y: py, score: -2 };
  // Offsets are whole multiples of the step, so the predicted position itself is always one of the candidates.
  const reach = Math.floor(radius / step) * step;
  for (let oy = -reach; oy <= reach; oy += step) {
    for (let ox = -reach; ox <= reach; ox += step) {
      const x = px + ox;
      const y = py + oy;
      if (x < -w * 0.25 || x > w * 1.25 || y < -h * 0.25 || y > h * 1.25) continue;
      const score = ncc(t, frame, w, h, x, y, s);
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

/** Solves the small linear system A·x = b (Gaussian elimination with partial pivoting); undefined when singular. */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    if (Math.abs(m[pivot]![c]!) < 1e-12) return undefined;
    [m[c], m[pivot]] = [m[pivot]!, m[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r]![n]!;
    for (let k = r + 1; k < n; k++) sum -= m[r]![k]! * x[k]!;
    x[r] = sum / m[r]![r]!;
  }
  return x;
}

/**
 * Subpixel position and scale by Gauss–Newton (Lucas–Kanade) on the template, with a brightness gain and offset so
 * fades do not pull the fit, and robust weights so background pixels that disagree count less. Parabolas through
 * correlation scores lock onto whole pixels on sharp edges; this does not.
 */
function lkRefine(t: Template, frame: Pixels, w: number, h: number, x: number, y: number, s: number, scale: boolean) {
  const n = t.raw.length;
  const T = t.raw;
  const I = new Float64Array(n);
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  const res = new Float64Array(n);
  const g = new Float64Array(3);
  const dim = scale ? 5 : 4;
  let a = 1;
  let b = 0;
  for (let iter = 0; iter < 12; iter++) {
    for (let k = 0; k < n; k++) {
      sampleGrad(frame, w, h, x + s * t.dx[k]!, y + s * t.dy[k]!, g);
      I[k] = g[0]!;
      gx[k] = g[1]!;
      gy[k] = g[2]!;
    }
    if (iter === 0) {
      // Gain and offset from a straight-line fit of the frame's values on the template's.
      let st = 0;
      let si = 0;
      for (let k = 0; k < n; k++) {
        st += T[k]!;
        si += I[k]!;
      }
      const mt = st / n;
      const mi = si / n;
      let cov = 0;
      let vt = 0;
      for (let k = 0; k < n; k++) {
        cov += (T[k]! - mt) * (I[k]! - mi);
        vt += (T[k]! - mt) ** 2;
      }
      a = vt > 1e-9 ? cov / vt : 1;
      b = mi - a * mt;
    }
    for (let k = 0; k < n; k++) res[k] = I[k]! - (a * T[k]! + b);
    const sorted = Array.from(res, Math.abs).sort((p, q) => p - q);
    const c = Math.max(2, 2.5 * (sorted[Math.floor(n / 2)] ?? 0));
    const A = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
    const B = new Array<number>(dim).fill(0);
    const J = new Array<number>(dim);
    for (let k = 0; k < n; k++) {
      const wk = 1 / (1 + (res[k]! / c) ** 2);
      // Residual r = I(p) − (a·T + b); derivatives with respect to x, y, (s), a, b.
      J[0] = gx[k]!;
      J[1] = gy[k]!;
      let j = 2;
      if (scale) J[j++] = gx[k]! * t.dx[k]! + gy[k]! * t.dy[k]!;
      J[j++] = -T[k]!;
      J[j] = -1;
      for (let p = 0; p < dim; p++) {
        B[p]! -= wk * J[p]! * res[k]!;
        for (let q = p; q < dim; q++) A[p]![q]! += wk * J[p]! * J[q]!;
      }
    }
    for (let p = 0; p < dim; p++) for (let q = 0; q < p; q++) A[p]![q] = A[q]![p]!;
    const step = solve(A, B);
    if (!step) break;
    const dx = Math.max(-1, Math.min(1, step[0]!));
    const dy = Math.max(-1, Math.min(1, step[1]!));
    const ds = scale ? Math.max(-0.05, Math.min(0.05, step[2]!)) : 0;
    x += dx;
    y += dy;
    s = Math.min(8, Math.max(0.125, s + ds * s));
    a += step[dim - 2]!;
    b += step[dim - 1]!;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(ds) < 1e-4) break;
  }
  return { x, y, s, score: ncc(t, frame, w, h, x, y, s) };
}


/**
 * Scale by correlation over a ladder of sizes (log steps of 3 %, then 0.75 %), with a parabola through the best three.
 * Gauss–Newton on scale alone drifts: a uniform element only shows its size at its edges, which a few pixels of
 * background can outweigh. The position is refined again at the size found.
 */
function scaleRefine(t: Template, frame: Pixels, w: number, h: number, x: number, y: number, s: number) {
  let best = s;
  for (const step of [0.03, 0.0075]) {
    const ladder = [-3, -2, -1, 0, 1, 2, 3].map((k) => best * Math.exp(k * step));
    const scores = ladder.map((v) => ncc(t, frame, w, h, x, y, v));
    let i = scores.indexOf(Math.max(...scores));
    i = Math.min(ladder.length - 2, Math.max(1, i));
    const shift = parabola(scores[i - 1]!, scores[i]!, scores[i + 1]!, step);
    best = Math.min(8, Math.max(0.125, ladder[i]! * Math.exp(shift)));
  }
  const at = lkRefine(t, frame, w, h, x, y, best, false);
  return { ...at, s: best };
}

/**
 * Searches outwards from the predicted position in rings of doubling radius (on a shrunk copy of the frame), each
 * refined to the pixel, and stops at the first clear match. The element moves continuously, so the nearest clear
 * match is the element; a look-alike further away (a twin, a repeated pattern) is reached only when nothing nearer
 * matches. Returns the position in full-size pixels and how far the full-size search must still look around it.
 */
function expandingSearch(
  templates: Template[],
  small: { data: Float32Array; w: number; h: number },
  f: number,
  px: number,
  py: number,
  s: number,
  start: number,
  elementSize: number,
  limit: number,
): { x: number; y: number; score: number; reach: number } {
  let best = { x: px, y: py, score: -2, reach: 2 };
  const cx = px / f;
  const cy = py / f;
  for (let r = start * 2; ; r *= 2) {
    const step = Math.max(1, Math.round(Math.min(r / 12, elementSize / 6) / f));
    const reach = Math.floor(r / f / step) * step;
    for (const t of templates) {
      // Every promising grid point, nearest first; the first one that refines to a clear match wins.
      const found: { x: number; y: number; score: number; d: number }[] = [];
      for (let oy = -reach; oy <= reach; oy += step) {
        for (let ox = -reach; ox <= reach; ox += step) {
          const score = ncc(t, small.data, small.w, small.h, cx + ox, cy + oy, s / f);
          if (score > best.score) best = { x: (cx + ox) * f, y: (cy + oy) * f, score, reach: step * f + 1 };
          if (score >= 0.6) found.push({ x: cx + ox, y: cy + oy, score, d: Math.hypot(ox, oy) });
        }
      }
      found.sort((a, b) => a.d - b.d);
      for (const c of found.slice(0, 12)) {
        const fine = step > 1 ? gridSearch(t, small.data, small.w, small.h, c.x, c.y, s / f, step, 1) : c;
        if (fine.score >= 0.85) return { x: fine.x * f, y: fine.y * f, score: fine.score, reach: f + 1 };
        if (fine.score > best.score) best = { x: fine.x * f, y: fine.y * f, score: fine.score, reach: f + 1 };
      }
    }
    if (r >= Math.min(limit, Math.max(small.w, small.h) * f)) return best;
  }
}

/** Vertex of the parabola through (−h, a), (0, b), (h, c); stays within ±h. */
function parabola(a: number, b: number, c: number, h: number): number {
  const denom = a - 2 * b + c;
  if (denom >= -1e-12) return a > c ? -h / 2 : c > a ? h / 2 : 0;
  return Math.max(-h, Math.min(h, (h * (a - c)) / (2 * denom)));
}

/** The element's own brightness (inner 60 % of the box) and its surroundings (a ring at 1.15–1.45 box sizes). */
interface Appearance {
  inner: number;
  ring: number;
  /** Standard deviation of the ring: high on a busy background. */
  ringSpread: number;
  /** The box and its ring lie inside the frame, so both numbers are real pixels rather than repeated edges. */
  inside: boolean;
}

function appearance(frame: Pixels, w: number, h: number, cx: number, cy: number, bw: number, bh: number): Appearance {
  let inner = 0;
  let ring = 0;
  let ring2 = 0;
  let ringN = 0;
  const n = 12;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n - 0.5;
    const v = (j + 0.5) / n - 0.5;
    inner += sample(frame, w, h, cx + u * bw * 0.6, cy + v * bh * 0.6);
    const m = Math.max(Math.abs(u), Math.abs(v));
    if (m > 0.25) {
      const k = 1.15 + (m - 0.25) * 1.2;
      ring += sample(frame, w, h, cx + (u / m) * (k / 2) * bw, cy + (v / m) * (k / 2) * bh);
      ring2 += sample(frame, w, h, cx + (u / m) * (k / 2) * bw, cy + (v / m) * (k / 2) * bh) ** 2;
      ringN++;
    }
  }
  const hx = 0.73 * bw;
  const hy = 0.73 * bh;
  const ringMean = ring / Math.max(1, ringN);
  return { inner: inner / (n * n), ring: ringMean, ringSpread: Math.sqrt(Math.max(0, ring2 / Math.max(1, ringN) - ringMean ** 2)), inside: cx - hx >= 0 && cy - hy >= 0 && cx + hx <= w - 1 && cy + hy <= h - 1 };
}

/** Contrast against the surroundings next to the reference's (1 = as there), or NaN when not measurable. */
function visibilityOf(a: Appearance, ref: Appearance): number {
  if (!a.inside || !ref.inside) return NaN;
  const refContrast = ref.inner - ref.ring;
  if (Math.abs(refContrast) < 4) return NaN;
  return Math.max(0, Math.min(1.5, (a.inner - a.ring) / refContrast));
}

/** How far the element's own brightness moved from the reference, as a share of the reference contrast. */
function shiftOf(a: Appearance, ref: Appearance): number {
  const refContrast = Math.abs(ref.inner - ref.ring);
  return refContrast < 4 ? 0 : Math.abs(a.inner - ref.inner) / refContrast;
}

/** Below this share of its contrast, a change of the element's own brightness is noise or its surroundings changing. */
const FADE_SHIFT = 0.08;

/** A frame shrunk by an integer factor (box average), for searching the whole picture quickly. */
function shrink(frame: Pixels, w: number, h: number, f: number): { data: Float32Array; w: number; h: number } {
  const sw = Math.max(1, Math.floor(w / f));
  const sh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let sum = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += frame[(y * f + j) * w + x * f + i]!;
    out[y * sw + x] = sum / (f * f);
  }
  return { data: out, w: sw, h: sh };
}

export interface TrackOptions {
  /** Measure the element's size as well as its position (default true). */
  scale?: boolean;
  /** Correlation under which a match is not trusted (default 0.5). */
  minScore?: number;
}

/** Correlation a match far from the prediction needs before the tracker jumps there. */
const REACQUIRE_SCORE = 0.8;
/** Consecutive lost frames after which the tracker stops searching the whole picture. */
const MAX_LOST_SEARCH = 12;

/**
 * Follows one element through the frames by template matching: normalised cross-correlation over a small search
 * window around the predicted position, then Lucas–Kanade subpixel (and scale) refinement. When the element is not
 * found near the prediction, the whole picture is searched on a shrunk copy, but a match there is only taken when it
 * correlates well, still looks like the element and lies within reach of its motion; a faint element (faded out)
 * keeps its place and is marked lost instead of jumping to look-alike background. The template is refreshed only from
 * clear, fully visible matches, and the original template wins whenever it still matches, which stops drift.
 * Tracking runs forwards and backwards from `index`, the frame where `box` is drawn.
 */
export async function trackElement(video: GrayFrames, box: Box, index: number, options: TrackOptions = {}): Promise<TrackPoint[]> {
  const minScore = options.minScore ?? 0.5;
  const fixed = await trackPass(video, box, index, minScore, false);
  if (options.scale === false) return settleVisibility(fixed, fixed.ringSpread);
  // Size is measured in a second pass and kept only when it explains the frames better: on a busy background the
  // pixels around the element otherwise pull the size a little on every frame until the match is lost.
  const scaled = await trackPass(video, box, index, minScore, true);
  const a = trackQuality(fixed);
  const b = trackQuality(scaled);
  return settleVisibility(b.lost <= a.lost && b.score > a.score + 0.001 ? scaled : fixed, fixed.ringSpread);
}

/**
 * Opacity only changes when the element's own brightness does: moving over a gradient changes the surroundings and
 * the contrast, not the element. When the element never changes its own brightness, it is fully visible throughout.
 */
function settleVisibility(points: TrackPoint[], ringSpread: number): TrackPoint[] {
  const fades = points.some((p) => !p.lost && p.shift >= FADE_SHIFT) || points.some((p) => p.lost && p.shift >= FADE_SHIFT && p.visibility < 0.3);
  if (!fades) return points.map((p) => (Number.isFinite(p.visibility) ? { ...p, visibility: 1 } : p));
  // When the element faded away completely in one place, the frames where it is gone show the very background it
  // fades over: opacity measured against that is exact even on a busy background, where the ring around it is not.
  const gone = points.filter((p) => p.lost && p.shift >= FADE_SHIFT && p.visibility < 0.15 && Number.isFinite(p.inner));
  const ref = points.find((p) => p.shift === 0 && !p.lost && Number.isFinite(p.inner));
  if (gone.length >= 3 && ref) {
    const bg = [...gone.map((p) => p.inner)].sort((a, b) => a - b)[Math.floor(gone.length / 2)]!;
    const gx = gone.reduce((sum, p) => sum + p.x, 0) / gone.length;
    const gy = gone.reduce((sum, p) => sum + p.y, 0) / gone.length;
    const span = ref.inner - bg;
    if (Math.abs(span) > 8) {
      return points.map((p) => {
        if (!Number.isFinite(p.inner) || Math.hypot(p.x - gx, p.y - gy) > 2) return { ...p, basis: "ring" as const };
        return { ...p, visibility: Math.max(0, Math.min(1.5, (p.inner - bg) / span)), basis: "estimated" as const };
      });
    }
  }
  const basis = ringSpread < 6 ? ("uniform" as const) : ("ring" as const);
  return points.map((p) => ({ ...p, basis }));
}

function trackQuality(points: TrackPoint[]): { lost: number; score: number; value: number } {
  const good = points.filter((p) => !p.lost);
  const score = good.reduce((sum, p) => sum + p.score, 0) / Math.max(1, good.length);
  return { lost: points.length - good.length, score, value: (good.length / Math.max(1, points.length)) * score };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function trackPass(video: GrayFrames, box: Box, index: number, minScore: number, measureScale: boolean): Promise<TrackPoint[] & { ringSpread: number }> {
  const { width: w, height: h, frames } = video;
  const raw = frames[index]!.data;
  const ref = smooth(raw, w, h);
  const cx0 = box.x + box.w / 2;
  const cy0 = box.y + box.h / 2;
  const size = Math.max(4, Math.min(box.w, box.h));
  const original = makeTemplate(ref, w, h, cx0, cy0, box.w, box.h);
  const originalCoarse = makeTemplate(ref, w, h, cx0, cy0, box.w, box.h, 2);
  const refLook = appearance(raw, w, h, cx0, cy0, box.w, box.h);
  const refContrast = refLook.inner - refLook.ring;
  // The whole-picture search runs on a copy no wider than about 320 pixels.
  const shrinkBy = Math.max(1, Math.floor(Math.max(w, h) / 320));
  const out: TrackPoint[] = new Array(frames.length);
  out[index] = { t: frames[index]!.t, x: cx0, y: cy0, scale: 1, score: 1, visibility: refLook.inside ? 1 : NaN, shift: 0, inner: refLook.inside ? refLook.inner : NaN, lost: false };
  let steps = 0;

  for (const dir of [1, -1]) {
    let x = cx0;
    let y = cy0;
    let s = 1;
    let vx = 0;
    let vy = 0;
    let growth = 1;
    let current = original;
    let coarse = originalCoarse;
    let lostRun = 0;
    let faded = false;
    for (let i = index + dir; i >= 0 && i < frames.length; i += dir) {
      if (++steps % 8 === 0) await yieldToLoop();
      const frame = smooth(frames[i]!.data, w, h);
      const px = x + vx;
      const py = y + vy;
      // Scale is predicted like position: a zoom keeps its pace from one frame to the next.
      const ps = measureScale ? Math.min(8, Math.max(0.125, s * growth)) : s;
      const speed = Math.hypot(vx, vy);
      const radius = Math.min(64, Math.ceil(3 + 0.75 * speed));
      let best = gridSearch(coarse, frame, w, h, px, py, ps, radius, radius > 10 ? 2 : 1);
      let reach = 2;
      // Search the whole picture only while the element is recently lost, and every third frame once it has been
      // lost for a while: a hidden element otherwise costs a full search on every frame.
      const searchWide = best.score < 0.85 && !faded && lostRun < MAX_LOST_SEARCH && (lostRun < 3 || lostRun % 3 === 0);
      if (searchWide) {
        const small = shrink(frame, w, h, shrinkBy);
        const limit = Math.max(5 * size * ps, 3 * speed);
        const far = expandingSearch([coarse, originalCoarse], small, shrinkBy, px, py, ps, Math.max(radius, size * ps), size * ps, limit);
        // Continuity: a jump beyond the element's reach is look-alike background, not the element.
        if (far.score > best.score + 0.02 && Math.hypot(far.x - px, far.y - py) <= limit) {
          best = { x: far.x, y: far.y, score: far.score };
          reach = far.reach;
        }
      }
      const near = gridSearch(current, frame, w, h, best.x, best.y, ps, reach, 1);
      // Prefer the original template when it still matches: no drift.
      const anchored = ncc(original, frame, w, h, near.x, near.y, ps);
      const template = anchored >= Math.max(minScore, near.score - 0.1) ? original : current;
      let fine = lkRefine(template, frame, w, h, near.x, near.y, ps, false);
      if (measureScale) {
        fine = scaleRefine(template, frame, w, h, fine.x, fine.y, ps);
        fine = scaleRefine(template, frame, w, h, fine.x, fine.y, fine.s);
      }
      const look = appearance(frames[i]!.data, w, h, fine.x, fine.y, box.w * fine.s, box.h * fine.s);
      const visibility = visibilityOf(look, refLook);
      const shift = shiftOf(look, refLook);
      const far = Math.hypot(fine.x - px, fine.y - py) > Math.max(3, 1.5 * speed + 2);
      // A match is trusted when it correlates, still looks like the element (a faint, faded element gives no
      // position), and, when it is far from the prediction, correlates clearly.
      // A faded element stays where it faded: no whole-picture search for it while it is faint.
      const faint = Number.isFinite(visibility) && shift >= FADE_SHIFT && visibility < 0.3;
      const lost =
        fine.score < minScore ||
        faint ||
        (far && fine.score < REACQUIRE_SCORE) ||
        (far && Math.abs(look.inner - refLook.inner) > 0.35 * Math.abs(refContrast));
      if (lost) {
        // Hidden or faded out: keep the place (slowing down), keep the last good look.
        x = px;
        y = py;
        vx *= 0.5;
        vy *= 0.5;
        growth = 1;
        lostRun++;
        faded = faded || faint;
        const held = appearance(frames[i]!.data, w, h, x, y, box.w * s, box.h * s);
        out[i] = { t: frames[i]!.t, x, y, scale: s, score: fine.score, visibility: visibilityOf(held, refLook), shift: shiftOf(held, refLook), inner: held.inside ? held.inner : NaN, lost: true };
        continue;
      }
      lostRun = 0;
      faded = false;
      vx = fine.x - x;
      vy = fine.y - y;
      x = fine.x;
      y = fine.y;
      growth = fine.s / s;
      s = fine.s;
      // A template refreshed at a slightly wrong size would carry that error on; the scale pass keeps the original.
      if (!measureScale && fine.score >= 0.9 && shift < FADE_SHIFT) {
        const patch = resample(current, frame, w, h, x, y, s);
        current = finishTemplate(current.dx, current.dy, current.raw.map((v, k) => 0.7 * v + 0.3 * patch[k]!));
        const patchCoarse = resample(coarse, frame, w, h, x, y, s);
        coarse = finishTemplate(coarse.dx, coarse.dy, coarse.raw.map((v, k) => 0.7 * v + 0.3 * patchCoarse[k]!));
      }
      out[i] = { t: frames[i]!.t, x, y, scale: s, score: fine.score, visibility, shift, inner: look.inside ? look.inner : NaN, lost: false };
    }
  }
  return Object.assign(out, { ringSpread: refLook.ringSpread });
}

/** Mean step across the box outline in one frame: high where an element's edges sit exactly on the box. */
function edgeEnergy(frame: Pixels, w: number, h: number, b: Box): number {
  let sum = 0;
  let n = 0;
  const across = (x0: number, y0: number, x1: number, y1: number) => {
    sum += Math.abs(sample(frame, w, h, x0, y0) - sample(frame, w, h, x1, y1));
    n++;
  };
  const k = 16;
  for (let i = 0; i < k; i++) {
    const x = b.x + ((i + 0.5) * b.w) / k;
    const y = b.y + ((i + 0.5) * b.h) / k;
    across(x, b.y - 2, x, b.y + 2);
    across(x, b.y + b.h - 2, x, b.y + b.h + 2);
    across(b.x - 2, y, b.x + 2, y);
    across(b.x + b.w - 2, y, b.x + b.w + 2, y);
  }
  return sum / n;
}

/** Standard deviation of the pixels in and just around a box: an empty, flat spot has nothing to match. */
function boxSpread(frame: Pixels, w: number, h: number, b: Box): number {
  let sum = 0;
  let sum2 = 0;
  const n = 10;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = sample(frame, w, h, b.x - 0.15 * b.w + ((i + 0.5) * 1.3 * b.w) / n, b.y - 0.15 * b.h + ((j + 0.5) * 1.3 * b.h) / n);
    sum += v;
    sum2 += v * v;
  }
  return Math.sqrt(Math.max(0, sum2 / (n * n) - (sum / (n * n)) ** 2));
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shared = ix * iy;
  return shared / (a.w * a.h + b.w * b.h - shared || 1);
}

/**
 * The biggest coherent moving element. Regions that differ from the per-pixel median of the window are candidates.
 * The median is the background only while nothing rests in one place for most of the window, so a region can also be
 * the empty spot where the element rests later: each candidate box is paired with the frame where an element's edges
 * sit on its outline, and the candidates are then tracked: the one followed best wins.
 */
export async function autoBox(video: GrayFrames): Promise<{ box: Box; index: number } | undefined> {
  return (await findElement(video)).found;
}

/** Grey levels a pixel can differ from the background by noise and compression alone. */
const NOISE_FLOOR = 18;

/**
 * A region this large is the whole picture changing (a camera move, a character filling the frame, a fade), not an
 * element on a still background: most of the frame's cells, or a box around nearly all of it.
 */
function wholePicture(region: { box: Box; area: number }, w: number, h: number, cells: number): boolean {
  return region.area >= 0.6 * cells || (region.box.w >= 0.9 * w && region.box.h >= 0.9 * h);
}

/**
 * `autoBox`, saying why nothing was picked: `wholePicture` when the whole picture moves in most of the window, so
 * there is no element against a still background to pick (pass a box). The whole frame is never returned as the element.
 */
export async function findElement(video: GrayFrames): Promise<{ found?: { box: Box; index: number }; wholePicture: boolean }> {
  const { width: w, height: h, frames } = video;
  if (frames.length < 2) return { wholePicture: false };
  const stride = Math.max(1, Math.round(Math.max(w, h) / 320));
  const gw = Math.floor(w / stride);
  const gh = Math.floor(h / stride);
  const count = Math.min(25, frames.length);
  const picks = Array.from({ length: count }, (_, k) => Math.round((k * (frames.length - 1)) / Math.max(1, count - 1)));
  const background = new Float32Array(gw * gh);
  const column = new Float32Array(count);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const at = gy * stride * w + gx * stride;
    for (let k = 0; k < count; k++) column[k] = frames[picks[k]!]!.data[at]!;
    column.sort();
    background[gy * gw + gx] = count % 2 ? column[(count - 1) / 2]! : (column[count / 2 - 1]! + column[count / 2]!) / 2;
  }
  // Threshold from how much ordinary pixels differ from the background (noise, compression), read on the frame most
  // like the background of a few: one frame unlike all the others (another shot, a flash) would raise it so far that
  // nothing seemed to move.
  let noise = Infinity;
  for (const pick of [...new Set([picks[0]!, picks[Math.floor(picks.length / 2)]!, picks.at(-1)!])]) {
    const diffs: number[] = [];
    const probe = frames[pick]!.data;
    for (let k = 0; k < gw * gh; k += 7) diffs.push(Math.abs(probe[Math.floor(k / gw) * stride * w + (k % gw) * stride]! - background[k]!));
    diffs.sort((a, b) => a - b);
    noise = Math.min(noise, diffs[Math.floor(diffs.length / 2)] ?? 0);
  }
  const threshold = Math.max(NOISE_FLOOR, 5 * 1.4826 * (Number.isFinite(noise) ? noise : 0));

  const regions: { box: Box; area: number }[] = [];
  const mask = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  // Sampled frames where something differs from the background, and where most of the picture does.
  let moving = 0;
  let wide = 0;
  for (const index of picks) {
    let best: { box: Box; area: number } | undefined;
    const data = frames[index]!.data;
    // Cells that differ by more than ordinary noise ever does (the threshold's floor): when the whole picture moves,
    // the noise estimate itself is high, so the region threshold alone would see only a few patches.
    let ones = 0;
    for (let k = 0; k < gw * gh; k++) {
      const diff = Math.abs(data[Math.floor(k / gw) * stride * w + (k % gw) * stride]! - background[k]!);
      mask[k] = diff > threshold ? 1 : 0;
      if (diff > NOISE_FLOOR) ones++;
    }
    for (let start = 0; start < gw * gh; start++) {
      if (mask[start] !== 1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      mask[start] = 2;
      let x0 = gw;
      let y0 = gh;
      let x1 = 0;
      let y1 = 0;
      while (head < tail) {
        const k = queue[head++]!;
        const kx = k % gw;
        const ky = (k - kx) / gw;
        if (kx < x0) x0 = kx;
        if (kx > x1) x1 = kx;
        if (ky < y0) y0 = ky;
        if (ky > y1) y1 = ky;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = kx + ox;
          const ny = ky + oy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const nk = ny * gw + nx;
          if (mask[nk] === 1) {
            mask[nk] = 2;
            queue[tail++] = nk;
          }
        }
      }
      if (tail >= 12 && (!best || tail > best.area)) best = { area: tail, box: { x: x0 * stride, y: y0 * stride, w: (x1 - x0 + 1) * stride, h: (y1 - y0 + 1) * stride } };
    }
    if (ones >= 12) moving++;
    // Most of the picture differs here (a camera move, another shot): no element of its own on this frame.
    if (ones >= 0.4 * gw * gh || (best && wholePicture(best, w, h, gw * gh))) {
      wide++;
      continue;
    }
    if (best) regions.push(best);
  }
  // The whole picture moving on most of the sampled frames: no element stands out against a still background.
  if (moving && wide * 2 >= moving) return { wholePicture: true };
  if (!regions.length) return { wholePicture: wide > 0 };
  const parts = regions;

  // Pair each distinct box with the frame where it holds the element: the strongest edges on its outline.
  const candidates: { box: Box; index: number; energy: number }[] = [];
  const most = Math.max(...parts.map((r) => r.area));
  for (const r of parts.filter((r) => r.area >= 0.3 * most)) {
    let index = picks[0]!;
    let energy = -1;
    for (const k of picks) {
      const e = edgeEnergy(frames[k]!.data, w, h, r.box);
      if (e > energy + 1e-9) {
        energy = e;
        index = k;
      }
    }
    if (boxSpread(frames[index]!.data, w, h, r.box) < 4) continue;
    if (candidates.some((c) => c.index === index && iou(c.box, r.box) > 0.6)) continue;
    candidates.push({ box: r.box, index, energy });
  }
  if (!candidates.length) return { wholePicture: wide > 0 };
  candidates.sort((a, b) => b.energy - a.energy);
  const tried = candidates
    .slice(0, 4)
    .map((c) => ({ ...c, box: tighten(frames, picks, w, h, c.box, c.index, threshold) }))
    // Half the frame or more is a character filling it or the picture itself, never an element to follow by its place.
    .filter((c) => !(c.box.w * c.box.h >= 0.5 * w * h || (c.box.w >= 0.9 * w && c.box.h >= 0.9 * h)));
  if (!tried.length) return { wholePicture: true };
  let winner = tried[0]!;
  if (tried.length > 1) {
    let value = -1;
    for (const c of tried) {
      const q = trackQuality(await trackPass(video, c.box, c.index, 0.5, false));
      if (q.value > value + 1e-6) {
        value = q.value;
        winner = c;
      }
      // Followed on nearly every frame with a clear match: no other candidate can do better.
      if (q.value >= 0.97) break;
    }
  }
  return { found: { box: winner.box, index: winner.index }, wholePicture: false };
}

/**
 * The box shrunk to the element at full resolution: the pixels that differ between the reference frame and the
 * frame that differs most inside the box (the element elsewhere or faded out), within the box and a small margin. The
 * coarse box from the analysis grid can be several pixels too large, which shifts every absolute position.
 */
function tighten(frames: GrayFrames["frames"], picks: number[], w: number, h: number, b: Box, index: number, threshold: number): Box {
  // The emptiest frame: the one that differs most from the reference inside the box.
  const ref = frames[index]!.data;
  let empty = -1;
  let most = -1;
  for (const k of picks) {
    if (k === index) continue;
    const data = frames[k]!.data;
    let sum = 0;
    for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(h, Math.ceil(b.y + b.h)); y += 2) {
      for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(w, Math.ceil(b.x + b.w)); x += 2) sum += Math.abs(ref[y * w + x]! - data[y * w + x]!);
    }
    if (sum > most) {
      most = sum;
      empty = k;
    }
  }
  if (empty < 0) return b;
  const other = frames[empty]!.data;
  const m = 4;
  const x0 = Math.max(0, Math.floor(b.x) - m);
  const y0 = Math.max(0, Math.floor(b.y) - m);
  const x1 = Math.min(w - 1, Math.ceil(b.x + b.w) + m);
  const y1 = Math.min(h - 1, Math.ceil(b.y + b.h) + m);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.abs(ref[y * w + x]! - other[y * w + x]!) <= threshold) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Keep the coarse box when the comparison found too little (the element overlaps itself in both frames).
  if (count < 0.3 * b.w * b.h || maxX - minX + 1 < 0.5 * b.w || maxY - minY + 1 < 0.5 * b.h) return b;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
